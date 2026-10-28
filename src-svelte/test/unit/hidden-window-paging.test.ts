import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import {
    buffers, createBuffer, createBufferLine, growHistoryLimit, historyCappedFor, historyGateAction,
    initialHistoryWindow, lineLimitFor, linesPerScreen, runHistoryPage,
} from '#lib/stores/models.ts';
import { handleLineInfo } from '#lib/stores/handlers.ts';
import type { BufferData, BufferLineMessage, ProtocolMessage } from '#lib/types.ts';

/**
 * A channel whose newest window is entirely smart-filtered.
 *
 * WeeChat counts a lines request over RAW lines, so a join/part-heavy channel
 * answers N lines that are all `displayed: 0`. The page's history gate used to
 * re-fire on "renders empty" with the same N every time: the buffer stayed blank
 * and the client sent `last_line(-100)` in a tight loop, burning relay CPU.
 * Measured on the gbtest fixture, legacy transport, one spec-owned channel with a
 * 250-line filtered window in front of 4 visible lines: 2 844 history requests,
 * 2 825 of them the identical `last_line(-100)`, and 0 rows painted.
 *
 * The rule this file pins is that a further page reaches *further back*, and that
 * the reach is one number: the buffer's own cap. `historyPageSize` sizes a page to
 * the cap and `growHistoryLimit` doubles the cap toward `HISTORY_LINE_CEILING`, so
 * a page can never ask for a window deeper than the buffer is allowed to keep —
 * which matters because a legacy history page replaces the window and is trimmed
 * to the cap as it arrives. Ask deeper than the cap and the lines a search found,
 * always the oldest of a filtered window, are dropped on arrival: measured with an
 * 800-line ask against a 200-line cap, 30 visible lines at the oldest end of the
 * answer, 0 survived.
 */

const ID = '557a7fa93250';
/** The deepest window either relay answers for; the reason is in models.ts. */
const RELAY_DEPTH_CEILING = 4096;

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
 * One trip through the page gate, through the real page runner.
 *
 * The page size, the cap, the two flags a completed page sets and the pending
 * bookkeeping all belong to `runHistoryPage`; modelling them here is how this
 * file drifted from what the app does once before. What the stub owns is only the
 * protocol: what the relay answers for the newest N raw lines.
 */
async function gateTrip(
    relay: BufferLineMessage[],
    pending: Set<string>,
    asks: { pageLines: number; capAfter: number }[],
): Promise<void> {
    const action = historyGateAction(held());
    if (action === 'none') return;
    await runHistoryPage(ID, {
        numLines: 100,
        deliberate: action === 'deeper',
        pending,
        pendingKeyFor: (buffer) => buffer.id,
        heldWindow: (buffer) => Math.max(initialHistoryWindow(), buffer.lines.length),
        fetch: async (_buffer, pageLines) => {
            const newestFirst = relay.slice(-pageLines).reverse();
            handleLineInfo({ objects: [{ content: newestFirst }] } as unknown as ProtocolMessage, true, ID);
            asks.push({ pageLines, capAfter: lineLimitFor(held()) });
            return { received: newestFirst.length, complete: newestFirst.length < pageLines };
        },
    });
}

/** Run the gate until it stops asking, the way the page effect re-runs on every store change. */
async function runGate(relay: BufferLineMessage[], limit = 50): Promise<{ pageLines: number; capAfter: number }[]> {
    const asks: { pageLines: number; capAfter: number }[] = [];
    const pending = new Set<string>();
    for (let i = 0; i < limit; i++) {
        const before = asks.length;
        await gateTrip(relay, pending, asks);
        if (asks.length === before) return asks;
    }
    throw new Error(`gate still asking after ${limit} trips: ${asks.map((a) => a.pageLines).join(', ')}`);
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

    it('stops once the buffer is at the depth ceiling', () => {
        install({ newestWindowFetched: true, historyLimit: RELAY_DEPTH_CEILING });
        expect(historyGateAction(held()), 'a page at the ceiling would ask for the same window again').toBe('none');
    });

    it('stops when a buffer it already reached the ceiling for renders nothing', () => {
        // The ceiling is a statement about the cap, not the line count: WeeChat's
        // filter legitimately answers a full page with fewer usable lines than the
        // cap allows, and a line-count test would call that room to grow.
        install({ newestWindowFetched: true, historyLimit: 4090 });
        growHistoryLimit(ID);
        expect(historyCappedFor(held()), 'the doubling landed on the ceiling').toBe(true);
        expect(historyGateAction(held())).toBe('none');
    });
});

