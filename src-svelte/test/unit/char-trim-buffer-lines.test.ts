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
import { trimBufferLines as apiTrim } from '#lib/stores/models.ts';
import type { BufferData, ProtocolMessage } from '#lib/types.ts';

// Characterization tests for the line trim: what dropping the oldest rows past a
// buffer's cap owes the counters.
//
// One copy is left: `trimBufferLines` in models.ts, reached here through the
// legacy line handler and through the API reducers — which each used to carry a
// byte-identical copy of it — and through `setActiveBuffer`, which used to carry
// a third, worded differently, with no `localUnread` compensation at all.
// `trim-boundary-outcomes.test.ts` is where that third copy was measured before
// it was folded in.
//
// A fourth disagreement used to be recorded here: the copies also differed about
// `requestedLines` — two subtracted the removed lines, one only clamped. That
// field turned out to be write-only: nothing read it, and a page is sized from the
// request argument and the buffer's own history limit. It was removed rather than
// harmonised.
//
// Each test runs the same scenario — a buffer holding more lines than its own cap
// — through one of the paths, and records where the counters land. These pin
// today's behaviour; they are not a claim that it is correct. Two of them record
// arithmetic that looks wrong on purpose, so that a later change is measured
// against something instead of against a guess.

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

const { handleBufferLineAdded } = await import('#lib/stores/handlers.ts');

const CAP = 10;

/** A channel whose own cap is CAP, with the counters a real buffer would carry. */
function fixture(id: string, lineCount: number, localUnread = 3): BufferData {
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
        localUnread,
        lines: Array.from({ length: lineCount }, (_, i) =>
            createBufferLine({
                buffer: id,
                date: 1_700_000_000 + i,
                prefix: 'nick',
                message: `line ${i}`,
                tags_array: ['irc_privmsg'],
                displayed: 1,
                notify_level: 1,
                highlight: 0,
            }),
        ),
    };
    // Anchor the boundary on a line that survives a one-line trim, so the
    // boundary tests are about re-anchoring and not about losing the anchor.
    setReadBoundary(buf, 5);
    return buf;
}

