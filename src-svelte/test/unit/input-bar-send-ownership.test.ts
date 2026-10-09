import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount, type Component } from 'svelte';
import InputBar from '#components/InputBar.svelte';
import { activeBufferId, buffers, createBuffer, setActiveBuffer } from '#lib/stores/models.ts';
import { toastStore } from '#lib/toast.ts';
import { clearActiveConnectionProfile, setActiveConnectionProfile } from '#lib/connectionProfile.ts';
import { readDraft, resetConversationDrafts } from '#lib/stores/conversationDrafts.ts';
import type { BufferData } from '#lib/types.ts';

// Delivery is deferred so a test can switch conversations while a send is in flight
// and see where the result actually landed.
const delivery = vi.hoisted(() => {
    const waiting: Array<(value: boolean) => void> = [];
    return {
        waiting,
        defer: () => new Promise<boolean>((resolve) => waiting.push(resolve)),
        settle(value: boolean) {
            const pending = waiting.splice(0);
            for (const resolve of pending) resolve(value);
        },
    };
});

vi.mock('#lib/stores/connectionManager.ts', () => ({
    sendMessage: vi.fn(() => delivery.defer()),
    sendWeeChatCommand: vi.fn(() => Promise.resolve(true)),
    getSession: vi.fn(() => null),
    // Legacy completion is the client-side matcher, so a completion can be exercised
    // without a relay session.
    getActiveTransport: vi.fn(() => 'legacy'),
}));

const RELAY = 'https://relay.example:443';
const HISTORY_KEY = 'gb_input_history';

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

/** Add a conversation to the live table and switch to it the way the app does. */
function openConversation(name: string, nicks: string[] = []): Conversation {
    const fullName = `irc.libera.#${name}`;
    const buffer: BufferData = createBuffer({
        pointers: [name],
        full_name: fullName,
        short_name: `#${name}`,
        number: 1,
        local_variables: { type: 'channel' },
    });
    buffer.nicklist = {
        '000': {
            group: '000',
            nicks: nicks.map((name, index) => ({
                name,
                visible: 1,
                sortingKey: name.toLowerCase(),
                prefix: '',
                prefixColor: '',
                color: 0,
                active: 1,
                spokeAt: nicks.length - index,
            })),
        },
    };
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
function pressKey(input: HTMLTextAreaElement, key: string, keyCode: number): void {
    const e = new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true });
    Object.defineProperty(e, 'keyCode', { value: keyCode });
    Object.defineProperty(e, 'which', { value: keyCode });
    input.dispatchEvent(e);
    flushSync();
}

/** Press Enter without waiting: the send is still in flight afterwards. */
function pressEnterWithoutWaiting(input: HTMLTextAreaElement): void {
    pressKey(input, 'Enter', 13);
}

function sentLines(bufferId: string): string[] {
    const raw = localStorage.getItem(HISTORY_KEY);
    const parsed: Record<string, { lines: string[] }> = raw ? JSON.parse(raw) : {};
    return parsed[bufferId]?.lines ?? [];
}

function draftOf(conversationKey: string): string {
    return readDraft({ profileKey: RELAY, conversationKey })?.text ?? '';
}

beforeEach(() => {
    vi.clearAllMocks();
    toastStore.set([]);
    localStorage.removeItem(HISTORY_KEY);
    setActiveConnectionProfile('relay.example', 443, '', true);
});

afterEach(async () => {
    delivery.settle(true);
    for (const component of components.splice(0)) await unmount(component);
    document.body.replaceChildren();
    activeBufferId.set('');
    buffers.set({});
    localStorage.removeItem(HISTORY_KEY);
    clearActiveConnectionProfile();
    resetConversationDrafts();
});

it('records history in the conversation the send was typed in', async () => {
    const target = render(InputBar, {});
    const first = openConversation('first');

    typeInto(target, 'said in first');
    pressEnterWithoutWaiting(inputIn(target));

    // The reader moves on before the socket answers.
    const second = openConversation('second');
    delivery.settle(true);
    await tick();
    flushSync();

    expect(sentLines(first.id)).toEqual(['said in first']);
    expect(sentLines(second.id)).toEqual([]);
});

it('keeps text typed while the socket was answering', async () => {
    const target = render(InputBar, {});
    openConversation('first');

    typeInto(target, 'the message I sent');
    pressEnterWithoutWaiting(inputIn(target));

    // A keystroke during delivery is the reader's, not the send's to erase.
    const input = inputIn(target);
    input.value = 'what I typed meanwhile';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();

    delivery.settle(true);
    await tick();
    flushSync();

    expect(inputIn(target).value).toBe('what I typed meanwhile');
});

it('returns a refused send to the conversation it was typed in', async () => {
    const target = render(InputBar, {});
    const first = openConversation('first');

    typeInto(target, 'a line that failed');
    pressEnterWithoutWaiting(inputIn(target));

    // The reader moves on before the socket answers.
    const second = openConversation('second');
    delivery.settle(false);
    await tick();
    flushSync();

    // The failed line does not appear in the conversation the reader moved to...
    expect(inputIn(target).value).toBe('');
    expect(sentLines(second.id)).toEqual([]);
    // ...and it is not lost either: it stays with its own conversation.
    expect(draftOf(first.fullName)).toBe('a line that failed');
});

it('applies a completion that nothing has overtaken', async () => {
    const target = render(InputBar, {});
    openConversation('first', ['alice', 'bob']);

    const input = typeInto(target, 'ali');
    pressKey(input, 'Tab', 9);
    await tick();
    flushSync();

    expect(inputIn(target).value).toBe('alice: ');
});

it('discards a completion that a newer edit has overtaken', async () => {
    const target = render(InputBar, {});
    openConversation('first', ['alice', 'bob']);

    const input = typeInto(target, 'ali');
    pressKey(input, 'Tab', 9);

    // The reader keeps typing while the completion is being computed.
    input.value = 'ali and what I actually meant';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();

    await tick();
    flushSync();

    expect(inputIn(target).value).toBe('ali and what I actually meant');
    expect(draftOf('irc.libera.#first')).toBe('ali and what I actually meant');
});

it('does not let a completion land in a conversation the reader switched to', async () => {
    const target = render(InputBar, {});
    const first = openConversation('first', ['alice', 'bob']);

    const input = typeInto(target, 'ali');
    pressKey(input, 'Tab', 9);

    // The reader switches conversations while the completion is being computed.
    openConversation('second', ['carol']);
    await tick();
    flushSync();

    // The new conversation's composer is untouched...
    expect(inputIn(target).value).toBe('');
    // ...and the completion belongs to the conversation it was requested in.
    expect(draftOf(first.fullName)).toBe('alice: ');
});
