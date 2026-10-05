/**
 * Two suites over one ledger: `oracle/divergences.json`.
 *
 * The ledger suite always runs. It needs nothing but the library and the ledger:
 * every documented divergence must still diverge in the library, by the extents
 * the ledger records, and the synthetic cases that show a documented divergence
 * cannot excuse a later one must still hold.
 *
 * The oracle suite runs only when the generated artifacts are on disk. WeeChat's
 * scanner (`gui_color_code_size()`, src/gui/gui-color.c:609-772) is vendored in
 * `oracle/weechat_color_scan.c`, and `npm run oracle` compiles it to produce
 * `oracle/corpus.txt` and `oracle/weechat-oracle.txt`. All three are local
 * artifacts, deliberately untracked: the repo carries the ledger, not 700 KB of
 * generated evidence. Regenerate them locally (`npm run oracle`, needs `cc`) and
 * this suite then compares every corpus input against the scanner itself.
 *
 * Where scanner and renderer disagree the library follows the renderer, and every
 * such disagreement is enumerated in the ledger. A mismatch that fits no rule
 * fails, a rule that stops occurring fails, and a corpus or oracle file that no
 * longer lines up fails.
 *
 * Scope: consumption extents over an ASCII corpus. Style application is covered by
 * the other suites; Unicode by `test/unicode.test.ts`.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decodeAt } from '../src/decode.js';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const oracleDir = path.join(packageDir, 'oracle');

const scannerPath = path.join(oracleDir, 'weechat_color_scan.c');
const corpusPath = path.join(oracleDir, 'corpus.txt');
const oraclePath = path.join(oracleDir, 'weechat-oracle.txt');
const artifactPaths = [scannerPath, corpusPath, oraclePath];
const artifactsPresent = artifactPaths.every((file) => existsSync(file));

const COLOR = 0x19;
const SET_ATTR = 0x1a;
const REMOVE_ATTR = 0x1b;
const DIGITS = '0123456789';

type Extent = [number, number];

interface OracleRow {
    hex: string;
    input: string;
    scanner: Extent[];
}

interface DivergenceRule {
    id: string;
    example: { input: string; scanner: Extent[]; library: Extent[] };
}

const header = new Map<string, string>();
const rows: OracleRow[] = [];
const malformed: string[] = [];
const corpusHex: string[] = [];

if (artifactsPresent) {
    for (const line of readFileSync(oraclePath, 'utf8').split('\n')) {
        if (line.length === 0) {
            continue;
        }
        if (line.startsWith('# ')) {
            const columns = line.slice(2).split(': ');
            const key = columns[0];
            const value = columns[1];
            if (key !== undefined && value !== undefined) {
                header.set(key, value);
            }
            continue;
        }
        const columns = line.split('\t');
        const hex = columns[0] ?? '';
        const extents = columns[1];
        if (extents === undefined || hex.length % 2 !== 0 || /[^0-9a-f]/.test(hex)
            || (extents.length > 0 && !/^\d+:\d+(,\d+:\d+)*$/.test(extents))) {
            malformed.push(line);
            continue;
        }
        rows.push({
            hex,
            input: Buffer.from(hex, 'hex').toString('utf8'),
            scanner: extents.length > 0
                ? extents.split(',').map((entry): Extent => {
                    const parts = entry.split(':');
                    return [Number(parts[0]), Number(parts[1])];
                })
                : [],
        });
    }

    corpusHex.push(...readFileSync(corpusPath, 'utf8')
        .split('\n')
        .filter((line) => line.length > 0));
}

const rules: DivergenceRule[] = JSON.parse(
    readFileSync(path.join(oracleDir, 'divergences.json'), 'utf8')
).rules;

/** Walk an input the way the library does, collecting (offset, consumed) pairs. */
function libraryExtents(input: string): Extent[] {
    const extents: Extent[] = [];
    let offset = 0;
    while (offset < input.length) {
        const result = decodeAt(input, offset);
        if (result === null || result.consumed <= 0) {
            offset += 1;
            continue;
        }
        extents.push([offset, result.consumed]);
        offset += result.consumed;
    }
    return extents;
}

/**
 * Name the rule that explains the scanner consuming exactly one unit more than the
 * library at the same start, or null when nothing covers it. The signature is
 * deliberately narrow.
 */
