import { describe, it, expect, beforeEach, vi } from 'vitest';
import { get } from 'svelte/store';
import { buffers, servers, activeBufferId, setActiveBuffer } from '$lib/stores/models';
import type { BufferData, ProtocolMessage, HotlistEntry } from '$lib/types';

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

const { handleBufferLineAdded, handleHotlistChanged, handleHotlistInfo } = await import('$lib/stores/handlers');

// Helper to create a test buffer
function makeBuffer(id: string, opts: Partial<BufferData> = {}): BufferData {
    return {
        id,
        fullName: `#${id}`,
        shortName: `#${id}`,
        hidden: false,
        trimmedName: id,
        nameClasses: [],
        prefix: '#',
        number: parseInt(id.replace('0x', ''), 16) || 1,
        title: [],
        rtitle: '',
        lines: [],
        requestedLines: 0,
        allLinesFetched: false,
        lastSeen: -1,
        unread: 0,
        notification: 0,
        notify: 3,
        nicklist: {},
        serverSortKey: `irc.server.test`,
        indent: true,
        bufferType: 2,
        type: 'channel',
        plugin: 'irc',
        server: 'server',
        hideBufferLineTimes: false,
        pinned: false,
        active: false,
        ...opts
    };
}

// Helper to create a _buffer_line_added protocol message
function createLineMessage(
    bufferId: string,
    tags: string[] = [],
    highlight: number = 0,
    displayed: number = 1,
    notifyLevel: number = 1,
    date?: number
): ProtocolMessage {
    return {
        objects: [{
            pointer: bufferId,
            content: [{
                buffer: bufferId,
                date: date ?? Date.now(),
                date_long: 0,
                prefix: '\x19\u000304Nick\x19',
                message: 'Test message',
                tags_array: tags,
                displayed,
                notify_level: notifyLevel,
                highlight
            }]
        }]
    };
}

// Helper to create a _hotlist_changed protocol message
// Handler expects: objects[0].content[0] is an object with .content array (>=4 elements)
// content[0] = pointers array; remaining elements are metadata
// Per-pointer entries have .content[0].count = [idx0, msg, priv, hl]
function createHotlistChanged(pointers: string[], countsMap: Record<string, number[]>): ProtocolMessage {
    const metaFields = [0, 0, 0];
    const objects = [
        {
            pointer: '0xhotlist',
            content: [{ content: [[...pointers], ...metaFields] }]
        },
        ...pointers.map(ptr => ({
            pointer: ptr,
            content: [{ count: countsMap[ptr] || [0, 0, 0, 0] }]
        }))
    ];
    return { objects };
}

// Helper to create a hotlist info protocol message
// Format: objects[0].content = HotlistEntry[]
function createHotlistInfo(entries: HotlistEntry[]): ProtocolMessage {
    return {
        objects: [{
            pointer: '0xhotlist',
            content: entries
        }]
    };
}

