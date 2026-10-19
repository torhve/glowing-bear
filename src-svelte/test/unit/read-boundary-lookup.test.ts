import { describe, it, expect, beforeEach, vi } from 'vitest';
import { get } from 'svelte/store';
import {
    buffers,
    activeBufferId,
    createBuffer,
    createBufferLine,
    setActiveBuffer,
    setReadBoundary,
    getReadBoundaryIndex,
} from '#lib/stores/models.ts';
import { trimBufferLines as apiTrim } from '#lib/api/api-store-reducers.ts';
import type { BufferData, ProtocolMessage } from '#lib/types.ts';

// "Find the one line this anchor points at" is answered by models.ts
// findUniqueLineIndex (1 match -> index, 0 matches -> -1, more than 1 -> null).
// Three sites used to re-implement that lookup by hand, identically, inside their
// own trim:
//
//   handlers.ts            legacy trim   0 matches -> boundary -1  (known)
//   api-store-reducers.ts  API trim      0 matches -> boundary -1  (known)
//   models.ts              inline trim   0 matches -> boundary -1  (known)
//
// They now share models.ts setReadBoundaryFromAnchorId(), which gives exactly
// those three answers. The fourth site keeps its own copy on purpose:
//
//   handlers.ts            history re-anchor   0 matches -> UNKNOWN
//
// "Boundary -1" and "unknown" are not the same claim. -1 puts the read marker
// above every retained line; unknown defers and lets the hotlist resolve it. A
// trim removes exactly the rows older than the marker, so there its absence is
// evidence. A freshly loaded history page may simply not reach far enough back to
// contain it, so there its absence proves nothing. These tests pin which site
// makes which claim.