function lineAdded(id: string, message: string): ProtocolMessage {
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
                        message,
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
 * The legacy trim is module-private and runs at the end of handleBufferLineAdded,
 * so the scenario has to arrive the way the transport delivers it: a buffer that
 * is already over its cap receives one more live line.
 */
function legacyTrim(id: string, buf: BufferData): BufferData {
    buffers.set({ [id]: buf });
    // Active, so the incoming line is not itself tallied as localUnread and the
    // only localUnread movement left is the trim's.
    activeBufferId.set(id);
    handleBufferLineAdded(lineAdded(id, 'one line too many'));
    return get(buffers)[id]!;
}

describe('the line trim and what it owes the counters', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        buffers.set({});
        activeBufferId.set('');
    });

    it('16 lines against a cap of 10: all three paths land on the cap', () => {
        // The part they agree on, and the reason the disagreement below was worth
        // measuring at all: same scenario, same retained window.
        const apiBuf = fixture('0xA00', 16);
        apiTrim(apiBuf, CAP);

        // Legacy arrives as the transport delivers it: 15 held, one live line, 16
        // against a cap of 10.
        const legacyAfter = legacyTrim('0xA01', fixture('0xA01', 15));

        const inlineBuf = fixture('0xA02', 16);
        buffers.set({ '0xA02': inlineBuf });
        setActiveBuffer('0xA02');
        const inlineAfter = get(buffers)['0xA02']!;

        expect([apiBuf.lines.length, legacyAfter.lines.length, inlineAfter.lines.length])
            .toEqual([CAP, CAP, CAP]);
    });

    it('legacy and API compensate localUnread for the removed prefix — and subtract more lines than were unread', () => {
        // localUnread tracks the newest lines; a trim removes the oldest. With 11
        // lines and localUnread 5 the unread tail is indices 6..10, so dropping
        // index 0 should leave localUnread at 5. Both copies compute
        // overlap = min(linesToRemove, unreadStartIndex) = min(1, 6) = 1 and
        // subtract it anyway, landing on 4. Pinned because a fix has to say
        // which side of this it lands on.
        const apiBuf = fixture('0xA03', 11, 5);
        apiTrim(apiBuf, CAP);

        const legacyAfter = legacyTrim('0xA04', fixture('0xA04', 10, 5));

        expect(apiBuf.localUnread).toBe(4);
        expect(legacyAfter.localUnread).toBe(4);
    });

    it('activating a buffer zeroes localUnread, so the trim there compensates nothing', () => {
        // setActiveBuffer zeroes localUnread for the buffer it activates, and the
        // trim inside it only ever runs on that same buffer. So a missing
        // compensation is masked: the activation path reaches the same 0 for a
        // reason that has nothing to do with the trim.
        //
        // That is what made folding the inlined copy into the shared one safe
        // instead of something to fix first — it changed no observable number.
        const buf = fixture('0xA05', 11, 5);
        buffers.set({ '0xA05': buf });
        setActiveBuffer('0xA05');

        const after = get(buffers)['0xA05']!;
        expect(after.lines.length).toBe(CAP);
        expect(after.localUnread).toBe(0);

        // Proof that the zero came from activation and not from the trim: the
        // same buffer, same counters, trimmed directly instead, keeps 4.
        const control = fixture('0xA06', 11, 5);
        apiTrim(control, CAP);
        expect(control.localUnread).toBe(4);
    });

    it('all three paths re-anchor a surviving boundary to the same index', () => {
        // The part they agree on: when the anchor line survives the trim, the
        // boundary follows it to its new index rather than drifting.
        const apiBuf = fixture('0xB00', 11);
        const apiAnchor = apiBuf.readBoundaryId;
        apiTrim(apiBuf, CAP);

        const legacyBuf = fixture('0xB01', 10);
        const legacyAnchor = legacyBuf.readBoundaryId;
        const legacyAfter = legacyTrim('0xB01', legacyBuf);

        const inlineBuf = fixture('0xB02', 11);
        buffers.set({ '0xB02': inlineBuf });
        const inlineAnchor = inlineBuf.readBoundaryId;
        setActiveBuffer('0xB02');
        const inlineAfter = get(buffers)['0xB02']!;

        expect(apiBuf.readBoundaryId).toBe(apiAnchor);
        expect(legacyAfter.readBoundaryId).toBe(legacyAnchor);
        expect(inlineAfter.readBoundaryId).toBe(inlineAnchor);
        expect([
            getReadBoundaryIndex(apiBuf),
            getReadBoundaryIndex(legacyAfter),
            getReadBoundaryIndex(inlineAfter),
        ]).toEqual([4, 4, 4]);
    });

    it('a capped buffer that keeps receiving reports the same unread count forever', () => {
        // The clearest consequence of the overlap formula. Measured on its own it
        // looked like the reason the trim was more than tidiness — and it is not. The
        // badge this tally feeds is max(localUnread, unread + notification), and
        // e2e/specs/UnreadBadge-cappedBuffer.test.ts measured a buffer trimmed to
        // its cap and a buffer left shallow reporting the same count for the same
        // unread traffic. This test pins the frozen local tally; that spec pins
        // that nobody can see it.
        //
        // `localUnread` counts the NEWEST lines: a live line is pushed to the end of
        // `lines` and the counter is incremented immediately after (handlers.ts:549
        // and :567). A trim removes the OLDEST. The two sets therefore overlap only
        // when the trim reaches as far as the unread tail — but the formula is
        //
        //     overlap = min(linesToRemove, unreadStartIndex)
        //
        // which is the opposite condition. It subtracts precisely when the removed
        // prefix and the unread tail are disjoint, and subtracts nothing when the
        // trim really does eat into the tail.
        //
        // On a buffer sitting at its cap every arrival forces a one-line trim, so
        // each message adds an unread line and immediately cancels it: the count
        // never moves however many messages arrive.
        const id = '0xB00';
        buffers.set({ [id]: fixture(id, CAP, 3) });
        // Neither test buffer is on screen: handlers.ts:560 skips the unread tally
        // for the active buffer entirely, so an active control buffer would report
        // 3 for a reason that has nothing to do with the trim.
        activeBufferId.set('0xON_SCREEN');

        const atCap: number[] = [];
        const lengths: number[] = [];
        for (let i = 0; i < 5; i++) {
            handleBufferLineAdded(lineAdded(id, `arrival ${i}`));
            const buf = get(buffers)[id]!;
            lengths.push(buf.lines.length);
            atCap.push(buf.localUnread);
        }

        // The same five arrivals on a buffer with room: no trim runs, and the
        // counter behaves. This is what the capped run above should have looked like.
        const roomId = '0xB01';
        buffers.set({ ...get(buffers), [roomId]: fixture(roomId, 5, 3) });
        const withRoom: number[] = [];
        for (let i = 0; i < 5; i++) {
            handleBufferLineAdded(lineAdded(roomId, `arrival ${i}`));
            withRoom.push(get(buffers)[roomId]!.localUnread);
        }

        expect(lengths, 'the capped buffer holds exactly its cap, so every arrival is kept').toEqual([CAP, CAP, CAP, CAP, CAP]);
        expect(withRoom, 'a buffer with room counts every arrival').toEqual([4, 5, 6, 7, 8]);
        expect(atCap, 'the capped buffer counts none of them, and is frozen where it started').toEqual([3, 3, 3, 3, 3]);
    });
});
