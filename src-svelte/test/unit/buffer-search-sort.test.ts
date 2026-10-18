import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount, type Component } from 'svelte';
import { get } from 'svelte/store';
import BufferSearchModal from '#components/BufferSearchModal.svelte';
import {
    activeBufferId,
    buffers,
    compareBuffersHotlist,
    createBuffer,
    sortBuffers,
} from '#lib/stores/models.ts';
import { settings, updateSettings } from '#lib/stores/settings.ts';
import { switchBuffer } from '#lib/stores/connectionManager.ts';
import type { BufferData } from '#lib/types.ts';

vi.mock('#lib/stores/connectionManager.ts', () => ({
    switchBuffer: vi.fn(async () => true),
}));

// ---- Fixtures ----

/** A buffer with the counts the two orders read. `pinned` mirrors WeeChat's
 *  `local_variables.pinned`, which is where the app's pinned tier comes from. */
function channel(options: {
    id: string;
    number: number;
    server?: string;
    unread?: number;
    notification?: number;
    pinned?: boolean;
}): BufferData {
    const buffer = createBuffer({
        pointers: [options.id],
        full_name: `irc.${options.server ?? 'test'}.${options.id}`,
        short_name: options.id,
        number: options.number,
        local_variables: {
            type: 'channel',
            server: options.server ?? 'test',
            ...(options.pinned ? { pinned: 'true' } : {}),
        },
    });
    buffer.unread = options.unread ?? 0;
    buffer.notification = options.notification ?? 0;
    return buffer;
}

function rowsOf(target: Element): string[] {
    return Array.from(target.querySelectorAll('.buffer-search-item')).map(
        (row) => row.querySelector('.buffer-search-shortname')?.textContent ?? '',
    );
}

// The highlight class is Tailwind's `!bg-accent`, so a class selector would miss it.
function highlightedIndex(target: Element): string | null {
    for (const row of target.querySelectorAll('.buffer-search-item')) {
        if (row.className.includes('bg-accent')) return row.getAttribute('data-search-index');
    }
    return null;
}

// ---- The comparator both orders share ----

describe('compareBuffersHotlist', () => {
    it('ranks a highlight above plain unread above no activity', () => {
        const plain = channel({ id: '#plain', number: 1 });
        const unread = channel({ id: '#unread', number: 2, unread: 4 });
        const hot = channel({ id: '#hot', number: 3, notification: 1 });
        expect([plain, unread, hot].sort(compareBuffersHotlist).map((b) => b.shortName))
            .toEqual(['#hot', '#unread', '#plain']);
    });

    it('breaks ties inside a tier by WeeChat buffer number', () => {
        const high = channel({ id: '#high', number: 9, notification: 1 });
        const low = channel({ id: '#low', number: 2, notification: 2 });
        const quietHigh = channel({ id: '#quiet-high', number: 8 });
        const quietLow = channel({ id: '#quiet-low', number: 3 });
        expect([high, quietHigh, low, quietLow].sort(compareBuffersHotlist).map((b) => b.shortName))
            .toEqual(['#low', '#high', '#quiet-low', '#quiet-high']);
    });

    it('does not hoist pinned buffers: activity alone decides', () => {
        const pinnedQuiet = channel({ id: '#pinned', number: 1, pinned: true });
        const unpinnedHot = channel({ id: '#hot', number: 7, notification: 3 });
        expect([pinnedQuiet, unpinnedHot].sort(compareBuffersHotlist).map((b) => b.shortName))
            .toEqual(['#hot', '#pinned']);
    });

    it('reads the raw counts, not the sidebar badge', () => {
        // `localUnread` is what inflates a sidebar badge; the hotlist order is the
        // server's, so a buffer whose only unread signal is local stays last.
        const locallyTallied = channel({ id: '#local', number: 1 });
        locallyTallied.localUnread = 40;
        const serverUnread = channel({ id: '#server', number: 2, unread: 1 });
        expect([locallyTallied, serverUnread].sort(compareBuffersHotlist).map((b) => b.shortName))
            .toEqual(['#server', '#local']);
    });
});

