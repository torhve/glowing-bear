import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount, type Component } from 'svelte';
import InputBar from '#components/InputBar.svelte';
import { createBuffer, setActiveBuffer, buffers } from '#lib/stores/models.ts';
import { toastStore } from '#lib/toast.ts';
import { clearActiveConnectionProfile, setActiveConnectionProfile } from '#lib/connectionProfile.ts';
import { readDraft, resetConversationDrafts } from '#lib/stores/conversationDrafts.ts';
import type { BufferData } from '#lib/types.ts';

/**
 * Completion over the API transport.
 *
 * Completion is the composer's slowest operation: the API relay answers the
 * request, so the reader has plenty of time to switch conversations while it is
 * in flight. The legacy transport answers locally and is covered in
 * input-bar-send-ownership.test.ts; this file exercises the same ownership guard
 * along the other path, where the delay is real and the candidates come from the
 * relay rather than the local nick list.
 */

const completion = vi.hoisted(() => {
    const waiting: Array<(value: unknown) => void> = [];
    return {
        waiting,
        defer: () => new Promise((resolve) => waiting.push(resolve)),
        settle(value: unknown) {
            const pending = waiting.splice(0);
            for (const resolve of pending) resolve(value);
        },
    };
});

vi.mock('#lib/stores/connectionManager.ts', () => ({
    sendMessage: vi.fn(() => Promise.resolve(true)),
    sendWeeChatCommand: vi.fn(() => Promise.resolve(true)),
    // The API completion path bails out without a session, so the fake has to look
    // live for the code under test to run at all.
    getSession: vi.fn(() => ({ id: 'fake-session' })),
    getActiveTransport: vi.fn(() => 'api'),
}));

vi.mock('#lib/api/api-features.ts', async (importOriginal) => {
    const actual = await importOriginal<typeof import('#lib/api/api-features.ts')>();
    return {
        ...actual,
        // Deferred so a test can switch conversations mid-request and see where
        // the answer actually lands.
        requestCompletion: vi.fn(() => completion.defer()),
    };
});

const RELAY = 'https://relay.example:443';

const components: Record<string, unknown>[] = [];

function render<Props extends Record<string, unknown>>(component: Component<Props>, props: Props) {
    const target = document.createElement('div');
    document.body.appendChild(target);
    components.push(mount(component, { target, props }));
    flushSync();
    return target;
}

interface Conversation {
    id: string;
    fullName: string;
}

/** Add an API-shaped conversation to the live table and switch to it. */
function openConversation(name: string, apiId: number): Conversation {
    const fullName = `irc.libera.#${name}`;
    const buffer: BufferData = createBuffer({
        pointers: [name],
        full_name: fullName,
        short_name: `#${name}`,
        number: 1,
        local_variables: { type: 'channel' },
    });
    // completeViaApi() refuses a buffer the relay never gave an id for.
    buffer.apiBufferId = apiId;
    buffers.update((current) => ({ ...current, [name]: buffer }));
    setActiveBuffer(name);
    flushSync();
    return { id: name, fullName };
}

async function switchTo(id: string): Promise<void> {
    setActiveBuffer(id);
    flushSync();
    await tick();
}

function inputIn(target: HTMLElement): HTMLTextAreaElement {
    const input = target.querySelector<HTMLTextAreaElement>('[data-testid="message-input"]');
    expect(input, 'message input').toBeDefined();
    return input!;
}

function typeInto(target: HTMLElement, text: string): HTMLTextAreaElement {
    const input = inputIn(target);
    input.focus();
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    return input;
}

// jsdom does not populate the deprecated keyCode/which the handler reads.
function pressTab(input: HTMLTextAreaElement): void {
    const e = new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', bubbles: true, cancelable: true });
    Object.defineProperty(e, 'keyCode', { value: 9 });
    Object.defineProperty(e, 'which', { value: 9 });
    input.dispatchEvent(e);
    flushSync();
}

/**
 * A relay answer for the text as it was when Tab was pressed. The shape mirrors
 * what the live 4.10.1 relay returned for a nick completion in the api dossier:
 * `context: "auto"`, `add_space: false`, and the candidate already carrying its
 * configured suffix and trailing space.
 */
function relayAnswer(command: string, candidate: string) {
    const wordStart = command.lastIndexOf(' ');
    return {
        ok: true,
        replaceStart: wordStart + 1,
        replaceEnd: command.length,
        candidates: [candidate],
        addSpace: false,
        context: 'auto',
    };
}

/**
 * Reach the state after the completion's own promise chain has resolved. A bare
 * `tick()` is not enough: the answer is delivered by a promise the component is
 * awaiting, and its continuation lands after Svelte's flush.
 */
async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await tick();
    flushSync();
}

function draftOf(conversationKey: string): string {
    return readDraft({ profileKey: RELAY, conversationKey })?.text ?? '';
}

beforeEach(() => {
    vi.clearAllMocks();
    toastStore.set([]);
    resetConversationDrafts();
    setActiveConnectionProfile('relay.example', 443, '', true);
});

afterEach(async () => {
    completion.settle({ ok: false, replaceStart: 0, replaceEnd: 0, candidates: [], addSpace: false, context: '' });
    for (const component of components.splice(0)) await unmount(component);
    clearActiveConnectionProfile();
    resetConversationDrafts();
    await tick();
});

it('applies an API completion to the conversation it was requested for', async () => {
    const a = openConversation('dev', 41);
    const target = render(InputBar, {});

    const input = typeInto(target, 'ping al');
    pressTab(input);
    completion.settle(relayAnswer('ping al', 'alice: '));
    await settle();

    expect(inputIn(target).value).toBe('ping alice: ');
    expect(draftOf(a.fullName)).toBe('ping alice: ');
});

it('keeps an API completion out of a conversation the reader switched to', async () => {
    const a = openConversation('dev', 41);
    openConversation('random', 42);
    // The composer must start on #dev, the conversation Tab is pressed in.
    await switchTo('dev');
    const target = render(InputBar, {});

    const input = typeInto(target, 'ping al');
    pressTab(input);

    // The relay is still thinking; the reader moves on.
    await switchTo('random');

    completion.settle(relayAnswer('ping al', 'alice: '));
    await settle();

    // The composer belongs to #random now and stays as that conversation has it.
    expect(inputIn(target).value).toBe('');
    // The completion is not lost, it is kept where it was asked for.
    expect(draftOf(a.fullName)).toBe('ping alice: ');
    expect(draftOf('irc.libera.#random')).toBe('');
});

it('does not overwrite text the reader typed while the relay was answering', async () => {
    const a = openConversation('dev', 41);
    const target = render(InputBar, {});

    const input = typeInto(target, 'ping al');
    pressTab(input);
    // The reader keeps typing before the answer arrives.
    typeInto(target, 'ping already fixed');
    completion.settle(relayAnswer('ping al', 'alice: '));
    await settle();

    expect(inputIn(target).value).toBe('ping already fixed');
    expect(draftOf(a.fullName)).toBe('ping already fixed');
});