describe('a channel whose newest lines are all filtered', () => {
    it('reaches the visible lines behind the filtered ones', async () => {
        install();
        const asks = await runGate(transcript(30, 500));
        const sizes = asks.map((a) => a.pageLines);

        expect(held().lines.length, 'the older conversation renders').toBe(30);
        expect(held().lines.every((l) => l.displayed)).toBe(true);
        for (let i = 1; i < sizes.length; i++) {
            expect(sizes[i]!, `page ${i} must reach further back than page ${i - 1}`).toBeGreaterThan(sizes[i - 1]!);
        }
    });

    it('never asks deeper than the buffer is allowed to keep', async () => {
        install();
        const asks = await runGate(transcript(0, 6000));

        for (const ask of asks) {
            expect(ask.pageLines, `a ${ask.pageLines}-line ask against a ${ask.capAfter}-line cap`).toBeLessThanOrEqual(ask.capAfter);
        }
    });

    it('stops paging at the ceiling when nothing within reach is visible', async () => {
        install();
        const asks = await runGate(transcript(0, 6000));
        const sizes = asks.map((a) => a.pageLines);

        expect(held().lines).toHaveLength(0);
        expect(held().allLinesFetched, 'a full page is not history start').toBe(false);
        expect(sizes.at(-1)).toBe(RELAY_DEPTH_CEILING);
        expect(new Set(sizes).size, 'no window is requested twice').toBe(sizes.length);
        // The storm this replaced was 2 825 identical requests on the fixture; a
        // hunt that doubles from one screenful to the relay ceiling is a handful.
        expect(sizes.length, 'a bounded hunt').toBeLessThan(12);
    });

    it('stops at history start when the whole buffer is filtered', async () => {
        install();
        const asks = await runGate(transcript(0, 250));

        expect(held().allLinesFetched).toBe(true);
        expect(asks.length).toBeLessThanOrEqual(3);
    });

    it('cuts an explicit ask to the window the buffer is allowed to keep', async () => {
        // Until now the two facts only lined up by coincidence: the smallest page is
        // 100 lines and the smallest cap is 200, so "sized to the cap" held because
        // no caller asked for more. A page deeper than the retention cap is relay
        // work the buffer throws away — and on the legacy path it throws it away by
        // trimming, which is where a filtered channel's real conversation is.
        install();
        const asks: { pageLines: number; capAfter: number }[] = [];
        await runHistoryPage(ID, {
            numLines: 8000,
            deliberate: true,
            pending: new Set<string>(),
            pendingKeyFor: (buffer) => buffer.id,
            heldWindow: (buffer) => Math.max(initialHistoryWindow(), buffer.lines.length),
            fetch: async (_buffer, pageLines) => {
                asks.push({ pageLines, capAfter: lineLimitFor(held()) });
                return { received: 0, complete: false };
            },
        });

        expect(asks).toHaveLength(1);
        const ask = asks[0]!;
        expect(ask.pageLines, 'an 8 000-line ask against a screen cap').toBe(ask.capAfter);
    });

    it('charges the retention budget to the lines it can actually keep', () => {
        // A history page carries smart-filtered lines too, and the store loop never
        // pushes them. Counting them for cap space spent the budget on lines that
        // were never stored, and the skip landed on the oldest lines of the page —
        // exactly where a join/part-heavy channel's conversation is. Measured before
        // the fix: 800 raw lines against a 200-line cap, 30 visible lines at the
        // oldest end of the answer, 0 of them kept.
        install({ newestWindowFetched: true, historyLimit: 200 });
        // Newest first, as a relay page arrives: the oldest 30 are the visible ones.
        const page = Array.from({ length: 800 }, (_, i) => ({
            buffer: ID,
            id: 900 + i,
            date: 1_700_000_000 + i,
            date_printed: 1_700_000_000 + i,
            prefix: i < 770 ? '-->' : 'nick',
            message: i < 770 ? `hidden ${i}` : `visible ${i}`,
            tags_array: i < 770 ? ['irc_join', 'irc_smart_filter'] : ['irc_privmsg'],
            displayed: i < 770 ? 0 : 1,
            highlight: 0,
        }));

        handleLineInfo({ objects: [{ content: page }] } as unknown as ProtocolMessage, true, ID);

        const kept = held().lines.map((row) => row.text);
        expect(kept.filter((message) => message.startsWith('visible')), 'the page kept what it could show')
            .toHaveLength(30);
        expect(held().lines.length).toBeLessThanOrEqual(200);
    });

    it('offers no deeper page once the search is over', () => {
        // The gate and the page runner consult one predicate (`historySearchIsOver`),
        // so this is what keeps them from drifting: if the gate still asked here, the
        // reader's control would be offered for a buffer that has nowhere left to
        // reach, and ChatView would be showing a fetch affordance for a page that can
        // only repeat the deepest window.
        install({ newestWindowFetched: true, historyLimit: RELAY_DEPTH_CEILING });
        expect(historyGateAction(held()), 'nothing on screen, cap at the ceiling').toBe('none');

        install({
            newestWindowFetched: true,
            historyLimit: RELAY_DEPTH_CEILING,
            lines: [createBufferLine({
                buffer: ID, date: 1_700_000_000, prefix: 'nick', message: 'a visible line',
                tags_array: ['irc_privmsg'], displayed: 1, highlight: 0,
            })],
        });
        expect(historyGateAction(held()), 'something is already on screen').toBe('none');

        install({ newestWindowFetched: true, historyLimit: 400 });
        expect(historyGateAction(held()), 'empty, and depth still to gain').toBe('deeper');
    });


    it('does not send a page that could only repeat the deepest window', async () => {
        // The gate stops itself, but the reader's own control does not: this is the
        // guard that keeps a repeated Control+D on an empty buffer from re-asking
        // a window both relays already answered at maximum depth.
        install({ newestWindowFetched: true, historyLimit: RELAY_DEPTH_CEILING });
        const asks: { pageLines: number; capAfter: number }[] = [];
        await runHistoryPage(ID, {
            numLines: 0,
            deliberate: true,
            pending: new Set<string>(),
            pendingKeyFor: (buffer) => buffer.id,
            heldWindow: (buffer) => Math.max(initialHistoryWindow(), buffer.lines.length),
            fetch: async (_buffer, pageLines) => {
                asks.push({ pageLines, capAfter: lineLimitFor(held()) });
                return { received: 0, complete: false };
            },
        });
        expect(asks, 'nothing to show, nothing left to widen').toHaveLength(0);
    });
});
