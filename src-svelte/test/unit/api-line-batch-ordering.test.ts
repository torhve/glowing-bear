/**
 * Ordering and liveness of the API line batch.
 *
 * `lineAdded` no longer writes to the stores inline: it queues the line and a
 * flush applies the whole frame at once. That is only equivalent to the old
 * per-line behaviour if the queue is drained at every point where another
 * event — or another part of the app — can observe or write buffer state, and
 * if a queued line is never lost when frames stop being produced.
 *
 * A rendered-row hash cannot prove any of this: the same rows in the wrong
 * order, or with the wrong unread tally, hash identically to a correct run
 * only by accident. These tests assert order and counters directly.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { get } from 'svelte/store';
import { buffers, servers, activeBufferId, localUnreadBuffers, recalculateLinesPerScreen } from '#lib/stores/models.ts';
import { createApiStoreReducers, flushApiLineBatch } from '#lib/api/api-store-reducers.ts';
import { updateTitle, updateFavico, playNotificationSound } from '#lib/notifications.ts';
import { badgeState, documentTitle } from '#lib/stores/indicatorState.ts';
import type { ApiReducers, BufferSnapshot, LineSnapshot } from '#lib/api/api-contracts.ts';
import type { ApiBufferId, ApiLineId } from '#lib/api/api-ids.ts';

vi.mock('#lib/notifications.ts', () => ({
    createHighlight: vi.fn(),
    playNotificationSound: vi.fn(),
    updateTitle: vi.fn(),
    updateFavico: vi.fn(),
    startIndicatorOwner: () => () => {},
    refreshIndicators: vi.fn(),
}));
vi.mock('#lib/windowFocus.ts', () => ({ isWindowFocused: () => true }));

const CHAN_ID = 1759000000000021 as ApiBufferId;
const OTHER_ID = 1759000000000022 as ApiBufferId;
const CHAN = String(CHAN_ID);
const OTHER = String(OTHER_ID);
const SERVER_KEY = 'irc.glowing-bear';

function chanSnap(): BufferSnapshot {
    return {
        id: CHAN_ID,
        name: 'irc.glowing-bear.#chan',
        shortName: '#chan',
        number: 2,
        contentType: 'formatted',
        semanticType: 'channel',
        hidden: false,
        title: '#chan',
        localVariables: { type: 'channel', plugin: 'irc', server: 'glowing-bear', channel: '#chan' },
        lastReadLineId: -1,
        notify: 3,
    };
}

function otherSnap(): BufferSnapshot {
    return { ...chanSnap(), id: OTHER_ID, name: 'irc.glowing-bear.#other', shortName: '#other', number: 3 };
}

function coreSnap(): BufferSnapshot {
    return {
        ...chanSnap(),
        id: 1759000000000020 as ApiBufferId,
        name: 'core.weechat',
        shortName: 'weechat',
        number: 0,
        semanticType: 'free',
        localVariables: {},
    };
}

function lineSnap(id: number, overrides: Partial<LineSnapshot> = {}): LineSnapshot {
    return {
        id: id as ApiLineId,
        epochMs: Date.parse('2026-10-04T12:00:00.000Z') + id * 1000,
        displayed: true,
        highlight: false,
        notifyLevel: 1,
        prefix: 'alice',
        message: `msg ${id}`,
        tags: ['irc_privmsg', 'notify_message'],
        ...overrides,
    };
}

let reducers: ApiReducers;

/**
 * Indicator publications observed since the counter was armed.
 *
 * `subscribe()` delivers the current value immediately, so the baseline skips
 * that first delivery and only counts what the run itself published.
 */
function armIndicatorCounter() {
    let titles = 0;
    let badges = 0;
    const unsubTitle = documentTitle.subscribe(() => { titles += 1; });
    const unsubBadge = badgeState.subscribe(() => { badges += 1; });
    const baseTitle = titles;
    const baseBadge = badges;
    return {
        count: () => ({ titles: titles - baseTitle, badges: badges - baseBadge }),
        stop: () => { unsubTitle(); unsubBadge(); },
    };
}

