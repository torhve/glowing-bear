import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount, type Component } from 'svelte';
import { get } from 'svelte/store';
import InputBar from '#components/InputBar.svelte';
import { activeBufferId, buffers, createBuffer } from '#lib/stores/models.ts';
import { sendMessage } from '#lib/stores/connectionManager.ts';
import { toastStore } from '#lib/toast.ts';
import { writeInputDraft } from '#lib/stores/inputDraft.ts';
import type { BufferData } from '#lib/types.ts';

vi.mock('#lib/stores/connectionManager.ts', () => ({
    sendMessage: vi.fn(() => Promise.resolve(true)),
    sendWeeChatCommand: vi.fn(() => Promise.resolve(true)),
    getSession: vi.fn(() => null),
}));

const components: Record<string, unknown>[] = [];

// Mount the real component and retain its owner so each test tears down its effects.
function render<Props extends Record<string, unknown>>(component: Component<Props>, props: Props) {
    const target = document.createElement('div');
    document.body.appendChild(target);
    components.push(mount(component, { target, props }));
    flushSync();
    return target;
}

// Each test gets its own buffer so per-buffer input history never bleeds across tests.
let bufferCounter = 0;
function openBuffer(): string {
    const id = `buf${++bufferCounter}`;
    const buffer: BufferData = createBuffer({
        pointers: [id],
        full_name: `irc.libera.#${id}`,
        short_name: `#${id}`,
        number: bufferCounter,
        local_variables: { type: 'channel' },
    });
    activeBufferId.set(id);
    buffers.set({ [id]: buffer });
    flushSync();
    return id;
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

// jsdom does not populate the deprecated keyCode/which the handler reads.
function pressKey(input: HTMLTextAreaElement, key: string, keyCode: number) {
    const e = new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true });
    Object.defineProperty(e, 'keyCode', { value: keyCode });
    Object.defineProperty(e, 'which', { value: keyCode });
    input.dispatchEvent(e);
    flushSync();
}

async function pressEnter(input: HTMLTextAreaElement) {
    pressKey(input, 'Enter', 13);
    // handleSend is async (Relay API delivery): let its awaits settle.
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
}

function pressArrowUp(input: HTMLTextAreaElement) {
    pressKey(input, 'ArrowUp', 38);
}

// Recall whatever the component would offer through its own history UI, without reading internals.
function recallHistory(target: HTMLElement): string {
    const input = inputIn(target);
    input.focus();
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    pressArrowUp(input);
    return input.value;
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(sendMessage).mockResolvedValue(true);
    toastStore.set([]);
    // The draft is module-level, so reset it to keep tests order-independent.
    writeInputDraft('');
});

afterEach(async () => {
    for (const component of components.splice(0)) await unmount(component);
    document.body.replaceChildren();
    activeBufferId.set('');
    buffers.set({});
});

it('keeps a half-typed message when the input bar is torn down and rebuilt by a reconnect', () => {
    openBuffer();
    const first = render(InputBar, {});
    typeInto(first, 'a long message I was still typing');

    // A disconnect swaps the chat view for the connection form, unmounting the input bar.
    unmount(components.pop()!);
    flushSync();

    const second = render(InputBar, {});
    expect(inputIn(second).value).toBe('a long message I was still typing');
});

it('keeps the text in the input when the send fails', async () => {
    openBuffer();
    vi.mocked(sendMessage).mockResolvedValue(false);

    const target = render(InputBar, {});
    const input = typeInto(target, 'text that cannot be sent');
    await pressEnter(input);

    expect(inputIn(target).value).toBe('text that cannot be sent');
});

it('does not offer a failed message back from input history', async () => {
    openBuffer();
    vi.mocked(sendMessage).mockResolvedValue(false);

    const target = render(InputBar, {});
    const input = typeInto(target, 'a line that was never sent');
    await pressEnter(input);

    expect(recallHistory(target)).not.toBe('a line that was never sent');
});

it('warns the user when a message could not be sent', async () => {
    openBuffer();
    vi.mocked(sendMessage).mockResolvedValue(false);

    const target = render(InputBar, {});
    const input = typeInto(target, 'undeliverable message');
    await pressEnter(input);

    const warnings = get(toastStore).filter((toast) => toast.type === 'warning');
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.map((toast) => toast.message).join(' ')).toMatch(/could not be sent/i);
});

it('keeps only the lines that failed when a multi-line send partially fails', async () => {
    openBuffer();
    vi.mocked(sendMessage).mockImplementation(async (line: string) => line !== 'bad line');

    const target = render(InputBar, {});
    const input = typeInto(target, 'good line\nbad line');
    await pressEnter(input);

    expect(inputIn(target).value).toBe('bad line');
    expect(recallHistory(target)).toBe('good line');
});

it('clears the input and records history when the send succeeds', async () => {
    openBuffer();

    const target = render(InputBar, {});
    const input = typeInto(target, 'a message that was sent');
    await pressEnter(input);

    expect(inputIn(target).value).toBe('');
    expect(recallHistory(target)).toBe('a message that was sent');
});

it('does not resurrect a draft that was already sent successfully', async () => {
    openBuffer();

    const first = render(InputBar, {});
    const input = typeInto(first, 'sent before disconnect');
    await pressEnter(input);
    expect(inputIn(first).value).toBe('');

    unmount(components.pop()!);
    flushSync();

    const second = render(InputBar, {});
    expect(inputIn(second).value).toBe('');
});
