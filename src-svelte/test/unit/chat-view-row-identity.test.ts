import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount, type Component } from 'svelte';
import ChatView from '#components/ChatView.svelte';
import { activeBufferId, buffers, createBuffer, createBufferLine } from '#lib/stores/models.ts';
import { updateSettings } from '#lib/stores/settings.ts';
import type { BufferData, BufferLine } from '#lib/types.ts';

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

// Lines with stable WeeChat-style ids and image URLs that BufferLineRow embeds.
function line(buffer: string, id: number, text: string): BufferLine {
    return createBufferLine({
        buffer, date: 1_700_000_000 + id, prefix: 'nick', message: text,
        tags_array: ['irc_privmsg'], displayed: 1, highlight: 0, id,
    });
}

function showBuffer(buf: BufferData) {
    activeBufferId.set(buf.id);
    buffers.set({ [buf.id]: buf });
    flushSync();
}

// Let promise continuations and nested animation frames finish without wall-clock waits.
async function settleFrames() {
    await vi.advanceTimersByTimeAsync(100);
    flushSync();
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    updateSettings({ noembed: false });
});

afterEach(async () => {
    for (const component of components.splice(0)) await unmount(component);
    document.body.replaceChildren();
    activeBufferId.set('');
    buffers.set({});
    vi.clearAllTimers();
    vi.useRealTimers();
});

it('keeps embedded media with its message when the line cap trims the buffer front', async () => {
    const id = 'channel-a';
    const first = line(id, 1, 'first line https://example.test/img-a.png');
    const second = line(id, 2, 'second line https://example.test/img-b.png');
    const third = line(id, 3, 'third line plain');
    const buf: BufferData = {
        ...createBuffer({ pointers: [id], full_name: `irc.${id}`, short_name: id, number: 1,
            local_variables: { type: 'channel' } }),
        requestedLines: 100,
        lines: [first, second, third],
    };
    showBuffer(buf);
    const target = render(ChatView, {});
    await settleFrames();

    const img = (url: string) =>
        [...target.querySelectorAll<HTMLImageElement>('img.embed')].find(el => el.src.endsWith(url));
    expect(img('img-a.png'), 'first line embed visible').toBeDefined();

    // Simulate the handlers' capped update: trim one line off the front and
    // append a new one, with fresh clones of the surviving lines.
    const next: BufferData = {
        ...buf,
        lines: [
            line(id, 2, 'second line https://example.test/img-b.png'),
            line(id, 3, 'third line plain'),
            line(id, 4, 'fourth line plain'),
        ],
    };
    showBuffer(next);
    await settleFrames();

    // The trimmed line's embed must be gone...
    expect(img('img-a.png'), 'trimmed line embed removed').toBeUndefined();
    // ...and the surviving line's embed must stay attached to that line's row.
    const imgB = img('img-b.png');
    expect(imgB, 'second line embed kept').toBeDefined();
    expect(imgB!.closest('tr')?.textContent).toContain('second line');
});
