/**
 * A line batch must write the shared stores once, not once per line.
 *
 * These pin the observable contract of `flushApiLineBatch`: the per-line
 * bookkeeping (unread tallies, sounds) still happens per line, while the
 * derived indicators — document title and favicon badge — and the global
 * store write (local unread ids) are applied once for
 * the whole batch. The legacy transport has had this shape since
 * 5f5520c7; the API path is the same contract.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { get } from 'svelte/store';
import { buffers, activeBufferId, localUnreadBuffers, recalculateLinesPerScreen } from '#lib/stores/models.ts';
import { createApiStoreReducers, flushApiLineBatch } from '#lib/api/api-store-reducers.ts';
import { updateTitle, updateFavico, playNotificationSound, createHighlight } from '#lib/notifications.ts';
import { badgeState, documentTitle, type BadgeState } from '#lib/stores/indicatorState.ts';
import type { ApiReducers, BufferSnapshot, LineSnapshot } from '#lib/api/api-contracts.ts';
import type { ApiBufferId, ApiLineId } from '#lib/api/api-ids.ts';
import { apiBuffer, apiLine } from './apiFixtures.ts';

vi.mock('#lib/notifications.ts', async () => (await import('./helpers/mockNotifications.ts')).mockNotifications());
vi.mock('#lib/windowFocus.ts', () => ({ isWindowFocused: () => true }));

const BUFFER_ID = 1759000000000021 as ApiBufferId;
const KEY = String(BUFFER_ID);

function bufferSnap(): BufferSnapshot {
    return apiBuffer(BUFFER_ID, {
        name: 'irc.glowing-bear.#chan',
        shortName: '#chan',
        number: 2,
        semanticType: 'channel',
        title: '#chan',
        localVariables: { type: 'channel', plugin: 'irc', server: 'glowing-bear', channel: '#chan' },
        notify: 3,
    });
}

function coreSnap(): BufferSnapshot {
    // `free` is a content type, not a semantic one, and the core buffer reports
    // formatted content with no plugin type — which is `other` semantically.
    return apiBuffer(1759000000000020, {
        name: 'core.weechat',
        shortName: 'weechat',
        number: 0,
        notify: 3,
    });
}

function lineSnap(id: number, overrides: Partial<LineSnapshot> = {}): LineSnapshot {
    return apiLine(id, {
        prefix: 'alice',
        message: `msg ${id}`,
        tags: ['irc_privmsg', 'notify_message'],
        ...overrides,
    });
}

let reducers: ApiReducers;

function addLines(count: number, overrides: Partial<LineSnapshot> = {}): void {
    for (let i = 0; i < count; i++) reducers.lineAdded(BUFFER_ID, lineSnap(i + 1, overrides));
    flushApiLineBatch();
}

const buffer = () => get(buffers)[KEY]!;

beforeEach(() => {
    buffers.set({});
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


    it('leaves the indicators alone when nothing in the batch may alert', () => {
        // notify_level 0 lines (logged backlog, joins) never badge or ring.
        addLines(6, { notifyLevel: 0, tags: ['logger_backlog', 'notify_none'] });

        expect(updateTitle).not.toHaveBeenCalled();
        expect(updateFavico).not.toHaveBeenCalled();
        expect(playNotificationSound).not.toHaveBeenCalled();
        expect(buffer().localUnread).toBe(0);
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
    });
});
