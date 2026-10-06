/**
 * Direct equivalence test for the shortTime change in createBufferLine.
 *
 * createBufferLine now formats the line's HH:MM with a module-level
 * Intl.DateTimeFormat instead of date.toLocaleTimeString("en-US", {...}).
 * This test compares the produced string against the original expression for
 * every variant the change actually touches: all 1440 minute values, DST
 * boundaries of the current timezone, epoch edges, out-of-range dates, and
 * invalid dates (where Intl.DateTimeFormat.format would throw and the built-in
 * returns "Invalid Date").
 */
import { describe, expect, it } from 'vitest';
import { createBufferLine, formatShortTime } from '#lib/stores/models.ts';

const ORIGINAL_EXPR = (d: Date): string =>
    d.toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    });

function shortTimeFor(dateValue: number): string {
    return createBufferLine({
        buffer: "0x1",
        date: dateValue,
        date_long: 0,
        prefix: "nick",
        message: "text",
        tags_array: ["irc_privmsg"],
        displayed: 1,
        notify_level: 1,
        highlight: 0,
        id: 1,
        bufferType: "channel",
    }).shortTime;
}

/** Timestamps whose local UTC offset differs from the reference — i.e. DST edges. */
function dstBoundaryTimestamps(): number[] {
    const out: number[] = [];
    const reference = new Date(2024, 0, 1).getTimezoneOffset();
    // Walk every hour of 2024 (and 2023 for a second year) and keep the hour
    // before and after every offset change.
    for (const year of [2023, 2024]) {
        let prev = reference;
        for (let ms = new Date(year, 0, 1).getTime(); ms < new Date(year + 1, 0, 1).getTime(); ms += 3_600_000) {
            const off = new Date(ms).getTimezoneOffset();
            if (off !== prev) {
                out.push(ms - 3_600_000, ms);
            }
            prev = off;
        }
    }
    return out;
}

describe("createBufferLine shortTime equivalence", () => {
    it("matches date.toLocaleTimeString for every minute of a day", () => {
        const base = new Date(2024, 5, 21, 0, 0, 0).getTime();
        for (let m = 0; m < 1440; m++) {
            const ts = base + m * 60_000;
            expect(shortTimeFor(ts), `minute ${m}`).toBe(ORIGINAL_EXPR(new Date(ts)));
        }
    });

    it("matches across DST boundaries of the current timezone", () => {
        const edges = dstBoundaryTimestamps();
        expect(edges.length, "expected at least one DST boundary in the test years").toBeGreaterThan(0);
        for (const ts of edges) {
            expect(shortTimeFor(ts), `dst edge ${new Date(ts).toString()}`).toBe(
                ORIGINAL_EXPR(new Date(ts)),
            );
        }
    });

    it("matches for every hour-of-day across a full year", () => {
        const start = new Date(2024, 0, 1, 0, 0, 0).getTime();
        for (let h = 0; h < 24 * 366; h++) {
            const ts = start + h * 3_600_000 + 1_234; // off the exact minute boundary
            expect(shortTimeFor(ts), `hour ${h}`).toBe(ORIGINAL_EXPR(new Date(ts)));
        }
    });

    it("matches for epoch edges and out-of-range dates", () => {
        const cases = [
            0,
            -1,
            -86_400_000,
            1,
            999,
            1000,
            2147483647000, // > 32-bit ms range
            -2147483648000,
            4_102_444_800_000, // year 2100
            253402300799999, // near the Date maximum
        ];
        for (const ts of cases) {
            expect(shortTimeFor(ts), `ts ${ts}`).toBe(ORIGINAL_EXPR(new Date(ts)));
        }
    });

    it("keeps the built-in 'Invalid Date' behaviour for a non-numeric date", () => {
        // Intl.DateTimeFormat.format(new Date(NaN)) throws RangeError; the
        // previous code returned "Invalid Date". The guard must preserve that.
        expect(shortTimeFor(Number.NaN)).toBe("Invalid Date");
    });

    it("keeps the numeric date field identical to the input", () => {
        for (const ts of [0, 1_700_000_000_000, -5, 2147483647000]) {
            expect(createBufferLine({
                buffer: "0x1",
                date: ts,
                prefix: "n",
                message: "m",
                tags_array: [],
                displayed: 1,
                highlight: 0,
                id: 1,
            }).date).toBe(new Date(ts).getTime());
        }
    });
});

describe("formatShortTime equivalence (the changed helper itself)", () => {
    it("uses the manual branch on this platform (h23 hour cycle)", () => {
        // The manual path is only taken when en-US + hour12:false resolves to the
        // h23 cycle. Pinning which branch is live keeps the benchmark honest: a
        // measurement that never executed the new code is not a result.
        const cycle = new Intl.DateTimeFormat("en-US", {
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
        }).resolvedOptions().hourCycle;
        expect(cycle).toBe("h23");
    });

    it(
        "matches the original expression over a 200k-date sweep",
        () => {
            // Collecting mismatches instead of asserting per iteration keeps the
            // sweep cheap enough to stay inside the test timeout while still
            // covering every hour/minute combination the sweep reaches.
            const mismatches: string[] = [];
            let checked = 0;
            for (let i = 0; i < 200_000; i++) {
                const d = new Date(1970 + (i % 55), i % 12, 1 + (i % 28), 0, 0, 0, (i * 97) % 86_400_000);
                const got = formatShortTime(d, d.getTime());
                const want = ORIGINAL_EXPR(d);
                if (got !== want) {
                    mismatches.push(`#${i} ${d.toISOString()}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
                }
                checked++;
            }
            expect(checked).toBe(200_000);
            expect(mismatches.slice(0, 10), `${mismatches.length} mismatches`).toEqual([]);
        },
        60_000,
    );

    it("matches for every hour and minute of a day, including zero padding", () => {
        for (let h = 0; h < 24; h++) {
            for (let m = 0; m < 60; m++) {
                const d = new Date(2024, 5, 21, h, m, 0);
                expect(formatShortTime(d, d.getTime()), `h${h} m${m}`).toBe(ORIGINAL_EXPR(d));
            }
        }
        expect(formatShortTime(new Date(2024, 0, 1, 0, 0, 0), 0)).toBe("00:00");
    });

    it("keeps 'Invalid Date' for a NaN time value", () => {
        const d = new Date(Number.NaN);
        expect(formatShortTime(d, Number.NaN)).toBe("Invalid Date");
    });
});
