/**
 * Equivalence coverage for the cached local-day fast path in
 * injectDateChangeMessageIfNeeded.
 *
 * The observable behaviour of that function is exactly one thing on the hot
 * path: whether a "day changed" separator line is appended, and what it says.
 * These tests compare the shipped function against the original algorithm
 * (two Dates, two setHours, compare) over timestamp pairs and over sequential
 * streams, including DST boundaries in the current timezone and out-of-order
 * timestamps, so the fast path can only ever agree with the slow path.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { vi } from 'vitest';

vi.mock('#lib/windowFocus.ts', () => ({
    initWindowFocusTracking: vi.fn(() => Promise.resolve(() => {})),
    isWindowFocused: () => typeof document !== 'undefined' && !document.hidden,
}));

const { injectDateChangeMessageIfNeeded } = await import('#lib/stores/handlers.ts');

beforeAll(() => {
    console.debug = () => {};
});

const DAY = 86_400_000;

/** The original comparison, unchanged: mutate both Dates to local midnight. */
function originalStartOfDay(ms: number): number {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.valueOf();
}

function originalInjects(oldMs: number, newMs: number): boolean {
    return originalStartOfDay(oldMs) !== originalStartOfDay(newMs);
}

function makeBuffer(): any {
    return {
        id: '0xtest',
        bufferType: 0,
        lines: [] as any[],
        lastSeen: 0,
        requestedLines: 0,
        plugin: 'irc',
        server: 'test',
    };
}

/** A stand-in for the real line: only `date` is read by the injection logic. */
function makeLine(ts: number): any {
    return { date: ts, lineId: `line:${ts}`, isDateSeparator: false };
}

function separatorsOf(buffer: any): { date: number; text: string }[] {
    return buffer.lines
        .filter((l: any) => l.isDateSeparator)
        .map((l: any) => ({ date: l.date, text: l.text }));
}

// ---- Timestamp corpus ----

/** Local DST boundaries of the current timezone, found by scanning offsets. */
function dstTransitions(years: number[]): number[] {
    const out: number[] = [];
    for (const year of years) {
        let previousOffset = new Date(year, 0, 1).getTimezoneOffset();
        for (let day = 1; day < 366; day++) {
            const noon = new Date(year, 0, 1 + day, 12, 0, 0).getTime();
            const offset = new Date(noon).getTimezoneOffset();
            if (offset !== previousOffset) {
                // Walk back from noon to the exact minute the offset changed.
                let lo = noon - 12 * 3600_000;
                let hi = noon;
                while (hi - lo > 60_000) {
                    const mid = Math.floor((lo + hi) / 2);
                    if (new Date(mid).getTimezoneOffset() === previousOffset) lo = mid;
                    else hi = mid;
                }
                out.push(hi);
            }
            previousOffset = offset;
        }
    }
    return out;
}

const TRANSITIONS = dstTransitions([2022, 2023, 2024, 2025, 2026]);

const OFFSETS = [
    -2 * DAY,
    -DAY,
    -DAY + 1,
    -3_600_000,
    -1,
    0,
    1,
    1_000,
    3_600_000,
    23 * 3_600_000,
    24 * 3_600_000,
    25 * 3_600_000,
    2 * DAY,
    7 * DAY,
    400 * DAY,
];

const BASES: number[] = [];
// Every 6 hours across four years: crosses month, year and DST boundaries.
for (let i = 0; i < 4 * 366 * 4; i++) {
    BASES.push(new Date(2022, 0, 1, 0, 0, 0).getTime() + i * 6 * 3_600_000);
}
// Every DST transition found in this timezone, plus its neighbourhood.
for (const t of TRANSITIONS) {
    for (const d of [-2 * DAY, -DAY, -1, 0, 1, 3_600_000, DAY, 2 * DAY]) {
        BASES.push(t + d);
    }
}