describe('buffer order mode', () => {
    it('groups by server before buffer number, exactly as the sidebar does', () => {
        const betaLow = channel({ id: '#beta-low', number: 1, server: 'beta' });
        const alphaHigh = channel({ id: '#alpha-high', number: 9, server: 'alpha' });
        const alphaLow = channel({ id: '#alpha-low', number: 4, server: 'alpha' });
        expect(sortBuffers([betaLow, alphaHigh, alphaLow], true).map((b) => b.shortName))
            .toEqual(['#alpha-low', '#alpha-high', '#beta-low']);
    });

    it('keeps pinned buffers first in that mode', () => {
        const quiet = channel({ id: '#quiet', number: 1 });
        const pinned = channel({ id: '#pinned', number: 8, pinned: true });
        expect(sortBuffers([quiet, pinned], false).map((b) => b.shortName))
            .toEqual(['#pinned', '#quiet']);
    });
});

// ---- The dialog itself ----

const mounted: Record<string, unknown>[] = [];

function render(component: Component<Record<string, unknown>>, props: Record<string, unknown>) {
    const target = document.createElement('div');
    document.body.appendChild(target);
    mounted.push(mount(component, { target, props }));
    flushSync();
    return target;
}

function publish(values: BufferData[]) {
    buffers.set(Object.fromEntries(values.map((value) => [value.id, value])));
    flushSync();
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // jsdom lacks these; neither behavior is under test here.
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    Object.defineProperty(HTMLElement.prototype, 'hidePopover', { configurable: true, value: vi.fn() });
    activeBufferId.set('');
    publish([]);
    updateSettings({ bufferSearchSort: 'number', orderbyserver: false });
});

afterEach(async () => {
    for (const component of mounted.splice(0)) await unmount(component);
    document.body.replaceChildren();
    publish([]);
    updateSettings({ bufferSearchSort: 'number', orderbyserver: true });
});

it('defaults to the buffer order: pinned first, then WeeChat buffer number', () => {
    const values = [
        channel({ id: '#nine', number: 9 }),
        channel({ id: '#pinned', number: 5, pinned: true }),
        channel({ id: '#two', number: 2, unread: 7 }),
    ];
    publish(values);
    const target = render(BufferSearchModal, {});
    expect(rowsOf(target)).toEqual(['#pinned', '#two', '#nine']);
});

it('follows the sidebar grouping in buffer order mode', () => {
    updateSettings({ orderbyserver: true });
    const values = [
        channel({ id: '#beta', number: 1, server: 'beta' }),
        channel({ id: '#alpha-high', number: 9, server: 'alpha' }),
        channel({ id: '#alpha-low', number: 4, server: 'alpha' }),
    ];
    publish(values);
    const target = render(BufferSearchModal, {});
    expect(rowsOf(target)).toEqual(['#alpha-low', '#alpha-high', '#beta']);
});

it('falls back to buffer order when stored settings predate the option', () => {
    // Exactly the shape an old `gb-settings` blob produces: the key is absent,
    // not null, and the merge leaves nothing behind it.
    const legacy = { ...get(settings) };
    delete legacy.bufferSearchSort;
    settings.set(legacy);

    const values = [
        channel({ id: '#one', number: 1 }),
        channel({ id: '#hot', number: 8, notification: 3 }),
    ];
    publish(values);
    const target = render(BufferSearchModal, {});
    // Buffer order ignores the highlight entirely: 1 before 8.
    expect(rowsOf(target)).toEqual(['#one', '#hot']);
});

it('moves the unread buffer above a lower-numbered one in unread-first mode', () => {
    updateSettings({ bufferSearchSort: 'unread' });
    const values = [
        channel({ id: '#one', number: 1 }),
        channel({ id: '#two', number: 2, unread: 3 }),
        channel({ id: '#three', number: 3, notification: 1 }),
        channel({ id: '#pinned', number: 4, pinned: true }),
    ];
    publish(values);
    const target = render(BufferSearchModal, {});
    // Highlight, then unread, then the rest by number — pinned included in "the rest".
    expect(rowsOf(target)).toEqual(['#three', '#two', '#one', '#pinned']);
});

