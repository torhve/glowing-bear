import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { get } from 'svelte/store';
import {
    buffers,
    servers,
    activeBufferId,
    endSyncPhase,
    localUnreadBuffers,
} from '#lib/stores/models.ts';
import type { BufferData, ProtocolMessage } from '#lib/types.ts';
import { badgeState, documentTitle, type BadgeState } from '#lib/stores/indicatorState.ts';

/**
 * Batch-level behaviour of the passive indicators and the local-unread tally.
 *
 * `_buffer_line_added` can deliver many lines in one message. The title and the
 * favicon badge are derived only from `buffers`, `settings` and `currentBuffer`,
 * none of which this handler writes until its final `buffers.update()`, so every
 * line in a batch used to recompute byte-identical values and redraw the favicon
 * N times. They are now applied once per batch. The user-facing alert — sound and
 * desktop popup — is deliberately still per line.
 */

vi.mock('#lib/stores/settings.ts', () => ({
    settings: {
        subscribe: (fn: (val: any) => void) => {
            fn({
                hostField: '', port: '9001', tls: false, password: '',
                savepassword: false, autoconnect: false, useTotp: false,
                theme: 'dark', fontfamily: '', fontsize: '', customCSS: '',
                iToken: '', iAlb: '', onlyUnread: false, noembed: false,
                alwaysnicklist: false, orderbyserver: false,
                readlineBindings: false, useFavico: true, soundnotification: true,
                enableMathjax: false, enableQuickKeys: false, showNicklist: true,
                showQuickKeys: false, showJumpKeys: false, highlightWords: '', hotlistsync: true
            });
            return () => {};
        }
    },
    updateSettings: vi.fn(),
    updatePartialSettings: vi.fn()
}));

const mockCreateHighlight = vi.fn();
const mockPlayNotificationSound = vi.fn();
const mockUpdateTitle = vi.fn();
const mockUpdateFavico = vi.fn();

vi.mock('#lib/notifications.ts', () => ({
    createHighlight: mockCreateHighlight,
    playNotificationSound: mockPlayNotificationSound,
    updateTitle: mockUpdateTitle,
    updateFavico: mockUpdateFavico,
    startIndicatorOwner: () => () => {},
    refreshIndicators: vi.fn(),
}));

vi.mock('#lib/windowFocus.ts', () => ({
    initWindowFocusTracking: vi.fn(() => Promise.resolve(() => {})),
    isWindowFocused: () => typeof document !== 'undefined' && !document.hidden,
}));

const { handleBufferLineAdded } = await import('#lib/stores/handlers.ts');

