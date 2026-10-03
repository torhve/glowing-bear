import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount, type Component } from 'svelte';
import ChatView from '#components/ChatView.svelte';
import { activeBufferId, buffers, createBuffer, createBufferLine } from '#lib/stores/models.ts';
import { fetchMoreLines } from '#lib/stores/connectionManager.ts';
import type { BufferData } from '#lib/types.ts';

vi.mock('#lib/stores/connectionManager.ts', () => ({
    fetchMoreLines: vi.fn(),
    closeBufferOnWeeChat: vi.fn(),
    pinBuffer: vi.fn(),
    unpinBuffer: vi.fn(),
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

// Find buttons by their visible label rather than depending on component internals.
function button(target: HTMLElement, label: string) {
    const match = [...target.querySelectorAll('button')].find(el => el.textContent?.trim() === label);
    expect(match, `button labelled "${label}"`).toBeDefined();
    return match!;
}

// Build realistic buffers without needing an external WeeChat relay.
function channel(id: string, number: number, lineCount = 0): BufferData {
    return {
        ...createBuffer({
            pointers: [id], full_name: `irc.${id}`, short_name: id, number,
            local_variables: { type: 'channel' },
        }),
        requestedLines: 100,
        lines: Array.from({ length: lineCount }, (_, i) => createBufferLine({
            buffer: id, date: 1_700_000_000 + i, prefix: 'nick', message: `${id} message ${i}`,
            tags_array: ['irc_privmsg'], displayed: 1, highlight: 0,
        })),
    };
}

// Publish a buffer switch just as the model does, including its buffer-store notification.
function showBuffer(id: string, values: BufferData[]) {
    activeBufferId.set(id);
    buffers.set(Object.fromEntries(values.map(value => [value.id, value])));
    flushSync();
}

// jsdom has no layout; provide viewport dimensions while exercising the real scroll handler.
function viewport(el: HTMLElement, height: number, top: number) {
    Object.defineProperties(el, {
        scrollHeight: { configurable: true, value: height },
        clientHeight: { configurable: true, value: 100 },
    });
    el.scrollTop = top;
}

// Let promise continuations and nested animation frames finish without wall-clock waits.
async function settleFrames() {
    await vi.advanceTimersByTimeAsync(100);
    flushSync();
}

// Hold a history response until the test explicitly releases it.
function deferHistory() {
    let finish!: () => void;
    const response = new Promise<void>(resolve => { finish = resolve; });
    vi.mocked(fetchMoreLines).mockReturnValueOnce(response);
    return finish;
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchMoreLines).mockReset();
    vi.useFakeTimers();
    // These browser APIs are absent from jsdom; their behavior is not under test here.
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    Object.defineProperty(HTMLElement.prototype, 'hidePopover', { configurable: true, value: vi.fn() });
    showBuffer('', []);
});

afterEach(async () => {
    for (const component of components.splice(0)) await unmount(component);
    document.body.replaceChildren();
    showBuffer('', []);
    vi.clearAllTimers();
    vi.useRealTimers();
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
    Reflect.deleteProperty(HTMLElement.prototype, 'hidePopover');
});

it('does not move the new buffer when history from the previous buffer finishes loading', async () => {
    const finishHistory = deferHistory();
    const a = channel('channel-a', 1, 40);
    const b = channel('channel-b', 2, 40);
    showBuffer(a.id, [a, b]);
    const target = render(ChatView, {});
    const chat = target.querySelector<HTMLElement>('[data-testid="chat-messages"]')!;
    viewport(chat, 1000, 900);
    await settleFrames();

    chat.scrollTop = 0;
    chat.dispatchEvent(new Event('scroll'));
    flushSync();
    expect(fetchMoreLines).toHaveBeenCalledTimes(1);

    showBuffer(b.id, [a, b]);
    viewport(chat, 2000, 1900);
    await settleFrames();
    chat.scrollTop = 500;
    chat.dispatchEvent(new Event('scroll'));
    flushSync();
    expect(target.textContent).toContain('channel-b message');

    finishHistory();
    await settleFrames();
    expect(chat.scrollTop).toBe(500);

    // Loading history in the same view must still preserve the reading position.
    const finishCurrent = deferHistory();
    chat.scrollTop = 0;
    chat.dispatchEvent(new Event('scroll'));
    flushSync();
    viewport(chat, 2500, 0);
    finishCurrent();
    await settleFrames();
    expect(chat.scrollTop).toBe(500);

    // Returning to the same buffer is a new visit: its old request is still stale.
    const finishOldVisit = deferHistory();
    chat.scrollTop = 0;
    chat.dispatchEvent(new Event('scroll'));
    flushSync();
    showBuffer(a.id, [a, b]);
    await settleFrames();
    showBuffer(b.id, [a, b]);
    await settleFrames();
    chat.scrollTop = 500;
    const finishNewVisit = deferHistory();
    button(target, 'Fetch more lines').click();
    flushSync();
    expect(fetchMoreLines).toHaveBeenCalledTimes(4);
    finishOldVisit();
    await settleFrames();
    expect(chat.scrollTop).toBe(500);
    button(target, 'Fetch more lines').click();
    expect(fetchMoreLines).toHaveBeenCalledTimes(4); // old completion must not unlock the new request
    finishNewVisit();
    await settleFrames();
    expect(chat.scrollTop).toBe(500);

    // Disconnect/unmount with both a request and buffer-switch frames outstanding.
    const finishAfterUnmount = deferHistory();
    button(target, 'Fetch more lines').click();
    flushSync();
    showBuffer(a.id, [a, b]);
    await unmount(components.pop()!);
    finishAfterUnmount();
    await settleFrames();
    expect(target.querySelector('[data-testid="chat-messages"]')).toBeNull();
    expect(chat.scrollTop).toBe(500);
});
