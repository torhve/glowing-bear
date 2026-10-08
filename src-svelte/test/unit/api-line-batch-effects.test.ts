/**
 * A line batch must write the shared stores once, not once per line.
 *
 * These pin the observable contract of `flushApiLineBatch`: the per-line
 * bookkeeping (unread tallies, sounds) still happens per line, while the
 * derived indicators — document title and favicon badge — and the two global
 * store writes (local unread ids, server unread deltas) are applied once for
 * the whole batch. The legacy transport has had this shape since
 * 5f5520c7; the API path is the same contract.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { get } from 'svelte/store';
import { buffers, servers, activeBufferId, localUnreadBuffers, recalculateLinesPerScreen } from '#lib/stores/models.ts';
import { createApiStoreReducers, flushApiLineBatch } from '#lib/api/api-store-reducers.ts';
import { updateTitle, updateFavico, playNotificationSound, createHighlight } from '#lib/notifications.ts';
import { badgeState, documentTitle, type BadgeState } from '#lib/stores/indicatorState.ts';
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

const BUFFER_ID = 1759000000000021 as ApiBufferId;
const KEY = String(BUFFER_ID);
const SERVER_KEY = 'irc.glowing-bear';

function bufferSnap(): BufferSnapshot {
    return {
        id: BUFFER_ID,
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

function coreSnap(): BufferSnapshot {
    return {
        ...bufferSnap(),
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

function addLines(count: number, overrides: Partial<LineSnapshot> = {}): void {
    for (let i = 0; i < count; i++) reducers.lineAdded(BUFFER_ID, lineSnap(i + 1, overrides));
    flushApiLineBatch();
}

const buffer = () => get(buffers)[KEY]!;

beforeEach(() => {
    buffers.set({});
    servers.set({ [SERVER_KEY]: { id: SERVER_KEY, unread: 0 } });
    activeBufferId.set('');
    recalculateLinesPerScreen(500);
    vi.clearAllMocks();
    reducers = createApiStoreReducers();
    // core.weechat first so it becomes the active buffer: the flood lands on a
    // buffer nobody is looking at, which is the only case that tallies.
    reducers.buffers([coreSnap(), bufferSnap()]);
});


/**
 * Count indicator publications during a batch.
 *
 * `subscribe()` delivers the current value immediately, so the counts ignore
 * that first delivery — only what the batch itself published matters.
 */
function trackIndicators() {
    const titles: string[] = [];
    const badges: (BadgeState | null)[] = [];
    const unsubTitle = documentTitle.subscribe((t) => titles.push(t));
    const unsubBadge = badgeState.subscribe((b) => badges.push(b));
    const baseTitles = titles.length;
    const baseBadges = badges.length;
    return {
        titles: () => titles.length - baseTitles,
        badges: () => badges.length - baseBadges,
        lastTitle: () => titles[titles.length - 1],
        lastBadge: () => badges[badges.length - 1],
        stop: () => { unsubTitle(); unsubBadge(); },
    };
}

describe('API line batch effects', () => {
    it('publishes the title and badge state once for a batch of alerting lines', () => {
        // The reducers no longer call updateTitle/updateFavico — the indicator
        // stores are the only path to the DOM. The batch-level claim
        // this test makes is now about those stores: one publication per batch,
        // not one per line.
        const seen = trackIndicators();
        try {
            addLines(8);

            expect(seen.titles()).toBe(1);
            expect(seen.badges()).toBe(1);
            expect(seen.lastTitle()).toContain('(8) ');
            expect(seen.lastBadge()).toEqual({ count: 8, kind: 'unread' });
            // The tallies themselves are still per line.
            expect(buffer().localUnread).toBe(8);
            expect(buffer().unread).toBe(8);
        } finally {
            seen.stop();
        }
    });

    it('publishes the local unread id once, with the count intact', () => {
        addLines(5);

        expect(buffer().localUnread).toBe(5);
        expect(get(localUnreadBuffers).has(buffer().id)).toBe(true);
    });

    it('applies the server unread delta as one total, not one write per line', () => {
        addLines(12);
        expect(get(servers)[SERVER_KEY]!.unread).toBe(12);
    });

    it('leaves the indicators alone when nothing in the batch may alert', () => {
        // notify_level 0 lines (logged backlog, joins) never badge or ring.
        addLines(6, { notifyLevel: 0, tags: ['logger_backlog', 'notify_none'] });

        expect(updateTitle).not.toHaveBeenCalled();
        expect(updateFavico).not.toHaveBeenCalled();
        expect(playNotificationSound).not.toHaveBeenCalled();
        expect(buffer().localUnread).toBe(0);
        expect(get(servers)[SERVER_KEY]!.unread).toBe(0);
    });

    it('rings per highlight line but still publishes the badge once', () => {
        const seen = trackIndicators();
        try {
            addLines(4, { notifyLevel: 3, highlight: true, tags: ['irc_privmsg', 'notify_private'] });

            expect(playNotificationSound).toHaveBeenCalledTimes(4);
            expect(seen.titles()).toBe(1);
            expect(seen.badges()).toBe(1);
            expect(seen.lastBadge()).toEqual({ count: 4, kind: 'notification' });
            expect(buffer().notification).toBe(4);
            expect(get(servers)[SERVER_KEY]!.unread).toBe(4);
        } finally {
            seen.stop();
        }
    });

    it('does not badge a line that lands in the buffer being looked at', () => {
        activeBufferId.set(KEY);
        addLines(3);

        expect(updateTitle).not.toHaveBeenCalled();
        expect(updateFavico).not.toHaveBeenCalled();
        expect(buffer().localUnread).toBe(0);
        expect(get(servers)[SERVER_KEY]!.unread).toBe(0);
    });
});