function classifyMismatch(input: string, theirs: Extent, ours: Extent): string | null {
    const [offset, size] = theirs;
    if (offset !== ours[0] || size !== ours[1] + 1) {
        return null;
    }
    const control = input.charAt(offset);
    const extra = size - 1;
    const extraChar = input.charAt(offset + extra);
    const remaining = input.length - (offset + extra + 1);

    if (control === '\u001a' || control === '\u001b') {
        return 'attr-payload-unsupported';
    }
    if (extraChar === '@' && remaining < 5) {
        if (control === '\u0019' && input.charAt(offset + 1) === 'B') {
            return 'bg-extended-truncated';
        }
        const separator = input.charAt(offset + extra - 1);
        if (control === '\u0019' && input.charAt(offset + 1) === '*'
            && (separator === ',' || separator === '~')) {
            return 'combined-bg-extended-truncated';
        }
    }
    return null;
}

/** True when a \u001a/\u001b extent from the scanner covers this offset. */
function swallowedByAttrControl(scanner: Extent[], input: string, offset: number): boolean {
    return scanner.some(([start, size]) => start < offset && offset < start + size
        && (input.charCodeAt(start) === SET_ATTR || input.charCodeAt(start) === REMOVE_ATTR));
}

/**
 * Explain every difference between the library's extents and the scanner's, or
 * return null. Extents are matched by start offset rather than by list position,
 * so a documented divergence cannot excuse a later, unrelated one.
 */
function explain(input: string, scanner: Extent[], library: Extent[]): Set<string> | null {
    const rulesUsed = new Set<string>();
    const scannerByStart = new Map<number, Extent>(scanner.map((extent) => [extent[0], extent]));
    const libraryByStart = new Map<number, number>(library.map(([start, size]) => [start, size]));

    for (const [offset, ours] of libraryByStart) {
        const theirs = scannerByStart.get(offset);
        if (theirs === undefined) {
            if (!swallowedByAttrControl(scanner, input, offset)) {
                return null;
            }
            rulesUsed.add('attr-payload-unsupported');
            continue;
        }
        if (theirs[1] === ours) {
            continue;
        }
        const rule = classifyMismatch(input, theirs, [offset, ours]);
        if (rule === null) {
            return null;
        }
        rulesUsed.add(rule);
    }

    // A control the scanner recognizes must either be one the library also starts
    // an extent at, or lie inside a region the library already consumed.
    for (const [offset] of scanner) {
        if (libraryByStart.has(offset)) {
            continue;
        }
        if (library.some(([start, size]) => start <= offset && offset < start + size)) {
            continue;
        }
        if (!swallowedByAttrControl(scanner, input, offset)) {
            return null;
        }
        rulesUsed.add('attr-payload-unsupported');
    }

    return rulesUsed;
}

describe('consumption ledger', () => {
    it('documents divergences that still diverge the way they are written', () => {
        for (const rule of rules) {
            expect(libraryExtents(rule.example.input), `library extents for ${rule.id}`)
                .toEqual(rule.example.library);
            // The ledger is a list of divergences, so an example whose recorded
            // scanner extents match the library's is a divergence that no longer
            // exists — the same failure the oracle suite reports, without the oracle.
            expect(JSON.stringify(rule.example.scanner) !== JSON.stringify(rule.example.library),
                `example for ${rule.id} no longer diverges`).toBe(true);
        }
    });

    it('has all or none of the generated oracle artifacts', () => {
        // A half-present state would silently drop the corpus comparison, so it fails
        // here instead. Regenerate all three with `npm run oracle`, or none.
        expect(artifactPaths.filter((file) => existsSync(file)).length).toBe(artifactsPresent ? 3 : 0);
    });

    it('does not let a documented divergence excuse a later one', () => {
        const input = '\u001a*\u0019B@';
        const ours = libraryExtents(input);
        expect(ours).toEqual([[0, 1], [2, 2]]);

        const documented = explain(input, [[0, 2], [2, 3]], ours);
        expect(documented).not.toBeNull();
        expect([...documented!].sort()).toEqual(['attr-payload-unsupported', 'bg-extended-truncated']);

        expect(explain(input, [[0, 2], [2, 5]], ours)).toBeNull();
        expect(explain(input, [[0, 2], [2, 3], [4, 1]], ours)).toBeNull();
        expect(explain('\u0019F03', [[0, 5]], [[0, 4]])).toBeNull();
    });

    it('keeps the scanner/renderer desynchronization case as a regression', () => {
        // The scanner swallows the \u0019 that follows \u001a, so it never sees the
        // combined control the renderer — and the library — does apply.
        const input = '\u001a \u001a\u0019*i\u001b';
        const ours = libraryExtents(input);
        expect(ours).toEqual([[0, 1], [2, 1], [3, 4]]);
        const used = explain(input, [[0, 2], [2, 2], [6, 1]], ours);
        expect(used).not.toBeNull();
        expect([...used!].sort()).toEqual(['attr-payload-unsupported']);
        // The scanner's own walk never sees the combined control at all.
        expect(explain(input, [[0, 2], [2, 2]], ours)).not.toBeNull();
    });
});

