import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import {
    buffers, createBuffer, growHistoryLimit, historyGateAction, historyPageSize,
    historyWindowEstablished, initialHistoryWindow, linesPerScreen,
} from '#lib/stores/models.ts';
import { handleLineInfo } from '#lib/stores/handlers.ts';
import type { BufferData, BufferLineMessage, ProtocolMessage } from '#lib/types.ts';

/**
 * A channel whose newest window is entirely smart-filtered.
 *
 * WeeChat counts `last_line(-N)` over RAW lines, so a join/part-heavy channel
 * answers N lines that are all `displayed: 0`. The page's history gate used to
 * re-fire on "renders empty" with the same N every time: the buffer stayed
 * blank and the client sent `last_line(-100)` in a tight loop, burning relay CPU.
 * Each further page has to reach deeper, and the paging has to end.
 */

const ID = '557a7fa93250';

function install(overrides: Partial<BufferData> = {}): void {
    const buffer = createBuffer({
        pointers: [ID], full_name: 'irc.libera.#quiet', short_name: '#quiet', number: 1,
        local_variables: { type: 'channel' },
    });
    buffers.set({ [ID]: { ...buffer, ...overrides } });
}

function held(): BufferData {
    return get(buffers)[ID]!;
}

/** A relay transcript, oldest first: `visible` displayed lines, then `hidden` filtered ones. */
function transcript(visible: number, hidden: number): BufferLineMessage[] {
    return Array.from({ length: visible + hidden }, (_, id) => ({
        buffer: ID, id, date: 1_700_000_000, date_printed: 1_700_000_000,
        prefix: id < visible ? 'nick' : '-->', message: `line ${id}`,
        tags_array: id < visible ? ['irc_privmsg'] : ['irc_join', 'irc_smart_filter'],
        displayed: id < visible ? 1 : 0, highlight: 0,
    }) as unknown as BufferLineMessage);
}

/**
 * One trip through the page gate against the legacy transport: the page size
 * legacyConnection.fetchMoreLines computes, the relay's newest-N answer applied
 * through the real handler, and the flags the transport records afterwards.
 * Returns the size asked for, or null when the gate asked for nothing.
 */
function gateTrip(relay: BufferLineMessage[]): number | null {
    const action = historyGateAction(held());
    if (action === 'none') return null;
    const deliberate = action === 'deeper';
    const size = deliberate
        ? historyPageSize(100, growHistoryLimit(ID))
        : historyPageSize(100, Math.max(initialHistoryWindow(), held().lines.length));
    const newestFirst = relay.slice(-size).reverse();
    handleLineInfo({ objects: [{ content: newestFirst }] } as unknown as ProtocolMessage, true, ID);
    const complete = newestFirst.length < size;
    buffers.update((current) => ({
        ...current,
        [ID]: {
            ...current[ID]!,
            allLinesFetched: complete,
            newestWindowFetched: historyWindowEstablished(newestFirst.length, complete),
        },
    }));
    return size;
}

/** Run the gate until it stops asking, the way the page effect re-runs on every store change. */
function runGate(relay: BufferLineMessage[], limit = 50): number[] {
    const sizes: number[] = [];
    for (let i = 0; i < limit; i++) {
        const size = gateTrip(relay);
        if (size === null) return sizes;
        sizes.push(size);
    }
    throw new Error(`gate still asking after ${limit} trips: ${sizes.join(', ')}`);
}

beforeEach(() => {
    buffers.set({});
    linesPerScreen.set(40);
});

describe('the history gate decision', () => {
    it('asks for the newest window first', () => {
        install();
        expect(historyGateAction(held())).toBe('newest');
    });

    it('asks deeper when the newest window rendered nothing', () => {
        install({ newestWindowFetched: true });
        expect(historyGateAction(held())).toBe('deeper');
    });

    it('stops once history start is reached', () => {
        install({ newestWindowFetched: true, allLinesFetched: true });
        expect(historyGateAction(held())).toBe('none');
    });

    it('stops at the depth ceiling even with nothing to show', () => {
        install({ newestWindowFetched: true, historyLimit: 4096 });
        expect(historyGateAction(held()), 'a page at the ceiling would ask for the same window again').toBe('none');
    });
});

describe('a channel whose newest lines are all filtered', () => {
    it('reaches the visible lines behind the filtered ones', () => {
        install();
        const sizes = runGate(transcript(30, 500));

        expect(held().lines.length, 'the older conversation renders').toBeGreaterThan(0);
        expect(held().lines.every((l) => l.displayed)).toBe(true);
        for (let i = 1; i < sizes.length; i++) {
            expect(sizes[i]!, `page ${i} must reach further back than page ${i - 1}`).toBeGreaterThan(sizes[i - 1]!);
        }
    });

    it('stops paging at the ceiling when nothing within reach is visible', () => {
        install();
        const sizes = runGate(transcript(0, 6000));

        expect(held().lines).toHaveLength(0);
        expect(held().allLinesFetched, 'a full page is not history start').toBe(false);
        expect(sizes.at(-1)).toBe(4096);
        expect(new Set(sizes).size, 'no window is requested twice').toBe(sizes.length);
    });

    it('stops at history start when the whole buffer is filtered', () => {
        install();
        const sizes = runGate(transcript(0, 250));

        expect(held().allLinesFetched).toBe(true);
        expect(sizes.length).toBeLessThanOrEqual(3);
    });
});