describe('Readmarker behavior', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        buffers.set({});
        servers.set({});
        activeBufferId.set('');
    });

    describe('handleBufferLineAdded', () => {
        it('increments lastSeen for active buffer', () => {
            const now = Date.now();
            const buf = makeBuffer('0x100', { lines: [{ prefix: [], content: [], date: now, shortTime: '', formattedTime: '', buffer: '0x100', tags: [], highlight: false, displayed: true, prefixtext: '', text: 'line1', showHiddenBrackets: false }] as any, lastSeen: 0, active: true });
            buffers.set({ '0x100': buf });
            activeBufferId.set('0x100');
            servers.set({ 'irc.server': { id: '0x100', unread: 0 } });

            handleBufferLineAdded(createLineMessage('0x100', [], 0, 1, 0, now));

            const result = get(buffers)['0x100'];
            expect(result!.lastSeen).toBe(1);
            expect(result!.unread).toBe(0);
        });

        it('preserves lastSeen and increments unread for inactive buffer (notify_level=1)', () => {
            const buf = makeBuffer('0x200', { lines: [{ prefix: [], content: [], date: 0, shortTime: '', formattedTime: '', buffer: '0x200', tags: [], highlight: false, displayed: true, prefixtext: '', text: 'line1', showHiddenBrackets: false }] as any, lastSeen: 0, active: false });
            buffers.set({ '0x200': buf });
            activeBufferId.set('0x999'); // different buffer active
            servers.set({ 'irc.server': { id: '0x200', unread: 0 } });

            handleBufferLineAdded(createLineMessage('0x200', [], 0, 1, 1));

            const result = get(buffers)['0x200'];
            expect(result!.lastSeen).toBe(0);
            expect(result!.unread).toBe(1);
        });

        it('preserves lastSeen and increments notification for inactive buffer (notify_level=3)', () => {
            const buf = makeBuffer('0x200', { lines: [{ prefix: [], content: [], date: 0, shortTime: '', formattedTime: '', buffer: '0x200', tags: [], highlight: false, displayed: true, prefixtext: '', text: 'line1', showHiddenBrackets: false }] as any, lastSeen: 5, active: false });
            buffers.set({ '0x200': buf });
            activeBufferId.set('0x999');
            servers.set({ 'irc.server': { id: '0x200', unread: 0 } });

            handleBufferLineAdded(createLineMessage('0x200', [], 1, 1, 3));

            const result = get(buffers)['0x200'];
            expect(result!.lastSeen).toBe(5);
            expect(result!.notification).toBe(1);
        });

        it('does not increment unread for active buffer with window focus', () => {
            const buf = makeBuffer('0x100', { lines: [] as any, lastSeen: -1, active: true });
            buffers.set({ '0x100': buf });
            activeBufferId.set('0x100');
            servers.set({ 'irc.server': { id: '0x100', unread: 0 } });

            // Simulate window focused
            document.hasFocus = () => true;

            handleBufferLineAdded(createLineMessage('0x100', [], 0, 1, 1));

            const result = get(buffers)['0x100'];
            expect(result!.unread).toBe(0);
        });
    });

    describe('handleHotlistChanged preserves lastSeen', () => {
        it('updates unread/notification but does not overwrite lastSeen', () => {
            const buf = makeBuffer('0x200', {
                lines: Array.from({ length: 103 }, (_, i) => ({ prefix: [], content: [], date: i, shortTime: '', formattedTime: '', buffer: '0x200', tags: [], highlight: false, displayed: true, prefixtext: '', text: `line${i}`, showHiddenBrackets: false }) as any),
                lastSeen: 99,
                unread: 3,
                notification: 0,
                active: false
            });
            buffers.set({ '0x200': buf });
            servers.set({ 'irc.server': { id: '0x200', unread: 3 } });

            // Hotlist says only 1 unread message (WeeChat missed 2)
            handleHotlistChanged(createHotlistChanged(['0x200'], { '0x200': [0, 1, 0, 0] }));

            const result = get(buffers)['0x200'];
            expect(result!.lastSeen).toBe(99);
            expect(result!.unread).toBe(1);
        });

        it('skips active buffer in hotlist updates', () => {
            const buf = makeBuffer('0x100', { lastSeen: 50, unread: 7, notification: 2, active: true });
            buffers.set({ '0x100': buf });
            activeBufferId.set('0x100');
            servers.set({ 'irc.server': { id: '0x100', unread: 9 } });

            handleHotlistChanged(createHotlistChanged(['0x100'], { '0x100': [0, 0, 0, 0] }));

            const result = get(buffers)['0x100'];
            expect(result!.unread).toBe(7);
            expect(result!.notification).toBe(2);
            expect(result!.lastSeen).toBe(50);
        });
    });

    describe('handleHotlistInfo preserves lastSeen', () => {
        it('sets unread/notification but does not set lastSeen for post-sync hotlist', () => {
            const buf = makeBuffer('0x300', {
                lines: Array.from({ length: 50 }, (_, i) => ({ prefix: [], content: [], date: i, shortTime: '', formattedTime: '', buffer: '0x300', tags: [], highlight: false, displayed: true, prefixtext: '', text: `line${i}`, showHiddenBrackets: false }) as any),
                lastSeen: 45,
                unread: 0,
                notification: 0,
                active: false
            });
            buffers.set({ '0x300': buf });
            servers.set({ 'irc.server': { id: '0x300', unread: 0 } });

            handleHotlistInfo(createHotlistInfo([{ buffer: '0x300', count: [0, 3, 1, 0] }]));

            const result = get(buffers)['0x300'];
            expect(result!.lastSeen).toBe(45);
            expect(result!.unread).toBe(3);
            expect(result!.notification).toBe(1);
        });
    });

    describe('setActiveBuffer calculates lastSeen from unread + notification', () => {
        it('calculates lastSeen when switching to a buffer with unread messages but no lastSeen', () => {
            const buf = makeBuffer('0x200', {
                lines: Array.from({ length: 100 }, (_, i) => ({ prefix: [], content: [], date: i, shortTime: '', formattedTime: '', buffer: '0x200', tags: [], highlight: false, displayed: true, prefixtext: '', text: `line${i}`, showHiddenBrackets: false }) as any),
                lastSeen: -1,
                unread: 5,
                notification: 2,
                active: false
            });
            buffers.set({ '0x200': buf });
            servers.set({ 'irc.server': { id: '0x200', unread: 7 } });

            setActiveBuffer('0x200');

            const result = get(buffers)['0x200'];
            // lastSeen = max(0, 100 - (5+2) - 1) = 92 (uses unread + notification)
            expect(result!.lastSeen).toBe(92);
            expect(result!.unread).toBe(0);
            expect(result!.notification).toBe(0);
        });

        it('does not recalculate lastSeen if already set', () => {
            const buf = makeBuffer('0x200', {
                lines: Array.from({ length: 100 }, (_, i) => ({ prefix: [], content: [], date: i, shortTime: '', formattedTime: '', buffer: '0x200', tags: [], highlight: false, displayed: true, prefixtext: '', text: `line${i}`, showHiddenBrackets: false }) as any),
                lastSeen: 80,
                unread: 15,
                notification: 4,
                active: false
            });
            buffers.set({ '0x200': buf });
            servers.set({ 'irc.server': { id: '0x200', unread: 19 } });

            setActiveBuffer('0x200');

            const result = get(buffers)['0x200'];
            // lastSeen preserved at 80 — not recalculated when already set
            expect(result!.lastSeen).toBe(80);
            expect(result!.unread).toBe(0);
            expect(result!.notification).toBe(0);
        });

        it('sets lastSeen to 0 when unread exceeds line count', () => {
            const buf = makeBuffer('0x200', {
                lines: Array.from({ length: 3 }, (_, i) => ({ prefix: [], content: [], date: i, shortTime: '', formattedTime: '', buffer: '0x200', tags: [], highlight: false, displayed: true, prefixtext: '', text: `line${i}`, showHiddenBrackets: false }) as any),
                lastSeen: -1,
                unread: 10,
                notification: 5,
                active: false
            });
            buffers.set({ '0x200': buf });
            servers.set({ 'irc.server': { id: '0x200', unread: 15 } });

            setActiveBuffer('0x200');

            const result = get(buffers)['0x200'];
            // max(0, 3 - (10 + 5) - 1) = max(0, -13) = 0
            expect(result!.lastSeen).toBe(0);
        });

        it('prunes lines above 2 screenfuls and adjusts lastSeen', () => {
            const manyLines = Array.from({ length: 250 }, (_, i) => ({ prefix: [], content: [], date: i, shortTime: '', formattedTime: '', buffer: '0x300', tags: [], highlight: false, displayed: true, prefixtext: '', text: `line${i}`, showHiddenBrackets: false }) as any);
            const buf = makeBuffer('0x300', {
                lines: manyLines,
                lastSeen: 200,
                unread: 0,
                notification: 0,
                active: false
            });
            buffers.set({ '0x300': buf });
            servers.set({ 'irc.server': { id: '0x300', unread: 0 } });

            setActiveBuffer('0x300');

            const result = get(buffers)['0x300'];
            // 250 lines > max 210 (2*100+10), so 40 lines removed
            expect(result!.lines.length).toBe(210);
            // lastSeen adjusted: 200 - 40 = 160
            expect(result!.lastSeen).toBe(160);
            // requestedLines reduced by same amount
            expect(result!.requestedLines).toBe(0);
            // allLinesFetched reset to allow refetching pruned lines
            expect(result!.allLinesFetched).toBe(false);
        });
    });

    describe('integrated drift scenario', () => {
        it('readmarker stays correct through line additions and partial hotlist updates', () => {
            // Buffer B: 100 lines, user was viewing it (lastSeen = 99)
            const bufB = makeBuffer('0x200', {
                lines: Array.from({ length: 100 }, (_, i) => ({ prefix: [], content: [], date: i, shortTime: '', formattedTime: '', buffer: '0x200', tags: [], highlight: false, displayed: true, prefixtext: '', text: `line${i}`, showHiddenBrackets: false }) as any),
                lastSeen: 99,
                unread: 0,
                notification: 0,
                active: true
            });
            // Buffer A: exists for switching purposes
            const bufA = makeBuffer('0x100', {
                lines: [{ prefix: [], content: [], date: 0, shortTime: '', formattedTime: '', buffer: '0x100', tags: [], highlight: false, displayed: true, prefixtext: '', text: 'hello', showHiddenBrackets: false }] as any,
                lastSeen: 0,
                active: false
            });
            buffers.set({ '0x200': bufB, '0x100': bufA });
            activeBufferId.set('0x200');
            servers.set({ 'irc.server': { id: '0x200', unread: 0 }, 'irc.server2': { id: '0x100', unread: 0 } });

            // User switches to Buffer A
            setActiveBuffer('0x100');

            // 3 new messages arrive on B while inactive (dates continue from buffer)
            handleBufferLineAdded(createLineMessage('0x200', [], 0, 1, 1, 100));
            handleBufferLineAdded(createLineMessage('0x200', [], 0, 1, 1, 101));
            handleBufferLineAdded(createLineMessage('0x200', [], 0, 1, 1, 102));

            let result = get(buffers)['0x200'];
            expect(result!.lastSeen).toBe(99);
            expect(result!.unread).toBe(3);
            expect(result!.lines.length).toBe(103);

            // Hotlist fires with partial data (WeeChat saw only 1 of 3)
            handleHotlistChanged(createHotlistChanged(['0x200'], { '0x200': [0, 1, 0, 0] }));

            result = get(buffers)['0x200'];
            // lastSeen should still be 99 — not overwritten by hotlist
            expect(result!.lastSeen).toBe(99);
            // unread gets updated from hotlist (this is expected behavior)
            expect(result!.unread).toBe(1);

            // User switches back to Buffer B
            setActiveBuffer('0x200');

            result = get(buffers)['0x200'];
            // lastSeen preserved at 99 — readmarker shows correct position
            // Lines after index 99 (indices 100, 101, 102) are shown as unread
            expect(result!.lastSeen).toBe(99);
            expect(result!.active).toBe(true);
        });
    });

    describe('buffer.notify guard on unread increments', () => {
        it('does NOT increment unread when buffer notify is 0 (never)', () => {
            const buf = makeBuffer('0x400', { lines: [] as any, lastSeen: -1, active: false, notify: 0 });
            buffers.set({ '0x400': buf });
            servers.set({ 'irc.server': { id: '0x400', unread: 0 } });
            activeBufferId.set('0x999');

            handleBufferLineAdded(createLineMessage('0x400', [], 0, 1, 1));

            const result = get(buffers)['0x400'];
            expect(result!.unread).toBe(0);
        });

        it('does NOT increment unread when buffer notify is 1 (highlight only)', () => {
            const buf = makeBuffer('0x500', { lines: [] as any, lastSeen: -1, active: false, notify: 1 });
            buffers.set({ '0x500': buf });
            servers.set({ 'irc.server': { id: '0x500', unread: 0 } });
            activeBufferId.set('0x999');

            handleBufferLineAdded(createLineMessage('0x500', [], 0, 1, 1));

            const result = get(buffers)['0x500'];
            expect(result!.unread).toBe(0);
        });

        it('increments unread when buffer notify is 2 (message)', () => {
            const buf = makeBuffer('0x600', { lines: [] as any, lastSeen: -1, active: false, notify: 2 });
            buffers.set({ '0x600': buf });
            servers.set({ 'irc.server': { id: '0x600', unread: 0 } });
            activeBufferId.set('0x999');

            handleBufferLineAdded(createLineMessage('0x600', [], 0, 1, 1));

            const result = get(buffers)['0x600'];
            expect(result!.unread).toBe(1);
        });

        it('increments unread when buffer notify is 3 (all)', () => {
            const buf = makeBuffer('0x700', { lines: [] as any, lastSeen: -1, active: false, notify: 3 });
            buffers.set({ '0x700': buf });
            servers.set({ 'irc.server': { id: '0x700', unread: 0 } });
            activeBufferId.set('0x999');

            handleBufferLineAdded(createLineMessage('0x700', [], 0, 1, 1));

            const result = get(buffers)['0x700'];
            expect(result!.unread).toBe(1);
        });
    });

    describe('active+focused notification guard', () => {
        it('does NOT increment notification for highlight on active+focused buffer', () => {
            const buf = makeBuffer('0x800', { lines: [] as any, lastSeen: 0, active: true, notify: 3 });
            buffers.set({ '0x800': buf });
            servers.set({ 'irc.server': { id: '0x800', unread: 0 } });
            activeBufferId.set('0x800');

            document.hasFocus = () => true;

            handleBufferLineAdded(createLineMessage('0x800', [], 1, 1, 3));

            const result = get(buffers)['0x800'];
            expect(result!.notification).toBe(0);
        });

        it('increments notification for highlight on active buffer when window unfocused', () => {
            const buf = makeBuffer('0x900', { lines: [] as any, lastSeen: 0, active: true, notify: 3 });
            buffers.set({ '0x900': buf });
            servers.set({ 'irc.server': { id: '0x900', unread: 0 } });
            activeBufferId.set('0x900');

            document.hasFocus = () => false;

            handleBufferLineAdded(createLineMessage('0x900', [], 1, 1, 3));

            const result = get(buffers)['0x900'];
            expect(result!.notification).toBe(1);
        });

        it('does NOT increment unread for message on active+focused buffer', () => {
            const buf = makeBuffer('0xA00', { lines: [] as any, lastSeen: 0, active: true, notify: 3 });
            buffers.set({ '0xA00': buf });
            servers.set({ 'irc.server': { id: '0xA00', unread: 0 } });
            activeBufferId.set('0xA00');

            document.hasFocus = () => true;

            handleBufferLineAdded(createLineMessage('0xA00', [], 0, 1, 1));

            const result = get(buffers)['0xA00'];
            expect(result!.unread).toBe(0);
        });
    });
});