it('switches order from the control and stores the choice', () => {
    const values = [
        channel({ id: '#one', number: 1 }),
        channel({ id: '#hot', number: 8, notification: 2 }),
    ];
    publish(values);
    const target = render(BufferSearchModal, {});
    expect(rowsOf(target)).toEqual(['#one', '#hot']);

    const unreadButton = target.querySelector<HTMLButtonElement>('[data-testid="buffer-search-sort-unread"]')!;
    unreadButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    flushSync();

    expect(rowsOf(target)).toEqual(['#hot', '#one']);
    expect(get(settings).bufferSearchSort).toBe('unread');
    expect(unreadButton.getAttribute('aria-pressed')).toBe('true');
    expect(target.querySelector<HTMLButtonElement>('[data-testid="buffer-search-sort-number"]')!
        .getAttribute('aria-pressed')).toBe('false');
});

it('keeps the stored mode across a reopened dialog', async () => {
    updateSettings({ bufferSearchSort: 'unread' });
    const values = [
        channel({ id: '#one', number: 1 }),
        channel({ id: '#hot', number: 8, notification: 2 }),
    ];
    publish(values);
    const first = render(BufferSearchModal, {});
    const closed = first.querySelector('#buffer-search-modal')!;
    closed.dispatchEvent(Object.assign(new Event('beforetoggle'), { newState: 'open', oldState: 'closed' }));
    closed.dispatchEvent(Object.assign(new Event('toggle'), { newState: 'open', oldState: 'closed' }));
    flushSync();
    expect(rowsOf(first)).toEqual(['#hot', '#one']);

    // A new mount is what a reconnect or a page reload produces.
    await unmount(mounted.pop()!);
    const second = render(BufferSearchModal, {});
    expect(rowsOf(second)).toEqual(['#hot', '#one']);
});

it('restarts the highlight when the order changes under it', () => {
    const values = [
        channel({ id: '#one', number: 1 }),
        channel({ id: '#two', number: 2 }),
        channel({ id: '#hot', number: 3, notification: 1 }),
    ];
    publish(values);
    const target = render(BufferSearchModal, {});
    const input = target.querySelector<HTMLInputElement>('input[placeholder="Search buffers..."]')!;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    flushSync();
    expect(highlightedIndex(target)).toBe('1');

    target.querySelector<HTMLButtonElement>('[data-testid="buffer-search-sort-unread"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    flushSync();
    expect(highlightedIndex(target)).toBe('0');
});

it('ranks a merged group by its most active member', () => {
    // Two buffers share WeeChat's number — the case the dialog groups into one row.
    const values = [
        channel({ id: '#quiet', number: 4, server: 'alpha' }),
        channel({ id: '#hot', number: 4, server: 'beta', notification: 2 }),
        channel({ id: '#lower', number: 1 }),
    ];
    publish(values);
    updateSettings({ bufferSearchSort: 'unread' });
    const target = render(BufferSearchModal, {});
    const rows = Array.from(target.querySelectorAll('.buffer-search-item'));
    expect(rows).toHaveLength(2);
    expect(rows[0]?.querySelector('.buffer-search-shortname')?.textContent).toBe('#hot, #quiet');
    expect(rows[1]?.querySelector('.buffer-search-shortname')?.textContent).toBe('#lower');
});

it('still switches to the row it shows first', async () => {
    updateSettings({ bufferSearchSort: 'unread' });
    const values = [
        channel({ id: '#one', number: 1 }),
        channel({ id: '#hot', number: 8, notification: 2 }),
    ];
    publish(values);
    const target = render(BufferSearchModal, {});
    const input = target.querySelector<HTMLInputElement>('input[placeholder="Search buffers..."]')!;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.advanceTimersByTimeAsync(100);
    expect(switchBuffer).toHaveBeenCalledWith(values[1]!.id);
});
