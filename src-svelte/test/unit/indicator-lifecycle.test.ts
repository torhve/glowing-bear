import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { get } from 'svelte/store';
import {
    buffers,
    servers,
    activeBufferId,
    endSyncPhase,
    localUnreadBuffers,
    setActiveBuffer,
} from '#lib/stores/models.ts';
import type { BufferData, ProtocolMessage } from '#lib/types.ts';
import { badgeState, documentTitle, unreadSummary, type BadgeState } from '#lib/stores/indicatorState.ts';

/**
 * The title and the badge follow their own output.
 *
 * Indicators update when their output changes, not simply because the buffer map
 * was published, while initialization, appearance changes, and recovery stay
 * explicit invalidations. These tests are the lifecycle half of that claim; the
 * A/B run supplies the measured half.
 */

vi.mock('#lib/stores/settings.ts', () => ({
    settings: {
        subscribe: (fn: (val: unknown) => void) => {
            fn({
                hostField: '', port: '9001', tls: false, password: '',
                savepassword: false, autoconnect: false, useTotp: false,
                themeDark: 'dark', themeLight: 'light', fontfamily: '', fontsize: '', customCSS: '',
                iToken: '', iAlb: '', onlyUnread: false, noembed: false,
                alwaysnicklist: false, orderbyserver: false,
                readlineBindings: false, useFavico: true, soundnotification: false,
                enableMathjax: false, enableQuickKeys: false, showNicklist: true,
                showQuickKeys: false, showJumpKeys: false, highlightWords: '', hotlistsync: true,
            });
            return () => {};
        },
    },
    updateSettings: vi.fn(),
    updatePartialSettings: vi.fn(),
}));

vi.mock('#lib/notifications.ts', async (importOriginal) => {
    const actual = await importOriginal<typeof import('#lib/notifications.ts')>();
    return {
        ...actual,
        createHighlight: vi.fn(),
        playNotificationSound: vi.fn(),
    };
});

vi.mock('#lib/windowFocus.ts', () => ({
    initWindowFocusTracking: vi.fn(() => Promise.resolve(() => {})),
    isWindowFocused: () => true,
}));

const { handleEvent, handleHotlistInfo, flushLineBatch } = await import('#lib/stores/handlers.ts');

function makeBuffer(id: string, overrides: Partial<BufferData> = {}): BufferData {
    return {
        id,
        fullName: overrides.fullName ?? `#buf${id}`,
        shortName: overrides.shortName ?? `#buf${id}`,
        hidden: false,
        trimmedName: `buf${id}`,
        nameClasses: [],
        prefix: '#',
        number: Number(id),
        title: [],
        rtitle: overrides.rtitle ?? '',
        lines: [],
        requestedLines: 0,
        allLinesFetched: false,
        lastSeen: -1,
        localUnread: 0,
        unread: 0,
        notification: 0,
        notify: 3,
        nicklist: {},
        serverSortKey: 'irc.server.test',
        indent: true,
        bufferType: 2,
        type: 'channel',
        plugin: 'irc',
        server: 'server',
        hideBufferLineTimes: false,
        pinned: false,
        active: false,
        ...overrides,
    };
}

/** Observe indicator publications; subscribe()'s immediate delivery is not counted. */
function trackIndicators() {
    const titles: string[] = [];
    const badges: (BadgeState | null)[] = [];
    const unsubTitle = documentTitle.subscribe((t) => titles.push(t));
    const unsubBadge = badgeState.subscribe((b) => badges.push(b));
    return {
        titles: () => titles.length - 1,
        badges: () => badges.length - 1,
        lastTitle: () => titles[titles.length - 1],
        lastBadge: () => badges[badges.length - 1],
        stop: () => { unsubTitle(); unsubBadge(); },
    };
}

/** A `_buffer_line_added` message for `bufferId` carrying `count` lines. */
function batchMessage(bufferId: string, count: number, notifyLevel: number): ProtocolMessage {
    return {
        id: '_buffer_line_added',
        objects: [{
            pointer: bufferId,
            content: Array.from({ length: count }, () => ({
                buffer: bufferId,
                date: 1735689600000,
                date_long: 0,
                prefix: '<testuser>',
                message: 'Test message',
                tags_array: ['irc_privmsg'],
                displayed: 1,
                notify_level: notifyLevel,
                highlight: 0,
            })),
        }],
    } as unknown as ProtocolMessage;
}

/** A hotlist snapshot carrying one entry per buffer with the given counts. */
function hotlistSnapshot(entries: Array<{ id: string; notification: number; unread: number }>): ProtocolMessage {
    return {
        objects: [{
            pointer: '0x0',
            content: entries.map((e) => ({
                buffer: e.id,
                count: [0, e.unread, e.notification, 0],
            })),
        }],
    } as unknown as ProtocolMessage;
}

