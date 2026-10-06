import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { get } from 'svelte/store';
import {
    buffers,
    servers,
    activeBufferId,
    previousBufferId,
    hotlistClearedBuffers,
    setActiveBuffer,
    beginSyncPhase,
    endSyncPhase,
    isSyncing,
    getEffectiveUnread,
    getReadBoundaryIndex,
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
                notifyDMs: true, notifyHighlights: true, notificationSoundMode: 'off',
                notificationSoundCustom: null, notificationVolume: 50,
                joinPartsTTL: 30, joinPartsThreshold: 50, joinPartsBufferLimit: 100,
                joinPartsHide: false, joinPartsHideCore: false, joinPartsHideQueries: false,
                joinPartsHideOther: false, joinPartsHideAll: false,
                joinPartsHideAllTemp: false, joinPartsHideTempTimer: null,
                joinPartsHideTempRestore: null,
                hotkeyList: [],
                openNewBufferTab: true, autocolor: true, colorNicks: true,
                timestamp: true, timestampFormat: '%H:%M',
                bufferLineTimes: false, hideJoinParts: false,
                embedLinks: false, autoplay: false, showNickList: true,
                testSetting: false,
            });
        },
        set: () => {},
        update: () => {},
    },
}));

vi.mock('#lib/notifications.ts', () => ({
    playNotificationSound: vi.fn(),
    createHighlight: vi.fn(),
    createDM: vi.fn(),
    createMention: vi.fn(),
    onDisconnect: vi.fn(),
    updateTitle: vi.fn(),
    updateFavico: vi.fn(),
}));

// jsdom in this setup exposes no localStorage; last-buffer resume is unrelated to the
// sync phase, and handleBufferInfo would otherwise throw on it.
vi.mock('#lib/stores/bufferResume.ts', () => ({
    shouldResume: vi.fn(() => false),
    getLastBuffer: vi.fn(() => null),
    recordLastBuffer: vi.fn(),
}));

const { handleBufferInfo, handleHotlistInfo, handleBufferLineAdded, handleLineInfo } =
    await import('#lib/stores/handlers.ts');

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
        readBoundaryKnown: false,
        readBoundaryId: null,
        pendingReadBoundaryUnread: 0,
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

/** Build a buffer:gui_buffers(*) protocol message. */
function bufferInfoMessage(buffers: Array<{ id: string; name: string }>): ProtocolMessage {
    return {
        objects: [
            {
                content: buffers.map((b) => ({
                    pointers: [b.id],
                    id: b.id,
                    local_variables: {},
                    notify: 3,
                    number: 1,
                    full_name: b.name,
                    short_name: b.name,
                    title: '',
                    hidden: 0,
                    type: 'channel',
                })),
            },
        ],
    } as unknown as ProtocolMessage;
}

/** Build a hotlist message; count is [unused, message, private, highlight]. */
function hotlistMessage(entries: Array<{ id: string; count: [number, number, number, number] }>): ProtocolMessage {
    return {
        objects: [
            {
                content: entries.map((e) => ({
                    buffer: e.id,
                    count: e.count,
                })),
            },
        ],
    } as unknown as ProtocolMessage;
}

/** Build a line_info message with explicit stable line ids (oldest-first input). */
function idHistoryMessage(bufferId: string, ids: number[]): ProtocolMessage {
    // WeeChat returns newest first; handleLineInfo reverses it internally.
    const lines = [...ids].reverse().map((id) => ({
        buffer: bufferId,
        id,
        date: 1000 + id * 1000,
        date_long: 0,
        prefix: '<user>',
        message: `line ${id}`,
        tags_array: ['notify_message'],
        displayed: 1,
        notify_level: 1,
        highlight: 0,
    }));
    return {
        objects: [{ pointer: bufferId, content: lines }],
    } as unknown as ProtocolMessage;
}

/** Build a line_info (history) message for a buffer. */
function historyMessage(bufferId: string, count: number): ProtocolMessage {
    // WeeChat returns newest first; handleLineInfo reverses it internally.
    const lines = Array.from({ length: count }, (_, i) => ({
        buffer: bufferId,
        date: 1000 + (count - i) * 1000,
        date_long: 0,
        prefix: '<user>',
        message: `history line ${count - i}`,
        tags_array: ['notify_message'],
        displayed: 1,
        notify_level: 1,
        highlight: 0,
    }));
    return {
        objects: [{ pointer: bufferId, content: lines }],
    } as unknown as ProtocolMessage;
}

/** Build a _buffer_line_added protocol message for a single live line. */
function lineMessage(bufferId: string, tags: string[] = ['notify_message']): ProtocolMessage {
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
                        notify_level: 1,
                        highlight: 0,
                    },
                ],
            },
        ],
    } as unknown as ProtocolMessage;
}

