import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { get } from 'svelte/store';
import {
    buffers,
    servers,
    activeBufferId,
    beginSyncPhase,
    endSyncPhase,
    isSyncing,
} from '#lib/stores/models.ts';
import type { BufferData, ProtocolMessage } from '#lib/types.ts';

// Mock settings store to avoid localStorage access at module load time
vi.mock('#lib/stores/settings.ts', () => ({
    settings: {
        subscribe: (fn: (val: any) => void) => {
            fn({
                hostField: '', port: '9001', tls: false, password: '',
                savepassword: false, autoconnect: false, useTotp: false,
                theme: 'dark', fontfamily: '', fontsize: '', customCSS: '',
                iToken: '', iAlb: '', onlyUnread: false, noembed: false,
                alwaysnicklist: false, orderbyserver: false,
                readlineBindings: false, useFavico: false, soundnotification: true,
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
}));

// Focus is driven by document.hidden so tests can flip it explicitly.
vi.mock('#lib/windowFocus.ts', () => ({
    initWindowFocusTracking: vi.fn(() => Promise.resolve(() => {})),
    isWindowFocused: () => typeof document !== 'undefined' && !document.hidden,
}));

// Import handlers AFTER mocking settings and notifications
const { handleBufferLineAdded } = await import('#lib/stores/handlers.ts');


/** Build a buffer; defaults are a normal channel buffer with no unread state. */
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

/** Build a _buffer_line_added protocol message for a single line. */
function lineMessage(
    bufferId: string,
    tags: string[],
    notifyLevel: number,
    highlight = 0,
): ProtocolMessage {
    return {
        objects: [
            {
                pointer: bufferId,
                content: [
                    {
                        buffer: bufferId,
                        date: Date.now(),
                        date_long: 0,
                        prefix: '<testuser>',
                        message: 'Test message',
                        tags_array: tags,
                        displayed: 1,
                        notify_level: notifyLevel,
                        highlight,
                    },
                ],
            },
        ],
    } as unknown as ProtocolMessage;
}

/** jsdom reports document.hidden as false; override it to drive focus state. */
function setWindowFocused(focused: boolean) {
    Object.defineProperty(document, 'hidden', {
        value: !focused,
        writable: true,
        configurable: true,
    });
}

describe('Notification gate vs. read-boundary gate', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
        // Each test starts with the hotlist baseline already applied.
        endSyncPhase();
        buffers.set({});
        servers.set({ 'irc.server': { id: '0x100', unread: 0 } });
        activeBufferId.set('');
        setWindowFocused(false);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('rings for a PM that lands in an unknown-boundary buffer while syncing', () => {
        buffers.set({
            '0x200': makeBuffer('0x200', {
                fullName: 'gbbot',
                shortName: 'gbbot',
                prefix: '',
                type: 'query',
                bufferType: 2,
                serverSortKey: 'weechat..gbbot',
                plugin: 'weechat',
                server: '',
                notify: 3,
                unread: 5,
                readBoundaryKnown: false,
            }),
        });
        beginSyncPhase();

        handleBufferLineAdded(lineMessage('0x200', ['notify_private'], 2));

        expect(isSyncing()).toBe(true);
        const buf = get(buffers)['0x200']!;
        // Counter bookkeeping stays gated: the hotlist counts are still the
        // input to the boundary resolution, not a tally of this line.
        expect(buf.unread).toBe(5);
        expect(buf.notification).toBe(0);
        expect(buf.localUnread).toBe(0);
        // User-facing alert does not depend on sync/boundary state.
        expect(mockPlayNotificationSound).toHaveBeenCalledTimes(1);
        expect(mockCreateHighlight).toHaveBeenCalledTimes(1);
        expect(mockUpdateTitle).toHaveBeenCalledTimes(1);
        expect(mockUpdateFavico).toHaveBeenCalledTimes(1);
    });

    it('still updates passive indicators for a plain message while syncing, without ringing or counting', () => {
        buffers.set({
            '0x100': makeBuffer('0x100', {
                notify: 3,
                unread: 2,
                readBoundaryKnown: false,
            }),
        });
        beginSyncPhase();

        handleBufferLineAdded(lineMessage('0x100', ['notify_message'], 1));

        const buf = get(buffers)['0x100']!;
        expect(buf.unread).toBe(2);
        expect(buf.localUnread).toBe(0);
        expect(mockUpdateTitle).toHaveBeenCalledTimes(1);
        expect(mockPlayNotificationSound).not.toHaveBeenCalled();
        expect(mockCreateHighlight).not.toHaveBeenCalled();
    });

    it('counts and rings for the same PM once the sync phase has ended', () => {
        buffers.set({
            '0x200': makeBuffer('0x200', {
                fullName: 'gbbot',
                shortName: 'gbbot',
                prefix: '',
                type: 'query',
                plugin: 'weechat',
                server: '',
                serverSortKey: 'weechat..gbbot',
                notify: 3,
                readBoundaryKnown: false,
            }),
        });
        beginSyncPhase();
        endSyncPhase();

        handleBufferLineAdded(lineMessage('0x200', ['notify_private'], 2));

        const buf = get(buffers)['0x200']!;
        expect(buf.notification).toBe(1);
        expect(buf.localUnread).toBe(1);
        expect(mockPlayNotificationSound).toHaveBeenCalledTimes(1);
        expect(mockCreateHighlight).toHaveBeenCalledTimes(1);
    });

    it('counts for a known-boundary buffer even while still syncing', () => {
        buffers.set({
            '0x300': makeBuffer('0x300', {
                fullName: 'gbbot',
                shortName: 'gbbot',
                prefix: '',
                type: 'query',
                plugin: 'weechat',
                server: '',
                serverSortKey: 'weechat..gbbot',
                notify: 3,
                readBoundaryKnown: true,
            }),
        });
        beginSyncPhase();

        handleBufferLineAdded(lineMessage('0x300', ['notify_private'], 2));

        const buf = get(buffers)['0x300']!;
        expect(buf.notification).toBe(1);
        expect(buf.localUnread).toBe(1);
        expect(mockPlayNotificationSound).toHaveBeenCalledTimes(1);
    });

    it('suppresses the desktop popup while the window is focused, but still rings', () => {
        setWindowFocused(true);
        buffers.set({
            '0x200': makeBuffer('0x200', {
                fullName: 'gbbot',
                shortName: 'gbbot',
                prefix: '',
                type: 'query',
                plugin: 'weechat',
                server: '',
                serverSortKey: 'weechat..gbbot',
                notify: 3,
                readBoundaryKnown: false,
            }),
        });
        beginSyncPhase();

        handleBufferLineAdded(lineMessage('0x200', ['notify_private'], 2));

        expect(mockPlayNotificationSound).toHaveBeenCalledTimes(1);
        expect(mockCreateHighlight).not.toHaveBeenCalled();
    });

    it('does not notify for a buffer whose notify level is 0, even while syncing', () => {
        buffers.set({
            '0x400': makeBuffer('0x400', {
                fullName: 'gbbot',
                shortName: 'gbbot',
                prefix: '',
                type: 'query',
                plugin: 'weechat',
                server: '',
                serverSortKey: 'weechat..gbbot',
                notify: 0,
                readBoundaryKnown: false,
            }),
        });
        beginSyncPhase();

        handleBufferLineAdded(lineMessage('0x400', ['notify_private'], 2));

        expect(mockPlayNotificationSound).not.toHaveBeenCalled();
        expect(mockCreateHighlight).not.toHaveBeenCalled();
        expect(mockUpdateTitle).not.toHaveBeenCalled();
    });

    it('never notifies or counts for relay status buffers', () => {
        buffers.set({
            '0x500': makeBuffer('0x500', {
                fullName: 'relay.list',
                shortName: 'list',
                prefix: '',
                type: 'relay',
                plugin: 'relay',
                server: '',
                serverSortKey: 'relay..list',
                notify: 3,
                readBoundaryKnown: false,
            }),
        });
        beginSyncPhase();

        handleBufferLineAdded(lineMessage('0x500', ['notify_private'], 2));

        const buf = get(buffers)['0x500']!;
        expect(buf.notification).toBe(0);
        expect(buf.localUnread).toBe(0);
        expect(mockPlayNotificationSound).not.toHaveBeenCalled();
        expect(mockCreateHighlight).not.toHaveBeenCalled();
    });
});
