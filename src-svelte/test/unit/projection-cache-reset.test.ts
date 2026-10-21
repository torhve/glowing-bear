/**
 * The sidebar row memo is bounded by the buffers that exist.
 *
 * `bufferProjections` memoises one published `BufferPresentation` per buffer id, so
 * an unchanged buffer — or a clone of it, which is what a hotlist poll produces —
 * republishes the same row object instead of re-rendering the sidebar. Nothing used
 * to remove an entry, so the memo kept a row for every buffer id ever seen while the
 * app ran: across every reconnect, every `/buffer close`, every part.
 *
 * The projection now prunes to the buffer map it is reading. Two things have to hold
 * at once, and they pull against each other: an entry must survive while its buffer
 * is present (that is the memo's whole purpose), and it must go when the buffer is
 * gone. A memo that cleared on every projection would pass the second and fail the
 * first, and would repaint the sidebar on every hotlist poll.
 */
import { beforeEach, expect, it } from 'vitest';
import { get } from 'svelte/store';
import { activeBufferId, buffers, createBuffer } from '#lib/stores/models.ts';
import { memoisedRowCount, sidebarOrder, sidebarRows } from '#lib/stores/bufferProjections.ts';
import { resetAppState } from '#lib/stores/connectionLifecycle.ts';
import type { BufferData } from '#lib/types.ts';

const KEY = '1791000000000901';

/** Shared on purpose: `sameRow` compares `localVariables` by reference, so a clone
 *  that keeps it is the clone a reducer produces. Fresh objects every time would make
 *  each row look changed and hide the memo entirely. */
const LOCALS = { type: 'channel', server: 'gbtest', plugin: 'irc' };

function channelBuffer(id: string, shortName: string, number: number): BufferData {
    return createBuffer({
        pointers: [id],
        full_name: `irc.gbtest.${shortName}`,
        short_name: shortName,
        number,
        local_variables: LOCALS,
    });
}

beforeEach(() => {
    buffers.set({});
    activeBufferId.set('');
    get(sidebarRows);
});

it('drops the rows of buffers the wipe removed', () => {
    const map: Record<string, BufferData> = {};
    for (let i = 0; i < 40; i++) {
        const id = `0x${1000 + i}`;
        map[id] = channelBuffer(id, `#c${i}`, i);
    }
    buffers.set(map);

    expect(get(sidebarRows), 'every buffer has a row').toHaveLength(40);
    expect(memoisedRowCount(), 'one memoised row per id').toBe(40);

    resetAppState();

    // The sidebar re-projects against the empty map — which is what a subscribed
    // component does the moment the wipe publishes — and that is where the memo is
    // bounded.
    expect(get(sidebarRows), 'the wiped session renders nothing').toHaveLength(0);
    expect(memoisedRowCount(), 'rows for buffers that no longer exist are still memoised').toBe(0);
});

it('drops a row when one buffer goes away, keeping the rest', () => {
    buffers.set({
        [KEY]: channelBuffer(KEY, '#closing', 1),
        '0x2': channelBuffer('0x2', '#staying', 2),
    });
    expect(get(sidebarRows), 'two rows').toHaveLength(2);
    expect(memoisedRowCount()).toBe(2);

    // `/buffer close` removes one entry from the map; the other must keep its row,
    // or the memo is not a memo.
    buffers.set({ '0x2': get(buffers)['0x2'] });
    expect(get(sidebarRows), 'one row left').toHaveLength(1);
    expect(memoisedRowCount(), 'the closed buffer still holds a memoised row').toBe(1);
});

it('reuses a row when a clone changed nothing visible', () => {
    buffers.set({ [KEY]: channelBuffer(KEY, '#glowing-bear', 1) });
    const first = get(sidebarRows)[0];
    expect(first, 'the sidebar has a row').toBeDefined();

    // A hotlist poll clones every background buffer: a new buffer object, identical
    // values, `localVariables` carried through. That is the case the memo exists for.
    buffers.set({ [KEY]: { ...get(buffers)[KEY] } });
    const second = get(sidebarRows)[0];

    expect(second, 'an unchanged clone rebuilt its row instead of reusing it').toBe(first);
    expect(memoisedRowCount(), 'and did not grow the memo doing it').toBe(1);
});

it('re-derives the sidebar order after a wipe instead of answering from the old session', () => {
    buffers.set({ [KEY]: channelBuffer(KEY, '#first', 1) });
    expect(get(sidebarOrder)).toEqual([KEY]);

    resetAppState();

    expect(get(sidebarOrder), 'the wiped session has no order to report').toEqual([]);

    buffers.set({ [KEY]: channelBuffer(KEY, '#second', 2) });
    expect(get(sidebarOrder), 'the new session gets its own order').toEqual([KEY]);
    expect(get(sidebarRows)[0].shortName, 'and its own rows').toBe('#second');
});

/**
 * The bound has to hold across a session's life, not just one wipe.
 *
 * WeeChat reuses buffer ids across connections, and a long-lived app opens channels,
 * closes them and reconnects many times. Each is a path where an entry could be left
 * behind, so the count is checked after every step rather than only at the end: a
 * prune that fired only when the map went empty would pass the wipe test above and
 * fail these.
 */
it('stays bounded across repeated disconnect-and-reconnect cycles', () => {
    for (let cycle = 0; cycle < 20; cycle++) {
        const map: Record<string, BufferData> = {};
        for (let i = 0; i < 5; i++) {
            const id = `0x${cycle * 5 + i}`;
            map[id] = channelBuffer(id, `#c${cycle}-${i}`, i);
        }

        buffers.set(map);
        expect(get(sidebarRows), `cycle ${cycle}`).toHaveLength(5);
        expect(memoisedRowCount(), `cycle ${cycle} grew the memo`).toBe(5);

        resetAppState();
        // A subscribed sidebar re-projects the moment the wipe publishes; that read
        // is where the bound is enforced.
        get(sidebarRows);
        expect(memoisedRowCount(), `cycle ${cycle} kept rows from a closed session`).toBe(0);
    }
});

it('shrinks in step as buffers close, never holding a closed one', () => {
    const map: Record<string, BufferData> = {};
    for (let i = 0; i < 30; i++) {
        const id = `0x${i}`;
        map[id] = channelBuffer(id, `#c${i}`, i);
    }
    buffers.set(map);
    expect(get(sidebarRows)).toHaveLength(30);
    expect(memoisedRowCount()).toBe(30);

    for (let i = 0; i < 30; i++) {
        const remaining = { ...get(buffers) };
        delete remaining[`0x${i}`];
        buffers.set(remaining);
        get(sidebarRows);

        expect(memoisedRowCount(), `${30 - i - 1} buffers still present`).toBe(30 - i - 1);
    }
});

it('holds no row for a buffer the sidebar does not render', () => {
    // Rows enter the memo only when a visible buffer is projected, so a hidden
    // buffer — `/buffer hidden`, or a filtered server — cannot add to it either.
    const map: Record<string, BufferData> = {};
    for (let i = 0; i < 10; i++) {
        const id = `0x${i}`;
        map[id] = { ...channelBuffer(id, `#c${i}`, i), hidden: i < 6 };
    }
    buffers.set(map);

    expect(get(sidebarRows), 'four visible rows').toHaveLength(4);
    expect(memoisedRowCount(), 'a hidden buffer has no row to memoise').toBe(4);
});