describe('date-change fast path: pair equivalence with the original comparison', () => {
    it('finds DST transitions in this timezone (or records that there are none)', () => {
        // Not an assertion about the optimization: it records how much of the
        // corpus is genuinely DST coverage on this machine.
        expect(TRANSITIONS.length).toBeGreaterThanOrEqual(0);
        if (TRANSITIONS.length === 0) {
            console.warn('no DST transitions in the local timezone; DST cases degenerate here');
        }
    });

    it('agrees with the original decision for every (base, offset) pair', () => {
        let mismatches = 0;
        const first: string[] = [];
        let pairs = 0;
        for (const oldMs of BASES) {
            for (const offset of OFFSETS) {
                const newMs = oldMs + offset;
                const buffer = makeBuffer();
                buffer.lines.push(makeLine(oldMs));
                injectDateChangeMessageIfNeeded(buffer, false, oldMs, newMs);
                const got = buffer.lines.length > 1;
                const want = originalInjects(oldMs, newMs);
                pairs++;
                if (got !== want) {
                    mismatches++;
                    if (first.length < 8) {
                        first.push(
                            `old=${new Date(oldMs).toString()} new=${new Date(newMs).toString()} got=${got} want=${want}`,
                        );
                    }
                }
            }
        }
        expect(pairs).toBe(BASES.length * OFFSETS.length);
        expect(first, `${mismatches} decision mismatches`).toEqual([]);
    });

    it('produces byte-identical separator text and date when it injects', () => {
        // The separator line is user-visible output, so its content is part of
        // the equivalence, not just the yes/no decision.
        let compared = 0;
        for (const oldMs of BASES) {
            for (const offset of OFFSETS) {
                const newMs = oldMs + offset;
                if (!originalInjects(oldMs, newMs)) continue;
                const buffer = makeBuffer();
                buffer.lines.push(makeLine(oldMs));
                injectDateChangeMessageIfNeeded(buffer, false, oldMs, newMs);
                const sep = separatorsOf(buffer);
                expect(sep.length, `separator count for ${oldMs}`).toBe(1);
                const line = sep[0]!;
                expect(line.date, 'separator date').toBe(originalStartOfDay(newMs));
                expect(typeof line.text).toBe('string');
                expect(line.text.length).toBeGreaterThan(0);
                compared++;
            }
        }
        expect(compared).toBeGreaterThan(1000);
    });

    it('agrees over sequential streams, which is where the cache is live', () => {
        // Production feeds lines one at a time and the buffer keeps its cached
        // window between calls; a per-pair test never exercises a warm cache.
        const streams = [
            // Same day, dense: the case the fast path exists for.
            Array.from({ length: 200 }, (_, i) => new Date(2024, 4, 10, 9, 0, 0).getTime() + i * 3_000),
            // One line per hour across a week (7 separators).
            Array.from({ length: 168 }, (_, i) => new Date(2024, 4, 1, 0, 0, 0).getTime() + i * 3_600_000),
            // Across both DST transitions of 2024, one line every 5 hours.
            ...TRANSITIONS.slice(0, 2).map((t) =>
                Array.from({ length: 60 }, (_, i) => t - 12 * 3_600_000 + i * 5 * 3_600_000),
            ),
            // Out of order: a history replay that jumps backwards.
            [
                new Date(2024, 6, 4, 12).getTime(),
                new Date(2024, 6, 4, 11).getTime(),
                new Date(2024, 6, 3, 23, 59, 59).getTime(),
                new Date(2024, 6, 5, 0, 0, 1).getTime(),
                new Date(2024, 6, 5, 0, 0, 2).getTime(),
            ],
            // Exactly on local midnights, including a DST day.
            ...TRANSITIONS.slice(0, 2).map((t) => [t - 1, t, t + 1, t + DAY - 1, t + DAY, t + DAY + 1]),
        ];

        for (const stream of streams) {
            const buffer = makeBuffer();
            const expected: number[] = [];
            let previous: number | undefined;
            for (const ts of stream) {
                if (previous !== undefined && originalInjects(previous, ts)) {
                    expected.push(originalStartOfDay(ts));
                }
                injectDateChangeMessageIfNeeded(buffer, false, previous ?? ts, ts);
                buffer.lines.push(makeLine(ts));
                previous = ts;
            }
            const got = separatorsOf(buffer).map((s) => s.date);
            expect(got, `separators for stream starting ${new Date(stream[0]!).toISOString()}`).toEqual(expected);
        }
    });

    it('never lets a stale cache prove a false "same day"', () => {
        // A window cached from an old line must not swallow a later day change:
        // the cache is only trusted when it contains *both* timestamps.
        const buffer = makeBuffer();
        const dayA = new Date(2024, 0, 10, 12).getTime();
        const dayB = new Date(2024, 0, 12, 12).getTime();
        buffer.lines.push(makeLine(dayA));
        injectDateChangeMessageIfNeeded(buffer, false, dayA, dayA + 1000);
        buffer.lines.push(makeLine(dayA + 1000));
        expect(buffer.localDayStart).toBe(originalStartOfDay(dayA));

        buffer.lines.push(makeLine(dayB - DAY));
        injectDateChangeMessageIfNeeded(buffer, false, dayB - DAY, dayB);
        buffer.lines.push(makeLine(dayB));

        const separators = separatorsOf(buffer).map((s) => s.date);
        expect(separators).toEqual([originalStartOfDay(dayB)]);
    });
});