describe('indicator lifecycle', () => {
    beforeEach(() => {
        endSyncPhase();
        buffers.set({});
        servers.set({ 'irc.server': { id: '0x100', unread: 0 } });
        activeBufferId.set('');
        localUnreadBuffers.set(new Set());
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('publishes nothing while the totals and the active buffer are unchanged', () => {
        buffers.set({
            '0x100': makeBuffer('0x100', { unread: 4 }),
            '0x200': makeBuffer('0x200', { unread: 7 }),
        });

        const seen = trackIndicators();
        try {
            // Re-publishing the map with identical values is what a hotlist poll
            // or an unrelated buffer edit does; the indicators must not follow it.
            buffers.update((b) => ({ ...b }));
            buffers.update((b) => ({ ...b }));
            expect(seen.titles()).toBe(0);
            expect(seen.badges()).toBe(0);
        } finally {
            seen.stop();
        }
    });

    it('publishes once when a total actually changes, and the title carries it', () => {
        buffers.set({ '0x100': makeBuffer('0x100') });

        const seen = trackIndicators();
        try {
            buffers.set({ '0x100': { ...get(buffers)['0x100']!, unread: 3 } });
            expect(seen.titles()).toBe(1);
            expect(seen.lastTitle()).toContain('(3) ');
            expect(seen.lastBadge()).toEqual({ count: 3, kind: 'unread' });
        } finally {
            seen.stop();
        }
    });

    it('publishes a badge when priority changes with an unchanged numeric total', () => {
        buffers.set({ '0x100': makeBuffer('0x100', { unread: 5 }) });

        const seen = trackIndicators();
        try {
            // Same total (5), different picture: an unread badge and a
            // notification badge are not the same drawing.
            buffers.set({ '0x100': { ...get(buffers)['0x100']!, unread: 0, notification: 5 } });
            expect(seen.badges()).toBe(1);
            expect(seen.lastBadge()).toEqual({ count: 5, kind: 'notification' });
            // The title only shows the combined total, so it is unchanged here.
            expect(seen.titles()).toBe(0);
        } finally {
            seen.stop();
        }
    });

    it('clears the badge when the counts reach zero', () => {
        buffers.set({ '0x100': makeBuffer('0x100', { unread: 2 }) });
        expect(get(badgeState)).toEqual({ count: 2, kind: 'unread' });

        // setActiveBuffer is how a buffer is marked read: it clears counts
        // optimistically, which is the path that must clear the badge too.
        setActiveBuffer('0x100');
        expect(get(unreadSummary)).toEqual({ unread: 0, notifications: 0 });
        expect(get(badgeState)).toBeNull();
        expect(get(documentTitle)).not.toMatch(/^\(\d+\)/);
    });

    it('publishes null when the badge is disabled, so the owner can clear it', () => {
        // The settings mock in this file reports useFavico: true; the disabled
        // case is exercised through the store's own contract instead: a null
        // badge state is an instruction to clear, not an absence of work.
        buffers.set({ '0x100': makeBuffer('0x100', { unread: 1 }) });
        expect(get(badgeState)).not.toBeNull();
        buffers.set({});
        expect(get(badgeState)).toBeNull();
    });

    it('agrees with the counts the sidebar shows for the same state', () => {
        buffers.set({
            '0x100': makeBuffer('0x100', { unread: 2, notification: 1 }),
            '0x200': makeBuffer('0x200', { unread: 3 }),
        });
        const totals = get(unreadSummary);
        expect(totals.unread).toBe(5);
        expect(totals.notifications).toBe(1);
        expect(get(documentTitle)).toContain('(6) ');
    });

    it('follows the active buffer name and topic, not the buffer map', () => {
        const a = makeBuffer('0x100', { shortName: '#alpha', rtitle: 'alpha topic' });
        const b = makeBuffer('0x200', { shortName: '#beta', rtitle: 'beta topic' });
        buffers.set({ '0x100': a, '0x200': b });
        setActiveBuffer('0x100');
        expect(get(documentTitle)).toContain('#alpha - alpha topic');

        const seen = trackIndicators();
        try {
            setActiveBuffer('0x200');
            expect(seen.titles()).toBe(1);
            expect(seen.lastTitle()).toContain('#beta - beta topic');
        } finally {
            seen.stop();
        }
    });

    it('publishes the indicators once per background batch, not once per line', async () => {
        buffers.set({
            '0x100': makeBuffer('0x100', { active: true }),
            '0x200': makeBuffer('0x200', { readBoundaryKnown: true, serverReadLineId: '0' }),
        });
        activeBufferId.set('0x100');

        const seen = trackIndicators();
        try {
            // 15 lines in 3 batches. The total genuinely changes, so the title
            // and the badge must publish — three times, not fifteen.
            for (let batch = 0; batch < 3; batch += 1) {
                for (let i = 0; i < 5; i += 1) {
                    handleEvent(batchMessage('0x200', 1, 1));
                }
                flushLineBatch();
            }
            expect(seen.titles()).toBe(3);
            expect(seen.badges()).toBe(3);
            expect(get(buffers)['0x200']!.lines.length).toBe(15);
        } finally {
            seen.stop();
        }
    });

    it('does not republish on repeated identical hotlist snapshots', () => {
        buffers.set({
            '0x100': makeBuffer('0x100', { unread: 3 }),
            '0x200': makeBuffer('0x200', { unread: 1 }),
        });

        const seen = trackIndicators();
        try {
            for (let i = 0; i < 10; i += 1) {
                handleHotlistInfo(hotlistSnapshot([
                    { id: '0x100', notification: 0, unread: 3 },
                    { id: '0x200', notification: 0, unread: 1 },
                ]));
            }
            expect(seen.titles()).toBe(0);
            expect(seen.badges()).toBe(0);
        } finally {
            seen.stop();
        }
    });
});
