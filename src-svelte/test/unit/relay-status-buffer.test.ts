import { describe, it, expect, beforeEach, vi } from 'vitest';
import { get } from 'svelte/store';
import {
    buffers,
    servers,
    activeBufferId,
    previousBufferId,
    localUnreadBuffers,
    getEffectiveUnread,
} from '$lib/stores/models';
import type { BufferData } from '$lib/types';
import type { ProtocolMessage } from '$lib/types';

// Mock settings store to avoid localStorage access at module load time
vi.mock('$lib/stores/settings', () => ({
    settings: {
        subscribe: (fn: (val: any) => void) => {
            fn({
                hostField: '', port: '9001', tls: false, password: '',
                savepassword: false, autoconnect: false, useTotp: false,
                theme: 'dark', fontfamily: '', fontsize: '', customCSS: '',
                iToken: '', iAlb: '', onlyUnread: false, noembed: false,
                alwaysnicklist: false, orderbyserver: false,
                readlineBindings: false, useFavico: false, soundnotification: false,
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

vi.mock('$lib/notifications', () => ({
    createHighlight: mockCreateHighlight,
    playNotificationSound: mockPlayNotificationSound,
    updateTitle: mockUpdateTitle,
    updateFavico: mockUpdateFavico,
}));

vi.mock('$lib/windowFocus', () => ({
    initWindowFocusTracking: vi.fn(() => Promise.resolve(() => {})),
    isWindowFocused: () => typeof document !== 'undefined' && !document.hidden,
}));

const { handleBufferLineAdded, handleHotlistInfo } = await import('$lib/stores/handlers');

function makeBuffer(overrides: Partial<BufferData>): BufferData {
    return {
        id: '0x100',
        fullName: '#test',
        shortName: '#test',
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

// relay.list as the relay protocol actually reports it
const RELAY_BUFFER = makeBuffer({
    id: '0x900',
    fullName: 'relay.relay.list',
    shortName: 'relay.list',
    trimmedName: 'relay.list',
    prefix: '',
    number: 0,
    serverSortKey: 'relay..relay.list',
    indent: false,
    bufferType: 1,
    type: 'relay',
    plugin: 'relay',
    server: '',
    hideBufferLineTimes: true,
});

// relay.raw is the relay plugin's other buffer (localvar type=debug)
const RELAY_RAW_BUFFER = makeBuffer({
    id: '0x901',
    fullName: 'relay.raw',
    shortName: 'relay.raw',
    trimmedName: 'relay.raw',
    prefix: '',
    number: 0,
    serverSortKey: 'relay.relay.raw.relay.raw',
    indent: false,
    bufferType: 3,
    type: 'debug',
    plugin: 'relay',
    server: 'relay.raw',
});

function createLineMessage(bufferId: string, notifyLevel: number, tags: string[] = [], highlight = 0): ProtocolMessage {
    return {
        objects: [{
            pointer: bufferId,
            content: [{
                buffer: bufferId,
                date: Date.now(),
                date_long: 0,
                prefix: 'Nick',
                message: 'client connected',
                tags_array: tags,
                displayed: 1,
                notify_level: notifyLevel,
                highlight,
            }],
        }],
    } as unknown as ProtocolMessage;
}

function createHotlistMessage(entries: { buffer: string; count: number[] }[]): ProtocolMessage {
    return {
        objects: [{ content: entries }],
    } as unknown as ProtocolMessage;
}

describe('relay status buffers (issue #8)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        buffers.set({
            '0x100': makeBuffer({}),
            '0x900': { ...RELAY_BUFFER },
            '0x901': { ...RELAY_RAW_BUFFER },
        });
        servers.set({ 'irc.server': { id: '0x100', unread: 0 } });
        activeBufferId.set('');
        previousBufferId.set('');
        localUnreadBuffers.set(new Set());
    });

    it('renders relay.list rows without counting them as unread', () => {
        handleBufferLineAdded(createLineMessage('0x900', 2, ['relay_client']));

        const buf = get(buffers)['0x900']!;
        expect(buf.lines.length).toBe(1);
        expect(buf.localUnread).toBe(0);
        expect(buf.unread).toBe(0);
        expect(buf.notification).toBe(0);
        expect(get(localUnreadBuffers).has('0x900')).toBe(false);
        expect(mockUpdateTitle).not.toHaveBeenCalled();
        expect(mockUpdateFavico).not.toHaveBeenCalled();
        expect(mockCreateHighlight).not.toHaveBeenCalled();
    });

    it('still counts the same line on an ordinary buffer', () => {
        handleBufferLineAdded(createLineMessage('0x100', 1, ['irc_privmsg', 'notify_message']));

        const buf = get(buffers)['0x100']!;
        expect(buf.localUnread).toBe(1);
        expect(buf.unread).toBe(1);
    });

    it('ignores a hotlist entry for relay.list', () => {
        handleHotlistInfo(createHotlistMessage([{ buffer: '0x900', count: [0, 1, 1, 0] }]));

        const buf = get(buffers)['0x900']!;
        expect(buf.unread).toBe(0);
        expect(buf.notification).toBe(0);
    });

    it('clears a stale relay.list badge left by an earlier poll', () => {
        buffers.update((b) => ({
            ...b,
            '0x900': { ...b['0x900']!, unread: 1, notification: 2, localUnread: 3 },
        }));
        localUnreadBuffers.set(new Set(['0x900']));

        // Snapshot without relay.list: WeeChat already dropped the transient entry,
        // but GB must not keep the badge it caught from the earlier poll.
        handleHotlistInfo(createHotlistMessage([{ buffer: '0x100', count: [0, 2, 0, 0] }]));

        const relay = get(buffers)['0x900']!;
        expect(relay.unread).toBe(0);
        expect(relay.notification).toBe(0);
        expect(relay.localUnread).toBe(0);
        expect(get(localUnreadBuffers).has('0x900')).toBe(false);
    });

    it('keeps preserving counts of ordinary buffers absent from a snapshot', () => {
        buffers.update((b) => ({ ...b, '0x100': { ...b['0x100']!, localUnread: 4 } }));

        handleHotlistInfo(createHotlistMessage([]));

        expect(get(buffers)['0x100']!.localUnread).toBe(4);
    });

    it('excludes relay.list from server unread totals', () => {
        handleHotlistInfo(createHotlistMessage([
            { buffer: '0x900', count: [0, 5, 5, 5] },
            { buffer: '0x100', count: [0, 2, 0, 1] },
        ]));

        expect(get(servers)['irc.server']!.unread).toBe(3);
    });

    it('treats relay.raw as a status buffer as well', () => {
        handleBufferLineAdded(createLineMessage('0x901', 3, ['notify_private'], 1));
        handleHotlistInfo(createHotlistMessage([{ buffer: '0x901', count: [0, 1, 2, 0] }]));

        const buf = get(buffers)['0x901']!;
        expect(buf.lines.length).toBe(1);
        expect(buf.unread).toBe(0);
        expect(buf.notification).toBe(0);
        expect(get(localUnreadBuffers).has('0x901')).toBe(false);
    });

    it('does not re-add a relay.list badge on a later poll that lists it again', () => {
        handleHotlistInfo(createHotlistMessage([{ buffer: '0x900', count: [0, 1, 0, 0] }]));
        handleHotlistInfo(createHotlistMessage([{ buffer: '0x900', count: [0, 1, 1, 0] }]));

        const buf = get(buffers)['0x900']!;
        expect(buf.unread).toBe(0);
        expect(buf.notification).toBe(0);
    });

    it('leaves an active or previous relay.list buffer without counts', () => {
        activeBufferId.set('0x900');
        handleHotlistInfo(createHotlistMessage([{ buffer: '0x900', count: [0, 1, 1, 0] }]));
        activeBufferId.set('');

        previousBufferId.set('0x900');
        handleHotlistInfo(createHotlistMessage([{ buffer: '0x900', count: [0, 1, 1, 0] }]));

        const buf = get(buffers)['0x900']!;
        expect(buf.unread).toBe(0);
        expect(buf.notification).toBe(0);
    });

    it('reports no effective unread for a cleared relay.list buffer', () => {
        buffers.update((b) => ({
            ...b,
            '0x900': { ...b['0x900']!, unread: 1, notification: 1, localUnread: 1 },
        }));

        handleHotlistInfo(createHotlistMessage([]));

        expect(getEffectiveUnread(get(buffers)['0x900']!)).toBe(0);
        expect(getEffectiveUnread(get(buffers)['0x100']!)).toBe(0);
    });
});