/** Observable state that a mis-ordered batch would change. */
function stateSnapshot(indicators: { count(): { titles: number; badges: number } }) {
    const b = get(buffers);
    return {
        chanLines: (b[CHAN]?.lines ?? []).map((l) => `${l.lineId}|${l.prefixtext}|${l.text}`),
        otherLines: (b[OTHER]?.lines ?? []).map((l) => `${l.lineId}|${l.prefixtext}|${l.text}`),
        chanUnread: b[CHAN]?.unread ?? 0,
        chanNotification: b[CHAN]?.notification ?? 0,
        chanLocalUnread: b[CHAN]?.localUnread ?? 0,
        serverUnread: get(servers)[SERVER_KEY]?.unread ?? 0,
        localUnreadIds: [...get(localUnreadBuffers)].sort(),
        titleWrites: indicators.count().titles,
        badgeWrites: indicators.count().badges,
        soundCalls: vi.mocked(playNotificationSound).mock.calls.length,
    };
}

/** Counter used by snapshots that do not care about the counts themselves. */
const ambientIndicators = armIndicatorCounter();

function seedBuffers(): void {
    // core.weechat first so it becomes the active buffer: the flood then lands
    // on buffers nobody is looking at, which is the case that tallies unread.
    reducers.buffers([coreSnap(), chanSnap(), otherSnap()]);
}

