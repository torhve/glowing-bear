import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount, type Component } from 'svelte';
import InputBar from '#components/InputBar.svelte';
import { activeBufferId, buffers, createBuffer, setActiveBuffer } from '#lib/stores/models.ts';
import { sendMessage } from '#lib/stores/connectionManager.ts';
import { toastStore } from '#lib/toast.ts';
import { clearActiveConnectionProfile, setActiveConnectionProfile } from '#lib/connectionProfile.ts';
import { readDraft, resetConversationDrafts } from '#lib/stores/conversationDrafts.ts';
import type { BufferData } from '#lib/types.ts';

vi.mock('#lib/stores/connectionManager.ts', () => ({
    sendMessage: vi.fn(() => Promise.resolve(true)),
    sendWeeChatCommand: vi.fn(() => Promise.resolve(true)),
    getSession: vi.fn(() => null),
    getActiveTransport: vi.fn(() => 'api'),
}));

const RELAY_ONE = 'https://relay.example:443';
const RELAY_TWO = 'https://other.example:443';

const components: Record<string, unknown>[] = [];

// Mount the real component and retain its owner so each test tears down its effects.
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
function openConversation(name: string): Conversation {
    const fullName = `irc.libera.#${name}`;
    const buffer: BufferData = createBuffer({
        pointers: [name],
        full_name: fullName,
        short_name: `#${name}`,
        number: 1,
        local_variables: { type: 'channel' },
    });
    buffers.update((current) => ({ ...current, [name]: buffer }));
    setActiveBuffer(name);
    flushSync();
    return { id: name, fullName };
}

/**
 * Switch to a conversation already in the table, through the app's own switch path,
 * and let the composer settle: a restored caret is applied after the flush that
 * writes the restored text, which is a microtask — before paint, but after `flushSync`.
 */
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

// Type exactly as the browser does: focus, set value, fire the input event bind:value listens to.
function typeInto(target: HTMLElement, text: string): HTMLTextAreaElement {
    const input = inputIn(target);
    input.focus();
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    return input;
}

function draftOf(profileKey: string, conversationKey: string): string {
    return readDraft({ profileKey, conversationKey })?.text ?? '';
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(sendMessage).mockResolvedValue(true);
    toastStore.set([]);
    setActiveConnectionProfile('relay.example', 443, '', true);
});

afterEach(async () => {
    for (const component of components.splice(0)) await unmount(component);
    document.body.replaceChildren();
    activeBufferId.set('');
    buffers.set({});
    clearActiveConnectionProfile();
    resetConversationDrafts();
});

it('gives each conversation its own draft', () => {
    const target = render(InputBar, {});
    const first = openConversation('first');
    typeInto(target, 'typed in the first');

    const second = openConversation('second');
    expect(inputIn(target).value).toBe('');

    expect(draftOf(RELAY_ONE, first.fullName)).toBe('typed in the first');
    expect(draftOf(RELAY_ONE, second.fullName)).toBe('');
});

it('restores the draft when the reader returns to a conversation', async () => {
    const target = render(InputBar, {});
    const first = openConversation('first');
    typeInto(target, 'half a sentence');

    openConversation('second');
    expect(inputIn(target).value).toBe('');

    await switchTo(first.id);
    expect(inputIn(target).value).toBe('half a sentence');
});

it('does not hand one conversation text that belongs to another', async () => {
    const target = render(InputBar, {});
    const first = openConversation('first');
    typeInto(target, 'belongs to first');
    const second = openConversation('second');
    typeInto(target, 'belongs to second');

    await switchTo(first.id);
    expect(inputIn(target).value).toBe('belongs to first');

    await switchTo(second.id);
    expect(inputIn(target).value).toBe('belongs to second');
});

it('restores the caret where the reader left it', async () => {
    const target = render(InputBar, {});
    const first = openConversation('first');
    const input = typeInto(target, 'insert here');
    input.setSelectionRange(6, 6);

    openConversation('second');
    expect(inputIn(target).selectionStart).toBe(0);

    await switchTo(first.id);
    const restored = inputIn(target);
    expect(restored.value).toBe('insert here');
    expect(restored.selectionStart).toBe(6);
});

it('keeps a draft across a remount to the same conversation', () => {
    const first = render(InputBar, {});
    openConversation('first');
    typeInto(first, 'a long message I was still typing');

    // A disconnect swaps the chat view for the connection form, unmounting the bar.
    unmount(components.pop()!);
    flushSync();

    const second = render(InputBar, {});
    expect(inputIn(second).value).toBe('a long message I was still typing');
});

it('does not carry a draft into a different relay', () => {
    const target = render(InputBar, {});
    const first = openConversation('first');
    typeInto(target, 'typed on relay one');

    // Same conversation name, different relay.
    clearActiveConnectionProfile();
    setActiveConnectionProfile('other.example', 443, '', true);
    flushSync();

    expect(inputIn(target).value).toBe('');
    expect(draftOf(RELAY_ONE, first.fullName)).toBe('typed on relay one');
    expect(draftOf(RELAY_TWO, first.fullName)).toBe('');
});

it('preserves a whitespace-only draft instead of trimming it away', async () => {
    const target = render(InputBar, {});
    const first = openConversation('first');
    typeInto(target, '   ');

    openConversation('second');
    await switchTo(first.id);

    expect(inputIn(target).value).toBe('   ');
});

it('keeps drafts through a live buffer-table reset', () => {
    const target = render(InputBar, {});
    const first = openConversation('first');
    typeInto(target, 'survives the reset');

    // A reconnect republishes the same conversation under a new runtime id. The
    // conversation name is the owner, so the draft follows it.
    const republished: BufferData = createBuffer({
        pointers: ['fresh'],
        full_name: first.fullName,
        short_name: '#first',
        number: 1,
        local_variables: { type: 'channel' },
    });
    buffers.set({ fresh: republished });
    setActiveBuffer('fresh');
    flushSync();

    expect(inputIn(target).value).toBe('survives the reset');
});