function makeBuffer(id: string, overrides: Partial<BufferData> = {}): BufferData {
    return {
        id,
        fullName: overrides.fullName ?? '#test',
        shortName: overrides.shortName ?? '#test',
        hidden: false,
        trimmedName: 'test',
        nameClasses: [],
        prefix: '#',
        number: 1,
        title: [],
        rtitle: '',
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

/** One `_buffer_line_added` message carrying `count` lines for `bufferId`. */
function batchMessage(
    bufferId: string,
    count: number,
    tags: string[],
    notifyLevel: number,
    highlight = 0,
    date = 1735689600000,
): ProtocolMessage {
    return {
        objects: [
            {
                pointer: bufferId,
                content: Array.from({ length: count }, () => ({
                    buffer: bufferId,
                    date,
                    date_long: 0,
                    prefix: '<testuser>',
                    message: 'Test message',
                    tags_array: tags,
                    displayed: 1,
                    notify_level: notifyLevel,
                    highlight,
                })),
            },
        ],
    } as unknown as ProtocolMessage;
}

function setWindowFocused(focused: boolean) {
    Object.defineProperty(document, 'hidden', {
        value: !focused,
        writable: true,
        configurable: true,
    });
}

describe('per-batch indicators and local-unread tally', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
        endSyncPhase();
        buffers.set({});
        servers.set({ 'irc.server': { id: '0x100', unread: 0 } });
        activeBufferId.set('');
        localUnreadBuffers.set(new Set());
        setWindowFocused(false);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('alerts per line but publishes the indicator state once for a batch of alert-eligible lines', () => {
        buffers.set({
            '0x100': makeBuffer('0x100', { notify: 3 }),
        });

        // The indicator stores are the only path to the title and the badge now,
        // so this is the batch-level claim the old "one title/favicon call" test
        // was really making: the batch publishes its totals once, not once per
        // line, and the alert path is untouched.
        // subscribe() delivers the current value immediately, so the first entry
        // in each list is the state before the batch, not a publication by it.
        const titles: string[] = [];
        const badges: (BadgeState | null)[] = [];
        const unsubTitle = documentTitle.subscribe((title) => titles.push(title));
        const unsubBadge = badgeState.subscribe((state) => badges.push(state));
        const titlesBefore = titles.length;
        const badgesBefore = badges.length;
        try {
            handleBufferLineAdded(batchMessage('0x100', 5, ['irc_privmsg', 'notify_private'], 2, 1));

            // User-facing alert: one per message, unchanged.
            expect(mockPlayNotificationSound).toHaveBeenCalledTimes(5);
            expect(mockCreateHighlight).toHaveBeenCalledTimes(5);

            expect(titles.length - titlesBefore).toBe(1);
            expect(titles[titles.length - 1]).toContain('(5) ');
            expect(badges.length - badgesBefore).toBe(1);
            expect(badges[badges.length - 1]).toEqual({ count: 5, kind: 'notification' });
        } finally {
            unsubTitle();
            unsubBadge();
        }

        const buf = get(buffers)['0x100']!;
        expect(buf.lines.length).toBe(5);
        expect(buf.localUnread).toBe(5);
        expect(buf.notification).toBe(5);
    });

    it('leaves the same local-unread buffer set as the per-line updates did', () => {
        buffers.set({
            '0x100': makeBuffer('0x100', { notify: 3 }),
            '0x200': makeBuffer('0x200', { fullName: '#other', shortName: '#other', notify: 3 }),
            '0x300': makeBuffer('0x300', { fullName: '#muted', shortName: '#muted', notify: 0 }),
        });

        // Two lines each for two notify-allowed buffers, one line for a muted one.
        handleBufferLineAdded({
            objects: [
                {
                    pointer: '0x100',
                    content: [
                        ...Array.from({ length: 2 }, (_, i) => ({
                            buffer: '0x100', date: 1735689600000 + i, date_long: 0,
                            prefix: '<a>', message: 'a', tags_array: ['irc_privmsg'],
                            displayed: 1, notify_level: 1, highlight: 0,
                        })),
                        ...Array.from({ length: 2 }, (_, i) => ({
                            buffer: '0x200', date: 1735689600000 + i, date_long: 0,
                            prefix: '<b>', message: 'b', tags_array: ['irc_privmsg'],
                            displayed: 1, notify_level: 1, highlight: 0,
                        })),
                        {
                            buffer: '0x300', date: 1735689600000, date_long: 0,
                            prefix: '<c>', message: 'c', tags_array: ['irc_privmsg'],
                            displayed: 1, notify_level: 1, highlight: 0,
                        },
                    ],
                },
            ],
        } as unknown as ProtocolMessage);

        // The badge tally is not gated by the buffer's notify setting (only the
        // server-count unread/notification are), so the muted buffer counts too.
        const unreadIds = get(localUnreadBuffers);
        expect([...unreadIds].sort()).toEqual(['0x100', '0x200', '0x300']);
        expect(get(buffers)['0x100']!.localUnread).toBe(2);
        expect(get(buffers)['0x200']!.localUnread).toBe(2);
        expect(get(buffers)['0x300']!.localUnread).toBe(1);
    });

    it('does not touch the indicators when no line in the batch is alert-eligible', () => {
        buffers.set({
            '0x100': makeBuffer('0x100', { notify: 0 }),
        });

        handleBufferLineAdded(batchMessage('0x100', 4, ['irc_privmsg'], 1));

        expect(mockUpdateTitle).not.toHaveBeenCalled();
        expect(mockUpdateFavico).not.toHaveBeenCalled();
        expect(mockPlayNotificationSound).not.toHaveBeenCalled();
        expect(get(buffers)['0x100']!.lines.length).toBe(4);
    });

    it('keeps relay status buffer rows out of both the tally and the indicators', () => {
        buffers.set({
            '0x900': makeBuffer('0x900', {
                fullName: 'relay.list.glowingbear',
                shortName: 'list',
                plugin: 'relay',
                server: '',
                type: 'relay',
                notify: 3,
            }),
        });

        handleBufferLineAdded(batchMessage('0x900', 3, ['notify_message'], 1));

        expect(mockUpdateTitle).not.toHaveBeenCalled();
        expect(mockUpdateFavico).not.toHaveBeenCalled();
        expect(get(localUnreadBuffers).has('0x900')).toBe(false);
        expect(get(buffers)['0x900']!.localUnread).toBe(0);
    });
});