describe('Sync phase lifecycle', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        endSyncPhase();
        buffers.set({});
        servers.set({ 'irc.server': { id: '0x100', unread: 0 } });
        activeBufferId.set('');
        previousBufferId.set('');
        // setActiveBuffer parks an id here so a stale hotlist cannot restore its unread;
        // only a disconnect or reset clears the set, so the harness must clear it too.
        hotlistClearedBuffers.update(() => new Set());
    });

    afterEach(() => {
        endSyncPhase();
    });

    it('is open while the baseline is pending and closed when init applies it', () => {
        const phase = beginSyncPhase();
        handleBufferInfo(bufferInfoMessage([{ id: '0x100', name: '#test' }]));
        expect(isSyncing()).toBe(true);

        handleHotlistInfo(hotlistMessage([{ id: '0x100', count: [0, 0, 0, 0] }]));
        endSyncPhase(phase);
        expect(isSyncing()).toBe(false);
    });

    it('closes on the baseline even when no line ever arrives', () => {
        // Regression: the phase used to end only through a quiet-period timer or a
        // line landing in a buffer whose read boundary could be resolved. A session
        // that stays idle must still leave the phase.
        const phase = beginSyncPhase();
        handleBufferInfo(bufferInfoMessage([{ id: '0x100', name: '#test' }]));
        expect(isSyncing()).toBe(true);

        handleHotlistInfo(hotlistMessage([]));
        endSyncPhase(phase);
        expect(isSyncing()).toBe(false);
    });

    it('is not closed by a periodic hotlist poll', () => {
        // The poll reuses handleHotlistInfo but holds no generation token, so it
        // cannot end a phase that a connection init still owns.
        const phase = beginSyncPhase();
        handleBufferInfo(bufferInfoMessage([{ id: '0x100', name: '#test' }]));
        handleHotlistInfo(hotlistMessage([]));
        expect(isSyncing()).toBe(true);

        endSyncPhase(phase);
        expect(isSyncing()).toBe(false);
    });

    it('cannot be closed by a superseded connect attempt', () => {
        // A reconnect opens a newer phase; the attempt it replaced may still fail late
        // and must not end the newer connection's phase.
        const stale = beginSyncPhase();
        const current = beginSyncPhase();

        endSyncPhase(stale);
        expect(isSyncing()).toBe(true);

        endSyncPhase(current);
        expect(isSyncing()).toBe(false);
    });

    it('closes when init ends without ever applying a baseline', () => {
        beginSyncPhase();
        expect(isSyncing()).toBe(true);
        endSyncPhase(); // init failure / disconnect path
        expect(isSyncing()).toBe(false);
    });

    it('a phase closed without a baseline still closes but resolves no boundary', () => {
        // A failed attempt must still leave the phase (resetAllState relies on it)
        // without inventing a read boundary from counts that never arrived.
        const phase = beginSyncPhase();
        buffers.set({ '0x100': makeBuffer('0x100', { lines: [], lastSeen: -1, unread: 0, notification: 0 }) });
        setActiveBuffer('0x100');
        handleLineInfo(historyMessage('0x100', 5), true, '0x100');

        endSyncPhase(phase);

        expect(isSyncing()).toBe(false);
        const buf = get(buffers)['0x100']!;
        expect(buf.lines.length).toBe(5);
        expect(buf.readBoundaryKnown).toBe(false);
    });

    it('a superseded close neither ends the phase nor spends its baseline', () => {
        const stale = beginSyncPhase();
        const current = beginSyncPhase();
        buffers.set({ '0x100': makeBuffer('0x100', { lines: [], lastSeen: -1, unread: 0, notification: 0 }) });
        setActiveBuffer('0x100');
        handleLineInfo(historyMessage('0x100', 5), true, '0x100');
        handleHotlistInfo(hotlistMessage([{ id: '0x100', count: [0, 0, 0, 0] }]));

        endSyncPhase(stale);
        expect(isSyncing()).toBe(true);
        expect(get(buffers)['0x100']!.readBoundaryKnown).toBe(false);

        // Only the current phase's close consumes its own baseline — and that is what
        // places the boundary: the loaded history is read.
        endSyncPhase(current);
        expect(isSyncing()).toBe(false);
        expect(getReadBoundaryIndex(get(buffers)['0x100']!)).toBe(4);
    });

    it("a new phase does not inherit the previous phase's baseline", () => {
        const first = beginSyncPhase();
        buffers.set({ '0x100': makeBuffer('0x100', { unread: 0, notification: 0 }) });
        setActiveBuffer('0x100');
        handleLineInfo(historyMessage('0x100', 5), true, '0x100');
        handleHotlistInfo(hotlistMessage([{ id: '0x100', count: [0, 0, 0, 0] }]));
        endSyncPhase(first);
        expect(getReadBoundaryIndex(get(buffers)['0x100']!)).toBe(4);

        // A reconnect reopens the phase with a fresh baseline requirement: history that
        // lands before the new baseline may not be resolved from the old one.
        const second = beginSyncPhase();
        buffers.set({ '0x100': makeBuffer('0x100', { unread: 0, notification: 0 }) });
        setActiveBuffer('0x100');
        handleLineInfo(historyMessage('0x100', 5), true, '0x100');
        expect(get(buffers)['0x100']!.readBoundaryKnown).toBe(false);

        endSyncPhase(second); // closed without a new baseline
        expect(get(buffers)['0x100']!.readBoundaryKnown).toBe(false);
    });

    it('badges a live line while the baseline is pending but defers server counts', () => {
        buffers.set({
            '0x100': makeBuffer('0x100', { readBoundaryKnown: false, unread: 4 }),
        });
        beginSyncPhase();

        handleBufferLineAdded(lineMessage('0x100'));

        const buf = get(buffers)['0x100']!;
        // Badge tally is never gated (alert ⇒ badge invariant): a line that
        // races past the baseline must still badge, and getEffectiveUnread
        // max-merges so baseline-covered lines cannot inflate it.
        expect(buf.localUnread).toBe(1);
        expect(buf.unread).toBe(4); // the baseline still owns this buffer's count
    });

    it('tallies the same live line once the baseline has been applied', () => {
        buffers.set({
            '0x100': makeBuffer('0x100', { readBoundaryKnown: false, unread: 4 }),
        });
        beginSyncPhase();
        endSyncPhase();

        handleBufferLineAdded(lineMessage('0x100'));

        const buf = get(buffers)['0x100']!;
        expect(buf.localUnread).toBe(1);
    });

    it('marks a zero-count buffer fully read when history arrives after the baseline', () => {
        buffers.set({ '0x100': makeBuffer('0x100') });
        const phase = beginSyncPhase();
        handleHotlistInfo(hotlistMessage([]));
        endSyncPhase(phase);
        expect(isSyncing()).toBe(false);

        // History is fetched later than the baseline; it is a snapshot of lines the
        // hotlist already accounted for, so it is read history, not unread backlog.
        handleLineInfo(historyMessage('0x100', 5), true, '0x100');

        const buf = get(buffers)['0x100']!;
        expect(buf.lines.length).toBe(5);
        expect(buf.readBoundaryKnown).toBe(true);
        expect(buf.lastSeen).toBe(4);
        expect(buf.unread).toBe(0);
        expect(buf.localUnread).toBe(0);
    });

    it('does not resolve a read boundary from history that arrives before the baseline', () => {
        buffers.set({ '0x100': makeBuffer('0x100') });
        beginSyncPhase();

        handleLineInfo(historyMessage('0x100', 5), true, '0x100');

        const buf = get(buffers)['0x100']!;
        expect(buf.lines.length).toBe(5);
        // The baseline has not been applied yet, so its counts are still the input
        // to the boundary — resolving now would guess.
        expect(buf.readBoundaryKnown).toBe(false);
    });

    it('leaves a buffer with hotlist unread unresolved until the user views it', () => {
        buffers.set({ '0x100': makeBuffer('0x100') });
        const phase = beginSyncPhase();
        handleHotlistInfo(hotlistMessage([{ id: '0x100', count: [0, 2, 0, 0] }]));
        endSyncPhase(phase);
        expect(get(buffers)['0x100']!.unread).toBe(2);

        handleLineInfo(historyMessage('0x100', 5), true, '0x100');

        const buf = get(buffers)['0x100']!;
        expect(buf.unread).toBe(2);
        expect(buf.readBoundaryKnown).toBe(false);
        expect(buf.lastSeen).toBe(-1);
    });

    it('resolves the boundary from history once the buffer has been viewed', () => {
        buffers.set({ '0x100': makeBuffer('0x100') });
        const phase = beginSyncPhase();
        handleHotlistInfo(hotlistMessage([{ id: '0x100', count: [0, 2, 0, 0] }]));
        endSyncPhase(phase);

        // Viewing the buffer defers its boundary until history proves where the
        // unread block starts.
        setActiveBuffer('0x100');
        handleLineInfo(historyMessage('0x100', 5), true, '0x100');

        const buf = get(buffers)['0x100']!;
        expect(buf.readBoundaryKnown).toBe(true);
        // 5 lines, 2 unread → the boundary sits before the last two lines.
        expect(buf.lastSeen).toBe(2);
        expect(buf.unread).toBe(0);
        expect(buf.localUnread).toBe(0);
    });

    it('does not mark a live line read when history arrives after it', () => {
        buffers.set({ '0x100': makeBuffer('0x100') });
        const phase = beginSyncPhase();
        handleHotlistInfo(hotlistMessage([])); // baseline: nothing unread
        endSyncPhase(phase);

        handleBufferLineAdded(lineMessage('0x100')); // live line, after the baseline
        handleLineInfo(historyMessage('0x100', 5), true, '0x100');

        const buf = get(buffers)['0x100']!;
        expect(buf.localUnread).toBe(1);
        // A zero hotlist count must not erase a live arrival that postdates it.
        expect(buf.readBoundaryKnown).toBe(false);
    });

    it('does not double-count a live line that a later hotlist poll also reports', () => {
        buffers.set({ '0x100': makeBuffer('0x100') });
        const phase = beginSyncPhase();
        handleHotlistInfo(hotlistMessage([]));
        endSyncPhase(phase);
        handleBufferLineAdded(lineMessage('0x100')); // local tally: 1
        handleHotlistInfo(hotlistMessage([{ id: '0x100', count: [0, 1, 0, 0] }])); // WeeChat agrees

        // The badge is derived from getEffectiveUnread, which reconciles WeeChat's
        // count with the local tally rather than adding them.
        expect(getEffectiveUnread(get(buffers)['0x100']!)).toBe(1);
    });

    it('keeps hotlist counts authoritative when history arrives after a poll', () => {
        buffers.set({ '0x100': makeBuffer('0x100') });
        const phase = beginSyncPhase();
        handleHotlistInfo(hotlistMessage([]));
        endSyncPhase(phase);
        handleHotlistInfo(hotlistMessage([{ id: '0x100', count: [0, 2, 0, 0] }]));
        handleLineInfo(historyMessage('0x100', 5), true, '0x100');

        const buf = get(buffers)['0x100']!;
        expect(buf.unread).toBe(2);
        expect(buf.localUnread).toBe(0);
        expect(buf.readBoundaryKnown).toBe(false);
    });

    it('re-anchors a known boundary across a wider replacement fetch', () => {
        buffers.set({ '0x100': makeBuffer('0x100') });
        const phase = beginSyncPhase();
        handleHotlistInfo(hotlistMessage([]));
        endSyncPhase(phase);

        handleLineInfo(idHistoryMessage('0x100', [1, 2, 3, 4, 5]), true, '0x100');
        const first = get(buffers)['0x100']!;
        expect(first.readBoundaryKnown).toBe(true);
        expect(first.lastSeen).toBe(4);
        const boundaryId = first.readBoundaryId;
        expect(boundaryId).toBeTruthy();

        // A wider window containing the same anchor must re-anchor it, not re-mark
        // the whole buffer read.
        handleLineInfo(idHistoryMessage('0x100', [0, 1, 2, 3, 4, 5, 6]), true, '0x100');
        const buf = get(buffers)['0x100']!;
        expect(buf.lines.length).toBe(7);
        expect(buf.readBoundaryId).toBe(boundaryId);
        expect(buf.lastSeen).toBe(5);
    });

    it('loses a known boundary when its anchor is missing from a replacement snapshot', () => {
        // Prior boundary: KNOWN. The new window does not contain the anchor line, so it
        // cannot prove where the boundary falls — the zero-hotlist rule must not
        // second-guess it into 'fully read'.
        buffers.set({ '0x100': makeBuffer('0x100') });
        const phase = beginSyncPhase();
        handleHotlistInfo(hotlistMessage([]));
        endSyncPhase(phase);

        handleLineInfo(idHistoryMessage('0x100', [1, 2, 3, 4, 5]), true, '0x100');
        expect(get(buffers)['0x100']!.readBoundaryKnown).toBe(true);

        handleLineInfo(idHistoryMessage('0x100', [6, 7, 8]), true, '0x100');
        const buf = get(buffers)['0x100']!;
        expect(buf.lines.length).toBe(3);
        expect(buf.readBoundaryKnown).toBe(false);
        expect(buf.lastSeen).toBe(-1);
    });

    it('resolves a buffer whose prior boundary was explicitly unknown', () => {
        // Prior boundary: UNKNOWN (a previous replacement invalidated it). With no
        // hotlist activity this is still a fresh, fully read buffer — this is the case
        // the old `!priorBoundaries.has(id)` test silently excluded.
        buffers.set({
            '0x100': makeBuffer('0x100', { readBoundaryKnown: false, readBoundaryId: null, lastSeen: -1 }),
        });
        const phase = beginSyncPhase();
        handleHotlistInfo(hotlistMessage([]));
        endSyncPhase(phase);

        handleLineInfo(idHistoryMessage('0x100', [1, 2, 3]), true, '0x100');

        const buf = get(buffers)['0x100']!;
        expect(buf.readBoundaryKnown).toBe(true);
        expect(buf.lastSeen).toBe(2);
        expect(buf.unread).toBe(0);
    });
});