vi.mock('#lib/stores/settings.ts', () => ({
    settings: {
        subscribe: (fn: (val: any) => void) => {
            fn({
                hostField: '', port: '9001', tls: false, password: '',
                savepassword: false, autoconnect: false, useTotp: false,
                themeDark: 'dark', themeLight: 'light', fontfamily: '', fontsize: '', customCSS: '',
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
            return () => {};
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
    startIndicatorOwner: () => () => {},
    refreshIndicators: vi.fn(),
}));

vi.mock('#lib/stores/bufferResume.ts', () => ({
    shouldResume: vi.fn(() => false),
    getLastBuffer: vi.fn(() => null),
    recordLastBuffer: vi.fn(),
}));

const { handleBufferLineAdded, handleLineInfo } = await import('#lib/stores/handlers.ts');

const CAP = 10;

function line(id: string, i: number, message?: string): ReturnType<typeof createBufferLine> {
    return createBufferLine({
        buffer: id,
        date: 1_700_000_000 + i,
        prefix: 'nick',
        message: message ?? `line ${i}`,
        tags_array: ['irc_privmsg'],
        displayed: 1,
        notify_level: 1,
        highlight: 0,
    });
}

/** A channel over its own cap, with the boundary anchored on a chosen index. */
function fixture(id: string, lineCount: number, anchorIndex: number): BufferData {
    const base = createBuffer({
        pointers: [id],
        full_name: `irc.test.${id}`,
        short_name: id,
        number: 1,
        local_variables: { plugin: 'irc', server: 'test', type: 'channel' },
    });
    const buf: BufferData = {
        ...base,
        historyLimit: CAP,
        lines: Array.from({ length: lineCount }, (_, i) => line(id, i)),
    };
    setReadBoundary(buf, anchorIndex);
    return buf;
}

function liveLine(id: string): ProtocolMessage {
    return {
        objects: [
            {
                pointer: id,
                content: [
                    {
                        buffer: id,
                        date: 1_700_001_000,
                        date_long: 0,
                        prefix: 'nick',
                        message: 'one line too many',
                        tags_array: ['irc_privmsg'],
                        displayed: 1,
                        notify_level: 1,
                        highlight: 0,
                    },
                ],
            },
        ],
    } as unknown as ProtocolMessage;
}

/**
 * A line_info history page; WeeChat returns newest first. A line's identity is
 * derived from its buffer, date, prefix, text and tags, so a page built with the
 * fixture's own indices reproduces the fixture's line IDs — which is what lets a
 * test ask whether an anchor survived a replacement.
 */
function historyPage(id: string, count: number, firstIndex: number): ProtocolMessage {
    const lines = Array.from({ length: count }, (_, i) => {
        const idx = firstIndex + (count - 1 - i);
        return {
            buffer: id,
            date: 1_700_000_000 + idx,
            date_long: 0,
            prefix: 'nick',
            message: `line ${idx}`,
            tags_array: ['irc_privmsg'],
            displayed: 1,
            notify_level: 1,
            highlight: 0,
        };
    });
    return { objects: [{ pointer: id, content: lines }] } as unknown as ProtocolMessage;
}

function boundary(buf: BufferData) {
    return {
        known: buf.readBoundaryKnown !== false,
        index: getReadBoundaryIndex(buf),
    };
}

describe('B3 characterization: four hand-rolled copies of "find the anchor line"', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        buffers.set({});
        activeBufferId.set('');
    });

    it('the three trim copies answer "no match" with a definite boundary of -1', () => {
        // Anchor on the oldest line, then trim that line away: the anchor is
        // gone, so the lookup finds nothing.
        const apiBuf = fixture('0xC00', CAP + 1, 0);
        apiTrim(apiBuf, CAP);

        const legacyBuf = fixture('0xC01', CAP, 0);
        buffers.set({ '0xC01': legacyBuf });
        activeBufferId.set('0xC01');
        handleBufferLineAdded(liveLine('0xC01'));
        const legacyAfter = get(buffers)['0xC01']!;

        const inlineBuf = fixture('0xC02', CAP + 1, 0);
        buffers.set({ '0xC02': inlineBuf });
        setActiveBuffer('0xC02');
        const inlineAfter = get(buffers)['0xC02']!;

        expect(legacyAfter.lines.length).toBe(CAP);

        // All three: still "known", and the boundary sits before every line —
        // a claim that all retained lines are unread.
        expect(boundary(apiBuf)).toEqual({ known: true, index: -1 });
        expect(boundary(legacyAfter)).toEqual({ known: true, index: -1 });
        expect(boundary(inlineAfter)).toEqual({ known: true, index: -1 });
    });

    it('the history re-anchor answers the same "no match" with unknown', () => {
        // Same starting state — a known boundary anchored on a line that is
        // about to disappear — but reached through handleLineInfo, which
        // replaces the window instead of trimming it.
        const buf = fixture('0xC03', CAP, 0);
        const anchor = buf.readBoundaryId;
        expect(anchor).toBeTruthy();
        buffers.set({ '0xC03': buf });

        // A page of lines none of which is the anchor.
        handleLineInfo(historyPage('0xC03', CAP, 100), true, '0xC03');

        const after = get(buffers)['0xC03']!;
        expect(after.readBoundaryId).not.toBe(anchor);
        expect(boundary(after)).toEqual({ known: false, index: null });
    });

    it('one match: every copy agrees on the index it re-anchors to', () => {
        const apiBuf = fixture('0xC10', CAP + 1, 5);
        const anchor = apiBuf.readBoundaryId;
        apiTrim(apiBuf, CAP);
        expect(apiBuf.readBoundaryId).toBe(anchor);
        expect(boundary(apiBuf)).toEqual({ known: true, index: 4 });

        const buf = fixture('0xC11', CAP, 5);
        const anchor2 = buf.readBoundaryId;
        buffers.set({ '0xC11': buf });
        handleLineInfo(historyPage('0xC11', CAP, 0), true, '0xC11');
        const after = get(buffers)['0xC11']!;
        expect(after.readBoundaryId).toBe(anchor2);
        expect(boundary(after).known).toBe(true);
        expect(boundary(after).index).toBe(5); // same anchor line, same slot in the new window
    });

    it('a duplicated anchor is ambiguous for the helper and for the trim copies', () => {
        // Two lines carrying the same lineId: findUniqueLineIndex calls that
        // ambiguous (null), and the trim copies call it unknown.
        const buf = fixture('0xC20', CAP + 1, 5);
        const anchor = buf.readBoundaryId!;
        // Clone the anchored line so the same id appears twice.
        const duplicate = { ...buf.lines[5]! };
        buf.lines.splice(6, 0, duplicate);
        expect(buf.lines.filter((l) => l.lineId === anchor).length).toBe(2);

        apiTrim(buf, CAP);
        expect(boundary(buf)).toEqual({ known: false, index: null });
    });
});
