import { describe, it, expect, beforeEach, vi } from 'vitest';
import { get } from 'svelte/store';
import { buffers, servers, activeBufferId, setActiveBuffer, hotlistClearedBuffers, createBufferLine, getReadBoundaryIndex, isUserMessageLine, setReadBoundary, setReadBoundaryUnknown } from '$lib/stores/models';
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

// Mock windowFocus so tests can control focus via document.hidden
vi.mock('$lib/windowFocus', () => ({
    initWindowFocusTracking: vi.fn(() => Promise.resolve(() => {})),
    isWindowFocused: () => typeof document !== 'undefined' && !document.hidden,
}));

// Mock bufferResume store — models.ts now imports recordBuffer for auto-resume.
vi.mock('$lib/stores/bufferResume', () => ({
    lastBufferId: {
        subscribe: (fn: (val: string) => void) => { fn(''); return () => {}; },
        set: vi.fn(),
    },
    recordLastBuffer: vi.fn(),
    shouldResume: vi.fn().mockReturnValue(false),
}));

const { handleBufferLineAdded, handleHotlistInfo, handleLineInfo } = await import('$lib/stores/handlers');

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
        localUnread: 0,
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
    date?: number,
    id?: string | number,
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
                highlight,
                id
            }]
        }]
    };
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
        // Reset document.hidden to visible for focused test scenarios.
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    });

    describe('handleBufferLineAdded', () => {
        it('does NOT increment lastSeen for active buffer (readmarker persists)', () => {
            const now = Date.now();
            const buf = makeBuffer('0x100', { lines: [{ prefix: [], content: [], date: now, shortTime: '', formattedTime: '', buffer: '0x100', tags: [], highlight: false, displayed: true, prefixtext: '', text: 'line1', showHiddenBrackets: false }] as any, lastSeen: 0, active: true });
            buffers.set({ '0x100': buf });
            activeBufferId.set('0x100');
            servers.set({ 'irc.server': { id: '0x100', unread: 0 } });

            handleBufferLineAdded(createLineMessage('0x100', [], 0, 1, 0, now));

            const result = get(buffers)['0x100'];
            // lastSeen unchanged — readmarker stays in place, new message accumulates as unread
            expect(result!.lastSeen).toBe(0);
            expect(result!.unread).toBe(0);
            // New line was added to buffer
            expect(result!.lines.length).toBe(2);
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

    describe('setActiveBuffer infers initial boundaries from authoritative hotlist counts', () => {
        it('places the boundary before unread messages when no prior boundary exists', () => {
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
            expect(result!.lastSeen).toBe(92);
            expect(result!.readBoundaryKnown).toBe(true);
            expect(result!.unread).toBe(0);
            expect(result!.notification).toBe(0);
        });

        it('includes adjacent status rows around the initial unread message', () => {
            const read = createBufferLine({ buffer: '0x200', date: 1, prefix: '<nick>', message: 'read', tags_array: ['irc_privmsg'], displayed: 1, notify_level: 0, highlight: 0, id: 'read' });
            const statusBefore = createBufferLine({ buffer: '0x200', date: 2, prefix: '--', message: 'joined', tags_array: ['irc_join'], displayed: 1, notify_level: 0, highlight: 0, id: 'status-before' });
            const unread = createBufferLine({ buffer: '0x200', date: 3, prefix: '<nick>', message: 'unread', tags_array: ['irc_privmsg'], displayed: 1, notify_level: 1, highlight: 0, id: 'unread' });
            const statusAfter = createBufferLine({ buffer: '0x200', date: 4, prefix: '--', message: 'left', tags_array: ['irc_part'], displayed: 1, notify_level: 0, highlight: 0, id: 'status-after' });
            const buf = makeBuffer('0x200', {
                lines: [read, statusBefore, unread, statusAfter],
                readBoundaryKnown: false,
                unread: 1,
            });
            buffers.set({ '0x200': buf });

            setActiveBuffer('0x200');

            const result = get(buffers)['0x200']!;
            expect(getReadBoundaryIndex(result)).toBe(0);
            expect(result.readBoundaryId).toBe('weechat:read');
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

        it('keeps the boundary unknown when unread exceeds the loaded message count', () => {
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
            expect(result!.lastSeen).toBe(-1);
            expect(result!.readBoundaryKnown).toBe(false);
            expect(result!.pendingReadBoundaryUnread).toBe(15);
        });

        it('retries a deferred hotlist boundary after additional history loads', () => {
            const firstMessage = createLineMessage('0x200', ['irc_privmsg'], 0, 1, 1, 1, 'first');
            const secondMessage = createLineMessage('0x200', ['irc_privmsg'], 0, 1, 1, 2, 'second');
            const buf = makeBuffer('0x200', {
                lines: [],
                readBoundaryKnown: false,
                unread: 2,
            });
            buffers.set({ '0x200': buf });

            setActiveBuffer('0x200');
            expect(get(buffers)['0x200']!.pendingReadBoundaryUnread).toBe(2);

            handleLineInfo({
                objects: [{
                    pointer: '0x200',
                    content: [secondMessage.objects[0]!.content[0]!, firstMessage.objects[0]!.content[0]!],
                }],
            }, true, '0x200');

            const result = get(buffers)['0x200']!;
            expect(getReadBoundaryIndex(result)).toBe(-1);
            expect(result.readBoundaryKnown).toBe(true);
            expect(result.pendingReadBoundaryUnread).toBe(0);
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
            // Set requestedLines to match actual line count so pruning subtraction is consistent.
            buf.requestedLines = 250;
            buffers.set({ '0x300': buf });
            servers.set({ 'irc.server': { id: '0x300', unread: 0 } });

            setActiveBuffer('0x300');

            const result = get(buffers)['0x300'];
            // 250 lines > max 210 (2*100+10), so 40 lines removed
            expect(result!.lines.length).toBe(210);
            // The boundary moves with the retained line identity/index.
            expect(result!.lastSeen).toBe(160);
            // requestedLines reduced by same amount: 250 - 40 = 210
            expect(result!.requestedLines).toBe(210);
            // allLinesFetched reset to allow refetching pruned lines
            expect(result!.allLinesFetched).toBe(false);
        });
    });

    describe('integrated drift scenario', () => {
        it('readmarker stays correct through line additions and buffer switch', () => {
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

            // User switches back to Buffer B — lastSeen preserved, unread cleared
            setActiveBuffer('0x200');

            result = get(buffers)['0x200'];
            // lastSeen preserved at 99 — readmarker shows correct position
            // Lines after index 99 (indices 100, 101, 102) are shown as unread
            expect(result!.lastSeen).toBe(99);
            expect(result!.active).toBe(true);
        });

        it('does NOT restore stale WeeChat counts during rapid A→B→C switching', () => {
            // Buffer A (glowing-bear): 100 lines, user was viewing it
            const bufA = makeBuffer('0x100', {
                lines: Array.from({ length: 100 }, (_, i) => ({ prefix: [], content: [], date: i, shortTime: '', formattedTime: '', buffer: '0x100', tags: [], highlight: false, displayed: true, prefixtext: '', text: `line${i}`, showHiddenBrackets: false }) as any),
                lastSeen: 99,
                unread: 0,
                notification: 0,
                active: true
            });
            // Buffer B (gbtest): exists for switching purposes
            const bufB = makeBuffer('0x200', {
                lines: [{ prefix: [], content: [], date: 0, shortTime: '', formattedTime: '', buffer: '0x200', tags: [], highlight: false, displayed: true, prefixtext: '', text: 'hello', showHiddenBrackets: false }] as any,
                lastSeen: 0,
                unread: 0,
                notification: 0,
                active: false
            });
            // Buffer C (weechat): exists for switching purposes
            const bufC = makeBuffer('0x300', {
                lines: [{ prefix: [], content: [], date: 0, shortTime: '', formattedTime: '', buffer: '0x300', tags: [], highlight: false, displayed: true, prefixtext: '', text: 'hello', showHiddenBrackets: false }] as any,
                lastSeen: 0,
                unread: 0,
                notification: 0,
                active: false
            });
            buffers.set({ '0x100': bufA, '0x200': bufB, '0x300': bufC });
            activeBufferId.set('0x100');
            servers.set({
                'irc.server': { id: '0x100', unread: 0 },
                'irc.server2': { id: '0x200', unread: 0 },
                'irc.server3': { id: '0x300', unread: 0 }
            });

            // User switches A→B
            setActiveBuffer('0x200');
            let resultA = get(buffers)['0x100'];
            expect(resultA!.unread).toBe(0);
            expect(resultA!.notification).toBe(0);
            expect(resultA!.lastSeen).toBe(99);

            // Stale WeeChat hotlist arrives (hasn't processed clear command yet)
            // This would normally restore A's counts via Math.max(0, staleCount)
            handleHotlistInfo(createHotlistInfo([{ buffer: '0x100', count: [0, 5, 2, 0] }]));
            resultA = get(buffers)['0x100'];
            // Counts should remain zero because A is in hotlistClearedBuffers
            expect(resultA!.unread).toBe(0);
            expect(resultA!.notification).toBe(0);

            // User switches B→C
            setActiveBuffer('0x300');
            resultA = get(buffers)['0x100'];
            expect(resultA!.unread).toBe(0);
            expect(resultA!.notification).toBe(0);

            // Even if another stale hotlist arrives after A is no longer previousId,
            // counts should stay cleared
            handleHotlistInfo(createHotlistInfo([{ buffer: '0x100', count: [0, 3, 1, 0] }]));
            resultA = get(buffers)['0x100'];
            expect(resultA!.unread).toBe(0);
            expect(resultA!.notification).toBe(0);
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

            handleBufferLineAdded(createLineMessage('0x800', [], 1, 1, 3));

            const result = get(buffers)['0x800'];
            expect(result!.notification).toBe(0);
        });

        it('does NOT increment notification for highlight on active buffer even when window unfocused', () => {
            const buf = makeBuffer('0x900', { lines: [] as any, lastSeen: 0, active: true, notify: 3 });
            buffers.set({ '0x900': buf });
            servers.set({ 'irc.server': { id: '0x900', unread: 0 } });
            activeBufferId.set('0x900');

            // Simulate hidden tab - notifications should still be suppressed for active buffer.
            Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });

            handleBufferLineAdded(createLineMessage('0x900', [], 1, 1, 3));

            const result = get(buffers)['0x900'];
            expect(result!.notification).toBe(0);
        });

        it('does NOT increment unread for message on active+focused buffer', () => {
            const buf = makeBuffer('0xA00', { lines: [] as any, lastSeen: 0, active: true, notify: 3 });
            buffers.set({ '0xA00': buf });
            servers.set({ 'irc.server': { id: '0xA00', unread: 0 } });
            activeBufferId.set('0xA00');

            handleBufferLineAdded(createLineMessage('0xA00', [], 0, 1, 1));

            const result = get(buffers)['0xA00'];
            expect(result!.unread).toBe(0);
        });
    });

    describe('line classification and boundary semantics', () => {
        it('classifies IRC messages, status rows, and date separators separately', () => {
            const user = createBufferLine({ buffer: '0x1', date: 1, prefix: '<nick>', message: 'hello', tags_array: ['irc_privmsg'], displayed: 1, notify_level: 0, highlight: 0, id: 'user' });
            const action = createBufferLine({ buffer: '0x1', date: 2, prefix: '* nick', message: 'waves', tags_array: ['irc_action'], displayed: 1, notify_level: 0, highlight: 0, id: 'action' });
            const notice = createBufferLine({ buffer: '0x1', date: 3, prefix: '-', message: 'notice', tags_array: ['irc_notice'], displayed: 1, notify_level: 0, highlight: 0, id: 'notice' });
            const status = createBufferLine({ buffer: '0x1', date: 4, prefix: '--', message: 'joined', tags_array: ['irc_join'], displayed: 1, notify_level: 0, highlight: 0, id: 'status' });
            status.isDateSeparator = true;
            expect(isUserMessageLine(user)).toBe(true);
            expect(isUserMessageLine(action)).toBe(true);
            expect(isUserMessageLine(notice)).toBe(true);
            expect(isUserMessageLine(status)).toBe(false);
        });

        it('treats untagged conversational non-IRC rows as user messages', () => {
            const conversation = createBufferLine({ buffer: '0x1', date: 5, prefix: 'bot', message: 'hello', tags_array: [], displayed: 1, notify_level: 0, highlight: 0, bufferType: 'other' });
            const serverStatus = createBufferLine({ buffer: '0x1', date: 6, prefix: '--', message: 'connected', tags_array: [], displayed: 1, notify_level: 0, highlight: 0, bufferType: 'server' });
            expect(isUserMessageLine(conversation)).toBe(true);
            expect(isUserMessageLine(serverStatus)).toBe(false);
        });

        it('counts real messages even when notifications are disabled', () => {
            const message = createBufferLine({ buffer: '0x1', date: 7, prefix: '<nick>', message: 'muted but real', tags_array: ['irc_privmsg', 'notify_none'], displayed: 1, notify_level: 0, highlight: 0 });
            expect(isUserMessageLine(message)).toBe(true);
        });


        it('keeps a status-only unread region at its real boundary', () => {
            const read = createBufferLine({ buffer: '0x1', date: 1, prefix: '<nick>', message: 'read', tags_array: ['irc_privmsg'], displayed: 1, notify_level: 0, highlight: 0, id: 'read' });
            const buffer = makeBuffer('0x1', { lines: [read], readBoundaryKnown: true, readBoundaryId: 'weechat:read', lastSeen: 0, active: false });
            // createBufferLine prefixes explicit ids with weechat:.
            buffers.set({ '0x1': buffer });
            activeBufferId.set('0x999');
            handleBufferLineAdded(createLineMessage('0x1', ['irc_join'], 0, 1, 0, 2, 'status'));
            const result = get(buffers)['0x1']!;
            expect(getReadBoundaryIndex(result)).toBe(0);
            expect(result.lines.at(-1)?.isUserMessage).toBe(false);
            expect(result.unread).toBe(0);
        });

        it('represents all loaded lines unread and handles an empty buffer explicitly', () => {
            const lines = ['one', 'two'].map((text, i) => createBufferLine({ buffer: '0x2', date: i, prefix: '<nick>', message: text, tags_array: ['irc_privmsg'], displayed: 1, notify_level: 1, highlight: 0, id: `line-${i}` }));
            const buffer = makeBuffer('0x2', { lines });
            setReadBoundary(buffer, -1);
            expect(getReadBoundaryIndex(buffer)).toBe(-1);
            setReadBoundary(buffer, lines.length - 1);
            expect(getReadBoundaryIndex(buffer)).toBe(1);
            buffer.lines = [];
            setReadBoundary(buffer, -1);
            expect(getReadBoundaryIndex(buffer)).toBe(-1);
        });

        it('remaps a known boundary when history is prepended by line identity', () => {
            const old = createBufferLine({ buffer: '0x3', date: 1, prefix: '<nick>', message: 'old', tags_array: ['irc_privmsg'], displayed: 1, notify_level: 0, highlight: 0, id: 'old' });
            const boundary = createBufferLine({ buffer: '0x3', date: 2, prefix: '<nick>', message: 'boundary', tags_array: ['irc_privmsg'], displayed: 1, notify_level: 0, highlight: 0, id: 'boundary' });
            const buffer = makeBuffer('0x3', { lines: [old, boundary] });
            setReadBoundary(buffer, 1);
            buffer.lines.unshift(createBufferLine({ buffer: '0x3', date: 0, prefix: '<nick>', message: 'history', tags_array: ['irc_privmsg'], displayed: 1, notify_level: 0, highlight: 0, id: 'history' }));
            expect(getReadBoundaryIndex(buffer)).toBe(2);
        });

        it('treats duplicate legacy line identities as an unknown boundary', () => {
            const first = createBufferLine({ buffer: '0x3', date: 8, prefix: '<nick>', message: 'duplicate', tags_array: [], displayed: 1, notify_level: 1, highlight: 0 });
            const second = createBufferLine({ buffer: '0x3', date: 8, prefix: '<nick>', message: 'duplicate', tags_array: [], displayed: 1, notify_level: 1, highlight: 0 });
            const buffer = makeBuffer('0x3', { lines: [first, second] });
            setReadBoundary(buffer, 0);
            expect(buffer.readBoundaryKnown).toBe(false);
            expect(getReadBoundaryIndex(buffer)).toBe(null);
        });

        it('restores or invalidates a boundary when a reconnect snapshot replaces lines', () => {
            const anchor = createLineMessage('0x4', ['irc_privmsg'], 0, 1, 0, 2, 'anchor');
            const replacement = createLineMessage('0x4', ['irc_privmsg'], 0, 1, 0, 1, 'new');
            const anchorLine = createBufferLine(anchor.objects[0]!.content[0]!);
            const buffer = makeBuffer('0x4', { lines: [anchorLine], readBoundaryKnown: true, readBoundaryId: 'weechat:anchor', lastSeen: 0 });
            buffers.set({ '0x4': buffer });
            handleLineInfo({ objects: [{ pointer: '0x4', content: [anchor.objects[0]!.content[0]!, replacement.objects[0]!.content[0]!] }] }, true, '0x4');
            expect(getReadBoundaryIndex(get(buffers)['0x4']!)).toBe(1);
            const missing = createLineMessage('0x4', ['irc_privmsg'], 0, 1, 0, 1, 'missing');
            handleLineInfo({ objects: [{ pointer: '0x4', content: [missing.objects[0]!.content[0]!] }] }, true, '0x4');
            expect(getReadBoundaryIndex(get(buffers)['0x4']!)).toBe(null);
            setReadBoundaryUnknown(get(buffers)['0x4']!);
            expect(getReadBoundaryIndex(get(buffers)['0x4']!)).toBe(null);
        });
    });
});
