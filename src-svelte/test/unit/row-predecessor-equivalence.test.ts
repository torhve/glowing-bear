/**
 * Which row counts as whose predecessor, and what that decides on screen.
 *
 * A row hides a repeated time and a repeated nick when the line before it shares
 * them. That is the whole visible effect of the predecessor relationship, and it is
 * decided by an index lookup into the buffer's lines — so it is also the thing a
 * change to how a row learns its predecessor would break first.
 *
 * Every expectation below is computed independently, from the array alone, with
 * `index > 0 ? lines[index - 1] : null`, and compared against what the component
 * actually rendered. The scenarios are the ones a capped buffer lives through: a
 * tail append, a front trim that shifts every surviving index, the row that
 * becomes the first row when the trim reaches it, and a re-publication that changes
 * nothing.
 */

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount, type Component } from 'svelte';
import ChatView from '#components/ChatView.svelte';
import { activeBufferId, buffers, createBuffer, createBufferLine } from '#lib/stores/models.ts';
import type { BufferData, BufferLine } from '#lib/types.ts';

vi.mock('#lib/stores/connectionManager.ts', () => ({
    fetchMoreLines: vi.fn(),
    closeBufferOnWeeChat: vi.fn(),
    pinBuffer: vi.fn(),
    unpinBuffer: vi.fn(),
}));

const components: Record<string, unknown>[] = [];

/** Mount the real ChatView so the real each block and the real row run. */
function render<Props extends Record<string, unknown>>(component: Component<Props>, props: Props) {
    const target = document.createElement('div');
    document.body.appendChild(target);
    components.push(mount(component, { target, props }));
    flushSync();
    return target;
}

const DATE = 1_700_000_000; // one day, one local time: every line shares shortTime

/** A channel line with a chosen nick; ids keep the keyed each block stable. */
function line(nick: string, text: string, id: number): BufferLine {
    return createBufferLine({
        buffer: 'irc.server.#chan',
        date: DATE,
        prefix: nick,
        message: text,
        tags_array: ['irc_privmsg'],
        displayed: 1,
        highlight: 0,
        id,
    });
}

/**
 * What the old code would have decided, computed from the array alone.
 *
 * `isDateChange` is false for every line here (plain nicks, plain text), which is
 * the case the predecessor actually decides.
 */
function expectedFlags(lines: BufferLine[]): { time: boolean[]; prefix: boolean[] } {
    const time: boolean[] = [];
    const prefix: boolean[] = [];
    lines.forEach((current, index) => {
        const previous = index > 0 ? lines[index - 1] : null;
        time.push(!!previous && current.shortTime === previous.shortTime);
        prefix.push(!!previous && current.prefixtext === previous.prefixtext);
    });
    return { time, prefix };
}

/** What the component rendered, row by row, in DOM order. */
function renderedFlags(target: HTMLElement): { time: boolean[]; prefix: boolean[] } {
    // ChatView's own chrome rows are `bufferline` too but carry no predecessor.
    const rows = Array.from(target.querySelectorAll(
        'tr.bufferline:not(.date-change-row):not(.fetchmore-row):not(.history-failed-row)',
    ));
    return {
        time: rows.map((row) => !!row.querySelector('span.compact-time.repeated-time')),
        prefix: rows.map((row) => !!row.querySelector('span.compact-prefix.repeated-prefix')),
    };
}

function publish(target: HTMLElement, lines: BufferLine[]): void {
    const buffer: BufferData = {
        ...createBuffer({
            pointers: ['0x1'],
            full_name: 'irc.server.#chan',
            short_name: '#chan',
            local_variables: { type: 'channel' },
        }),
        lines,
        lastSeen: -1,
        readBoundaryId: undefined,
        readBoundaryKnown: true,
    };
    activeBufferId.set(buffer.id);
    buffers.set({ [buffer.id]: buffer });
    flushSync();
    void target;
}

const initial = [
    line('alice', 'one', 1),
    line('alice', 'two', 2),
    line('alice', 'three', 3),
    line('bob', 'four', 4),
    line('bob', 'five', 5),
    line('alice', 'six', 6),
];

let target: HTMLElement;

beforeEach(() => {
    vi.useFakeTimers();
    target = render(ChatView, {});
});

afterEach(async () => {
    for (const component of components.splice(0)) await unmount(component);
    document.body.replaceChildren();
    activeBufferId.set('');
    buffers.set({});
    vi.clearAllTimers();
    vi.useRealTimers();
});

it('renders the same repeated time and nick as the index lookup did', () => {
    publish(target, initial);
    expect(renderedFlags(target)).toEqual(expectedFlags(initial));
});

it('keeps those flags identical across a tail append that clones the array', () => {
    publish(target, initial);
    const before = renderedFlags(target);
    const appended = [...initial, line('alice', 'seven', 7)];
    publish(target, appended);
    // The old path re-ran every row here; the new path must still agree with the
    // old path's answer, row for row.
    expect(renderedFlags(target)).toEqual(expectedFlags(appended));
    // Rows that were already rendered keep the flags they had.
    expect(renderedFlags(target).time.slice(0, before.time.length)).toEqual(before.time);
    expect(renderedFlags(target).prefix.slice(0, before.prefix.length)).toEqual(before.prefix);
});

it('re-decides exactly the rows a front trim moves, and no others', () => {
    publish(target, initial);
    // A trim of the first two lines shifts every surviving index by two. Under the
    // old props that dirtied all six rows; the predecessor of each survivor is the
    // same object it already had, except for the row that becomes first.
    const trimmed = initial.slice(2);
    publish(target, trimmed);
    expect(renderedFlags(target)).toEqual(expectedFlags(trimmed));
    // The row that is now first has no predecessor, so its nick is shown again —
    // the same thing the old `index === 0` produced.
    expect(renderedFlags(target).prefix[0]).toBe(false);
});

it('publishing an unchanged buffer again does not change any row', () => {
    publish(target, initial);
    const before = renderedFlags(target);
    publish(target, [...initial]);
    expect(renderedFlags(target)).toEqual(before);
});