if (artifactsPresent) {
    describe('consumption oracle', () => {
        it('compares against the vendored scanner the oracle was generated from', () => {
            const source = readFileSync(scannerPath, 'utf8');
            expect(createHash('sha256').update(source).digest('hex')).toBe(header.get('Vendored source sha256'));
            expect(source).toContain('WeeChat 4.10.1');
            expect(source).toContain('src/gui/gui-color.c:609-772');
            expect(source).toContain('GPL-3.0-or-later');
        });

        it('compares against the corpus the oracle was generated from', () => {
            const corpusText = readFileSync(corpusPath, 'utf8');
            expect(createHash('sha256').update(corpusText).digest('hex')).toBe(header.get('Corpus sha256'));
            expect(corpusHex.length).toBeGreaterThan(10000);
        });

        it('has exactly one well-formed oracle record per corpus input', () => {
            expect(malformed).toEqual([]);
            expect(rows.length).toBe(corpusHex.length);
            const mismatched = corpusHex
                .map((hex, index) => (hex === rows[index]?.hex ? null : `${hex} != ${rows[index]?.hex}`))
                .filter((entry) => entry !== null);
            expect(mismatched.slice(0, 5)).toEqual([]);
            expect(new Set(corpusHex).size).toBe(corpusHex.length);
        });

        it('consumes what WeeChat consumes, apart from the documented rules', () => {
            const unexplained: string[] = [];
            const ruleHits = new Map<string, number>();

            for (const row of rows) {
                const ours = libraryExtents(row.input);
                const used = explain(row.input, row.scanner, ours);
                if (used === null) {
                    unexplained.push(`${JSON.stringify(row.input)} scanner=${JSON.stringify(row.scanner)} library=${JSON.stringify(ours)}`);
                    continue;
                }
                for (const rule of used) {
                    ruleHits.set(rule, (ruleHits.get(rule) ?? 0) + 1);
                }
            }

            expect(unexplained.slice(0, 10)).toEqual([]);
            expect(unexplained).toHaveLength(0);

            for (const rule of rules) {
                expect(ruleHits.get(rule.id) ?? 0, `rule ${rule.id} is no longer exercised`).toBeGreaterThan(0);
            }
            expect([...ruleHits.keys()].sort()).toEqual(rules.map((rule) => rule.id).sort());
        });

        it('exercises every control family the scanner recognizes', () => {
            const families: [string, (input: string) => boolean][] = [
                ['F foreground', (input) => input.includes('\u0019F')],
                ['B background', (input) => input.includes('\u0019B')],
                ['* foreground+background', (input) => input.includes('\u0019*')],
                ['@ pair number', (input) => input.includes('\u0019@')],
                ['E emphasis', (input) => input.includes('\u0019E')],
                ['b bar reference', (input) => input.includes('\u0019b')],
                ['\u001c reset', (input) => input.includes('\u001c')],
                ['\u001a set attribute', (input) => input.includes('\u001a')],
                ['\u001b remove attribute', (input) => input.includes('\u001b')],
                ['bare two-digit theme color', (input) => {
                    for (let index = 0; index + 2 < input.length; index++) {
                        if (input.charCodeAt(index) === COLOR
                            && DIGITS.includes(input.charAt(index + 1))
                            && DIGITS.includes(input.charAt(index + 2))) {
                            return true;
                        }
                    }
                    return false;
                }],
            ];
            for (const [name, matches] of families) {
                const hits = rows.filter((row) => matches(row.input)).length;
                expect(hits, `corpus barely covers ${name}`).toBeGreaterThan(20);
            }
        });

        it('records the ledger examples with the scanner extents they claim', () => {
            for (const rule of rules) {
                const row = rows.find((candidate) => candidate.input === rule.example.input);
                expect(row, `example for ${rule.id} is missing from the corpus`).toBeDefined();
                expect(row!.scanner, `scanner extents for ${rule.id}`).toEqual(rule.example.scanner);
            }
        });
    });
}
