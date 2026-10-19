/**
 * What a trim leaves behind, measured on both places a trim runs.
 *
 * `trimBufferLines` is the shared copy. A second trim is inlined in
 * `setActiveBuffer`, worded differently: no `localUnread` compensation, and the
 * boundary re-anchored from `getReadBoundaryIndex()` instead of from the anchor
 * id and `lastSeen`.
 *
 * Both paths are pinned here with the same fixture — 12 lines against a cap of
 * 10 — over every way a read boundary can be recorded. Two cases land on
 * different numbers, and neither is a difference between the trims:
 *
 *   - no anchor id, boundary index below zero
 *   - boundary unknown after a reconnect
 *
 * In both, `getReadBoundaryIndex()` returns null, so `setActiveBuffer` resolves
 * a boundary of its own — from WeeChat's marker, or inferred from the hotlist
 * tally — before it trims. The inline trim is handed a boundary that the state
 * did not have. That is activation doing activation's job, and it is why the two
 * paths cannot be compared by giving them the same starting buffer: the inline
 * one only ever runs on a state activation has already normalised.
 *
 * That normalisation is also what makes the inline copy's missing `localUnread`
 * compensation unreachable: `setActiveBuffer` zeroes that counter for the buffer
 * it activates, and the inline trim only runs on that buffer.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { get } from 'svelte/store';
import {
    buffers, activeBufferId, createBuffer, createBufferLine,
    setActiveBuffer, setReadBoundary, setReadBoundaryUnknown, trimBufferLines,
} from '#lib/stores/models.ts';
import type { BufferData } from '#lib/types.ts';

vi.mock('#lib/stores/bufferResume.ts', () => ({
    shouldResume: vi.fn(() => false),
    getLastBuffer: vi.fn(() => null),
    recordLastBuffer: vi.fn(),
}));
vi.mock('#lib/notifications.ts', () => ({
    createHighlight: vi.fn(),
    playNotificationSound: vi.fn(),
    updateTitle: vi.fn(),
    updateFavico: vi.fn(),
    startIndicatorOwner: () => () => {},
    refreshIndicators: vi.fn(),
}));

const CAP = 10;
const LINES = 12;

function fixture(id: string): BufferData {
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
        // Counters at zero so activation cannot infer a boundary from a hotlist
        // tally and change the thing being measured.
        localUnread: 0,
        unread: 0,
        notification: 0,
        pendingReadBoundaryUnread: 0,
    };
    buf.lines = Array.from({ length: LINES }, (_, i) =>
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
    );
    return buf;
}

/**
 * The boundary as a position, so a failure reads as an index and not as a
 * line-identity string. `'no anchor'` is a boundary before every line,
 * `'no id recorded'` is the older shape that stores only an index.
 */
function outcome(buf: BufferData) {
    const anchor = buf.readBoundaryId === null
        ? 'no anchor'
        : buf.readBoundaryId === undefined
            ? 'no id recorded'
            : `index ${buf.lines.findIndex((line) => line.lineId === buf.readBoundaryId)}`;
    return {
        lines: buf.lines.length,
        known: buf.readBoundaryKnown === true,
        anchor,
        lastSeen: buf.lastSeen,
        allLinesFetched: buf.allLinesFetched,
    };
}

const SAME = { lines: 10, known: true, anchor: 'index 3', lastSeen: 3, allLinesFetched: false };

interface State {
    label: string;
    apply: (buf: BufferData) => void;
    /** Where the shared trim leaves the boundary. */
    shared: ReturnType<typeof outcome>;
    /** Where the trim inside `setActiveBuffer` leaves it. */
    activated: ReturnType<typeof outcome>;
}

const STATES: State[] = [
    {
        label: 'anchored on a line the trim keeps',
        apply: (buf) => setReadBoundary(buf, 5),
        shared: SAME,
        activated: SAME,
    },
    {
        label: 'anchored on a line the trim removes',
        apply: (buf) => setReadBoundary(buf, 0),
        shared: { lines: 10, known: true, anchor: 'no anchor', lastSeen: -1, allLinesFetched: false },
        activated: { lines: 10, known: true, anchor: 'no anchor', lastSeen: -1, allLinesFetched: false },
    },
    {
        label: 'boundary before every line',
        apply: (buf) => setReadBoundary(buf, -1),
        shared: { lines: 10, known: true, anchor: 'no anchor', lastSeen: -1, allLinesFetched: false },
        activated: { lines: 10, known: true, anchor: 'no anchor', lastSeen: -1, allLinesFetched: false },
    },
    {
        label: 'no anchor id, boundary held as an index',
        apply: (buf) => {
            setReadBoundary(buf, 4);
            buf.readBoundaryId = undefined;
        },
        shared: { lines: 10, known: true, anchor: 'index 2', lastSeen: 2, allLinesFetched: false },
        activated: { lines: 10, known: true, anchor: 'index 2', lastSeen: 2, allLinesFetched: false },
    },
    {
        label: 'no anchor id, boundary index below zero',
        apply: (buf) => {
            buf.readBoundaryKnown = true;
            buf.readBoundaryId = undefined;
            buf.lastSeen = -1;
        },
        shared: { lines: 10, known: true, anchor: 'no anchor', lastSeen: -1, allLinesFetched: false },
        // Activation resolved a boundary before trimming, so the trim was handed
        // the newest line rather than the absent one this state describes.
        activated: { lines: 10, known: true, anchor: 'index 9', lastSeen: 9, allLinesFetched: false },
    },
    {
        label: 'no anchor id, boundary index at the newest line',
        apply: (buf) => {
            buf.readBoundaryKnown = true;
            buf.readBoundaryId = undefined;
            buf.lastSeen = LINES - 1;
        },
        shared: { lines: 10, known: true, anchor: 'index 9', lastSeen: 9, allLinesFetched: false },
        activated: { lines: 10, known: true, anchor: 'index 9', lastSeen: 9, allLinesFetched: false },
    },
    {
        label: 'no anchor id, boundary index past the retained window',
        apply: (buf) => {
            buf.readBoundaryKnown = true;
            buf.readBoundaryId = undefined;
            buf.lastSeen = LINES + 7;
        },
        shared: { lines: 10, known: true, anchor: 'index 9', lastSeen: 9, allLinesFetched: false },
        activated: { lines: 10, known: true, anchor: 'index 9', lastSeen: 9, allLinesFetched: false },
    },
    {
        label: 'boundary unknown after a reconnect',
        apply: (buf) => setReadBoundaryUnknown(buf),
        shared: { lines: 10, known: false, anchor: 'no anchor', lastSeen: -1, allLinesFetched: false },
        // Same as above: activation resolved the unknown boundary first, so the
        // inline trim ran on a known one.
        activated: { lines: 10, known: true, anchor: 'index 9', lastSeen: 9, allLinesFetched: false },
    },
];

describe('what a trim leaves behind, on both places a trim runs', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        buffers.set({});
        activeBufferId.set('');
    });

    for (const [i, state] of STATES.entries()) {
        it(`shared trim: ${state.label}`, () => {
            const buf = fixture(`0xC${i}`);
            state.apply(buf);
            trimBufferLines(buf, CAP);
            expect(outcome(buf), state.label).toEqual(state.shared);
        });

        it(`inside setActiveBuffer: ${state.label}`, () => {
            const id = `0xC${i}`;
            const buf = fixture(id);
            state.apply(buf);
            buffers.set({ [id]: buf });
            setActiveBuffer(id);
            expect(outcome(get(buffers)[id]!), state.label).toEqual(state.activated);
        });
    }
});