beforeEach(() => {
    buffers.set({});
    servers.set({ [SERVER_KEY]: { id: SERVER_KEY, unread: 0 } });
    activeBufferId.set('');
    localUnreadBuffers.update(() => new Set());
    recalculateLinesPerScreen(500);
    vi.clearAllMocks();
    reducers = createApiStoreReducers();
    seedBuffers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('API line batch ordering', () => {
    it('keeps arrival order when one batch interleaves two buffers', () => {
        for (let i = 1; i <= 4; i++) {
            reducers.lineAdded(CHAN_ID, lineSnap(i));
            reducers.lineAdded(OTHER_ID, lineSnap(100 + i));
        }
        flushApiLineBatch();

        expect(stateSnapshot(ambientIndicators).chanLines).toEqual(['weechat:1|alice|msg 1', 'weechat:2|alice|msg 2', 'weechat:3|alice|msg 3', 'weechat:4|alice|msg 4']);
        expect(stateSnapshot(ambientIndicators).otherLines).toEqual(['weechat:101|alice|msg 101', 'weechat:102|alice|msg 102', 'weechat:103|alice|msg 103', 'weechat:104|alice|msg 104']);
    });

    it('drains queued lines before a buffer_cleared wipes the buffer', () => {
        reducers.lineAdded(CHAN_ID, lineSnap(1));
        reducers.lineAdded(CHAN_ID, lineSnap(2));
        // Without the flush point the clear runs first and the queued lines
        // then re-append themselves to a buffer WeeChat has already cleared.
        reducers.bufferCleared(CHAN_ID);
        flushApiLineBatch();

        expect(stateSnapshot(ambientIndicators).chanLines).toEqual([]);
    });

    it('drains queued lines before a buffer_closed removes the buffer', () => {
        // Closing deletes the buffer outright, so ordering is only observable
        // through what a REOPENED buffer contains: WeeChat reuses buffer ids,
        // and a line that was still queued when the old buffer closed must not
        // leak into the new one. `bufferOpened` flushes too, so removing the
        // close-side flush alone is not enough to break this — mutating both
        // does, which is the contract this test actually guards.
        reducers.lineAdded(CHAN_ID, lineSnap(1));
        reducers.bufferClosed(CHAN_ID);
        reducers.bufferOpened(chanSnap(), undefined, undefined, undefined);
        flushApiLineBatch();

        expect(get(buffers)[CHAN]).toBeDefined();
        expect(stateSnapshot(ambientIndicators).chanLines).toEqual([]);
    });

    it('applies a queued line before line_data_changed rewrites it', () => {
        reducers.lineAdded(CHAN_ID, lineSnap(7));
        reducers.lineDataChanged(CHAN_ID, lineSnap(7, { message: 'edited', prefix: 'bob' }));
        flushApiLineBatch();

        // The edit must land on the queued line rather than being dropped
        // because the line did not exist yet.
        expect(stateSnapshot(ambientIndicators).chanLines).toEqual(['weechat:7|bob|edited']);
    });

    it('produces the same state as applying the same events one line at a time', () => {
        const events = [
            { buffer: CHAN_ID, id: 1, notifyLevel: 1 },
            { buffer: OTHER_ID, id: 51, notifyLevel: 2 },
            { buffer: CHAN_ID, id: 2, notifyLevel: 0 },
            { buffer: CHAN_ID, id: 3, notifyLevel: 1, highlight: true },
            { buffer: OTHER_ID, id: 52, notifyLevel: 1 },
        ];

        const batchCounters = armIndicatorCounter();
        // Reference: the pre-batching behaviour, one store write per event.
        for (const e of events) reducers.lineAdded(e.buffer, lineSnap(e.id, e));
        flushApiLineBatch();
        const batched = stateSnapshot(batchCounters);
        batchCounters.stop();

        buffers.set({});
        servers.set({ [SERVER_KEY]: { id: SERVER_KEY, unread: 0 } });
        activeBufferId.set('');
        localUnreadBuffers.update(() => new Set());
        vi.clearAllMocks();
        reducers = createApiStoreReducers();
        seedBuffers();
        const lineCounters = armIndicatorCounter();
        for (const e of events) {
            reducers.lineAdded(e.buffer, lineSnap(e.id, e));
            flushApiLineBatch();
        }
        const perLine = stateSnapshot(lineCounters);
        lineCounters.stop();

        // Everything except the number of indicator WRITES must agree: fewer
        // writes is the whole point of batching, different state is not.
        const { titleWrites: batchTitles, badgeWrites: batchBadges, ...batchRest } = batched;
        const { titleWrites: lineTitles, badgeWrites: lineBadges, ...lineRest } = perLine;
        expect(batchRest).toEqual(lineRest);
        // The batched run must not have lost any per-line sound decision.
        expect(batched.soundCalls).toEqual(perLine.soundCalls);
        // …and it must have collapsed the indicator work it is meant to collapse.
        // Counted on the indicator stores themselves: the reducers no longer
        // touch the title or the badge at all, so a publication here
        // means the value genuinely changed, and batching must not multiply it.
        expect(batchTitles).toBeLessThan(lineTitles);
        expect(batchBadges).toBeLessThan(lineBadges);
    });
});

describe('API line batch liveness', () => {
    it('applies queued lines within a bounded time when frames are not produced', () => {
        // A background tab throttles requestAnimationFrame to a stop. If the
        // flush depended on rAF alone, messages, unread counts and the badge
        // would freeze until the tab became visible again.
        vi.useFakeTimers();
        // Fake timers install their own requestAnimationFrame, so the stub has
        // to replace it afterwards, or the test would exercise the fake frame
        // loop instead of a tab that produces none.
        globalThis.requestAnimationFrame = () => 0;
        try {
            reducers.lineAdded(CHAN_ID, lineSnap(1));
            reducers.lineAdded(CHAN_ID, lineSnap(2));

            expect(stateSnapshot(ambientIndicators).chanLines).toEqual([]);
            vi.advanceTimersByTime(100);

            expect(stateSnapshot(ambientIndicators).chanLines).toEqual(['weechat:1|alice|msg 1', 'weechat:2|alice|msg 2']);
        } finally {
            // afterEach() restores real timers, which restores the real rAF.
            vi.useRealTimers();
        }
    });

    it('does not leave a pending timer that re-applies a batch after a reset', () => {
        vi.useFakeTimers();
        try {
            reducers.lineAdded(CHAN_ID, lineSnap(1));
            flushApiLineBatch();
            expect(stateSnapshot(ambientIndicators).chanLines).toEqual(['weechat:1|alice|msg 1']);

            // A disconnect wipes buffer state; a stale timer firing afterwards
            // must not resurrect anything.
            buffers.set({});
            vi.advanceTimersByTime(100);
            expect(stateSnapshot(ambientIndicators).chanLines).toEqual([]);
        } finally {
            vi.useRealTimers();
        }
    });
});
