/**
 * Robustness tests: malformed input, truncated prefixes, seeded randomized
 * input, and the invariants every parse must satisfy.
 */

import { describe, expect, it } from 'vitest';
import { parseWeeChatText } from '../src/parse.js';
import { MAX_EXTENDED_COLOR, MAX_THEME_COLOR, MAX_WEECHAT_COLOR, THEME_COLORS, WEECHAT_PALETTE } from '../src/index.js';
import type { ParseDiagnostic } from '../src/types.js';
import { CTL } from './helpers/ctl.js';

/** Deterministic PRNG (mulberry32) so failures are reproducible. */
function rng(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function pick<T>(random: () => number, values: readonly T[]): T {
    const value = values[Math.floor(random() * values.length)];
    if (value === undefined) {
        throw new Error('empty choice set');
    }
    return value;
}

/** Assert the invariants every parse result must satisfy. */
function expectValidParse(input: string, diagnostics: ParseDiagnostic[]): void {
    const runs = parseWeeChatText(input, { onDiagnostic: (d) => diagnostics.push(d) });

    for (const run of runs) {
        // Runs are non-empty text containing no control characters.
        expect(run.text.length).toBeGreaterThan(0);
        for (let i = 0; i < run.text.length; i++) {
            const code = run.text.charCodeAt(i);
            expect(code >= 0x19 && code <= 0x1c).toBe(false);
        }

        // Color references stay in range.
        for (const color of [run.style.fg, run.style.bg]) {
            switch (color.kind) {
            case 'weechat':
                expect(WEECHAT_PALETTE).toContain(color.name);
                expect(WEECHAT_PALETTE.indexOf(color.name)).toBeLessThanOrEqual(MAX_WEECHAT_COLOR);
                break;
            case 'extended':
                expect(Number.isInteger(color.value)).toBe(true);
                expect(color.value).toBeGreaterThanOrEqual(1);
                expect(color.value).toBeLessThanOrEqual(MAX_EXTENDED_COLOR);
                break;
            case 'theme':
                expect(color.index).toBeGreaterThanOrEqual(0);
                expect(color.index).toBeLessThanOrEqual(MAX_THEME_COLOR);
                expect(THEME_COLORS[color.index]).toBe(color.name);
                break;
            case 'default':
                break;
            }
        }
    }

    // Emitted text is a subsequence of the input: nothing is invented.
    const emitted = runs.map((run) => run.text).join('');
    let cursor = 0;
    for (const char of emitted) {
        const found = input.indexOf(char, cursor);
        expect(found).toBeGreaterThanOrEqual(cursor);
        cursor = found + 1;
    }
    expect(emitted.length).toBeLessThanOrEqual(input.length);

    // Diagnostics stay in bounds and always consume at least one unit.
    for (const diagnostic of diagnostics) {
        expect(diagnostic.offset).toBeGreaterThanOrEqual(0);
        expect(diagnostic.offset).toBeLessThan(input.length);
        expect(diagnostic.consumed).toBeGreaterThanOrEqual(1);
        expect(diagnostic.offset + diagnostic.consumed).toBeLessThanOrEqual(input.length);
    }
}

describe('truncated prefixes of valid sequences', () => {
    const sequences = [
        `${CTL.color}F03`,
        `${CTL.color}F@00012`,
        `${CTL.color}F*|00012`,
        `${CTL.color}B04`,
        `${CTL.color}B@00034`,
        `${CTL.color}*01,02`,
        `${CTL.color}*01~02`,
        `${CTL.color}*@00012~@00034`,
        `${CTL.color}03`,
        `${CTL.color}@01234`,
        `${CTL.color}E`,
        `${CTL.color}bF`,
        `${CTL.color}${CTL.reset}`,
        `${CTL.setAttr}${CTL.attrBold}`,
        `${CTL.removeAttr}${CTL.attrDim}`,
        CTL.reset,
    ];

    for (const sequence of sequences) {
        for (let length = 0; length < sequence.length; length++) {
            const prefix = sequence.slice(0, length);
            it(`parses ${JSON.stringify(prefix)} without throwing`, () => {
                const diagnostics: ParseDiagnostic[] = [];
                expect(() => parseWeeChatText(`${prefix}tail`, { onDiagnostic: (d) => diagnostics.push(d) })).not.toThrow();
                expectValidParse(`${prefix}tail`, diagnostics);
            });
        }
    }
});

describe('malformed control soup', () => {
    const inputs = [
        CTL.color.repeat(50),
        `${CTL.color}FFFFFFFFFF`,
        `${CTL.color}@@@@@@@@@@`,
        `${CTL.color}**********`,
        `${CTL.color}F||||||||||`,
        `${CTL.color}F%%%%%%%%%%%`,
        `${CTL.color}b`.repeat(50),
        `${CTL.setAttr}${CTL.removeAttr}${CTL.setAttr}${CTL.removeAttr}`,
        `${CTL.color}0`.repeat(100),
        `${CTL.color}*,*~,@,~`,
        `${CTL.color}F${'!'.repeat(200)}03`,
        `${CTL.color}E`.repeat(200),
    ];

    for (const input of inputs) {
        it(`terminates and preserves text for ${input.slice(0, 24)}…`, () => {
            const diagnostics: ParseDiagnostic[] = [];
            parseWeeChatText(input, { onDiagnostic: (d) => diagnostics.push(d) });
            expectValidParse(input, diagnostics);
        });
    }

    it('makes forward progress on a long malformed attribute run', () => {
        // A pathological run must not backtrack: the parse stays linear.
        const input = `${CTL.color}F${'*'.repeat(100000)}03text`;
        const started = Date.now();
        const runs = parseWeeChatText(input);
        expect(Date.now() - started).toBeLessThan(2000);
        expect(runs.map((run) => run.text)).toEqual(['text']);
    });
});

describe('seeded randomized input', () => {
    const alphabet = [
        'a', 'b', 'z', ' ', '!', '0', '1', '9', '@', 'F', 'B', '*', 'E', 'b', ',', '~', '|',
        '%', '.', '/', '_', '#', '-', 'i', 'l', 's', 'x', 'é', 'ø', '日', '😀',
        CTL.color, CTL.setAttr, CTL.removeAttr, CTL.reset,
        CTL.attrBold, CTL.attrItalic, CTL.attrDim,
    ];

    for (const seed of [1, 7, 42, 1337, 90210, 2468013579]) {
        it(`parses deterministically for seed ${seed}`, () => {
            const random = rng(seed);
            for (let caseIndex = 0; caseIndex < 200; caseIndex++) {
                const length = 1 + Math.floor(random() * 40);
                let input = '';
                for (let i = 0; i < length; i++) {
                    input += pick(random, alphabet);
                }
                const diagnostics: ParseDiagnostic[] = [];
                const first = parseWeeChatText(input, { onDiagnostic: (d) => diagnostics.push(d) });
                expectValidParse(input, diagnostics);

                // Determinism: the same input always produces the same runs.
                const second = parseWeeChatText(input);
                expect(second).toEqual(first);
            }
        });
    }
});

describe('deterministic combinations', () => {
    const foregrounds = ['', `${CTL.color}F01`, `${CTL.color}F16`, `${CTL.color}F@00012`, `${CTL.color}F*03`, `${CTL.color}F|04`];
    const backgrounds = ['', `${CTL.color}B02`, `${CTL.color}B@00034`];
    const combined = ['', `${CTL.color}*01~02`, `${CTL.color}*@00012~@00034`];
    const attributes = ['', `${CTL.setAttr}${CTL.attrBold}`, `${CTL.removeAttr}${CTL.attrBold}`];
    const tails = ['', `${CTL.color}${CTL.reset}`, CTL.reset, `${CTL.color}E`];

    it('covers the full color/attribute/reset matrix deterministically', () => {
        const seen = new Set<string>();
        let cases = 0;
        for (const fg of foregrounds) {
            for (const bg of backgrounds) {
                for (const combo of combined) {
                    for (const attr of attributes) {
                        for (const tail of tails) {
                            const input = `${fg}${bg}${combo}${attr}${tail}text`;
                            const diagnostics: ParseDiagnostic[] = [];
                            const first = parseWeeChatText(input, { onDiagnostic: (d) => diagnostics.push(d) });
                            expectValidParse(input, diagnostics);
                            expect(parseWeeChatText(input)).toEqual(first);
                            seen.add(JSON.stringify(first.map((run) => [run.text, run.style])));
                            cases++;
                        }
                    }
                }
            }
        }
        expect(cases).toBe(foregrounds.length * backgrounds.length * combined.length * attributes.length * tails.length);
        // The matrix must actually distinguish styles rather than collapse to a
        // handful of shapes (many combinations legitimately override each other).
        expect(seen.size).toBeGreaterThan(50);
    });
});
describe('large input', () => {
    it('parses a long message without pathological behavior', () => {
        const unit = `${CTL.color}F03red${CTL.color}${CTL.reset} plain ${CTL.color}*01~02both `;
        const input = unit.repeat(5000);
        const started = Date.now();
        const runs = parseWeeChatText(input);
        expect(Date.now() - started).toBeLessThan(3000);
        expect(runs.length).toBeGreaterThan(1);
        const total = runs.reduce((sum, run) => sum + run.text.length, 0);
        expect(total).toBeLessThanOrEqual(input.length);
    });
});
