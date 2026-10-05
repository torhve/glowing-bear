/**
 * Differential tests against both existing parsers:
 *
 *   - current:  src-svelte/src/lib/weechat-colors.ts   (`rawText2Rich`)
 *   - legacy:   src-angular/js/weechat.js              (`WeeChatProtocol.rawText2Rich`)
 *
 * These are not parity tests. The library follows WeeChat 4.10.1; both existing
 * parsers carry legacy Glowing Bear decisions. Every divergence is recorded in
 * `CASES` below, which is the executable half of the behavior difference ledger
 * documented in docs/format.md: a divergence that is not listed fails the suite,
 * and a listed divergence that no longer exists fails it too, so the ledger
 * cannot silently drift.
 *
 * Comparison is rendering semantics, not parser mechanics. Each parser's output
 * becomes its text plus the sequence of *distinct* style runs (adjacent runs
 * with identical styles are merged on both sides), and the dimensions compared
 * are: text, fg, bg, attrs.
 *
 * The legacy attribute model has no "inherited" state, so a legacy `false` and
 * the library's `inherited`/`disabled` all normalize to "off"; only attributes
 * that are actually on are compared.
 */

import { describe, expect, it } from 'vitest';
import { parseWeeChatText } from '../src/parse.js';
import { CTL } from './helpers/ctl.js';
import { loadLegacyParsers } from './helpers/legacy-parsers.js';
import type { LegacyColor, LegacyPart } from './helpers/legacy-parsers.js';

type Dimension = 'text' | 'fg' | 'bg' | 'attrs';

interface StyleCell {
    fg: string;
    bg: string;
    attrs: string;
}

interface Signature {
    text: string;
    runs: StyleCell[];
}

interface RawRun {
    text: string;
    fg: string;
    bg: string;
    attrs: string;
}

interface LibraryRun {
    text: string;
    style: {
        fg: { kind: string; name?: string; value?: number };
        bg: { kind: string; name?: string; value?: number };
        attrs: Record<string, string>;
        themeAttrs: string | null;
        emphasis: boolean;
    };
}

const SHORT_ATTR_KEYS: Record<string, string> = {
    b: 'bold',
    r: 'reverse',
    i: 'italic',
    u: 'underline',
    k: 'blink',
    d: 'dim',
};

/** Merge adjacent runs whose styles are identical, so run-splitting policy is not a difference. */
function signature(runs: RawRun[]): Signature {
    const merged: StyleCell[] = [];
    let text = '';
    for (const run of runs) {
        text += run.text;
        const cell: StyleCell = { fg: run.fg, bg: run.bg, attrs: run.attrs };
        const previous = merged[merged.length - 1];
        if (previous && previous.fg === cell.fg && previous.bg === cell.bg && previous.attrs === cell.attrs) {
            continue;
        }
        merged.push(cell);
    }
    return { text, runs: merged };
}

function signatureFromLibrary(runs: readonly LibraryRun[]): Signature {
    const color = (c: { kind: string; name?: string; value?: number }): string => {
        if (c.kind === 'weechat') return c.name ?? '?';
        if (c.kind === 'extended') return `ext:${c.value}`;
        if (c.kind === 'theme') return `option:${c.name}`;
        return 'default';
    };
    return signature(runs.map((run) => ({
        text: run.text,
        fg: color(run.style.fg),
        bg: color(run.style.bg),
        attrs: [
            ...(run.style.themeAttrs ? [run.style.themeAttrs] : []),
            ...(run.style.emphasis ? ['emphasis'] : []),
            ...Object.entries(run.style.attrs)
                .filter(([, state]) => state === 'enabled')
                .map(([name]) => name)
                .sort(),
        ].join(','),
    })));
}

function signatureFromLegacy(parts: LegacyPart[]): Signature {
    const color = (c: LegacyColor | undefined): string => {
        if (!c) return 'default';
        if (c.type === 'option') return `option:${c.name}`;
        if (c.type === 'ext') return `ext:${c.name}`;
        return c.name ?? 'default';
    };
    return signature(parts.map((part) => ({
        text: part.text ?? '',
        fg: color(part.fgColor),
        bg: color(part.bgColor),
        attrs: [
            ...(part.attrs?.name ? [part.attrs.name] : []),
            ...Object.entries(part.attrs?.override ?? {})
                .filter(([, value]) => value === true)
                .map(([key]) => SHORT_ATTR_KEYS[key] ?? key)
                .sort(),
        ].join(','),
    })));
}

function differingDimensions(a: Signature, b: Signature): Dimension[] {
    const join = (runs: StyleCell[], key: keyof StyleCell): string => runs.map((run) => run[key]).join('|');
    const dimensions: Dimension[] = [];
    if (a.text !== b.text) dimensions.push('text');
    if (join(a.runs, 'fg') !== join(b.runs, 'fg')) dimensions.push('fg');
    if (join(a.runs, 'bg') !== join(b.runs, 'bg')) dimensions.push('bg');
    if (join(a.runs, 'attrs') !== join(b.runs, 'attrs')) dimensions.push('attrs');
    return dimensions;
}

interface Case {
    id: string;
    input: string;
    /** Dimensions where the library is expected to differ from each parser. */
    current: Dimension[];
    legacy: Dimension[];
    note: string;
}

const C = CTL.color;

const CASES: Case[] = [
    { id: 'plain', input: 'hello world', current: [], legacy: [], note: 'identical' },
    { id: 'fg-named', input: `${C}F03red`, current: [], legacy: [], note: 'identical' },
    { id: 'fg-extended', input: `${C}F@00012ext`, current: [], legacy: [], note: 'identical' },
    { id: 'bg-extended', input: `${C}B@00034ext`, current: [], legacy: [], note: 'identical' },
    { id: 'combined-comma', input: `${C}*01,02both`, current: [], legacy: [], note: 'legacy comma separator supported' },
    { id: 'combined-tilde', input: `${C}*01~02both`, current: [], legacy: [], note: 'current tilde separator supported' },
    { id: 'payload-attr-bold', input: `${C}F*03bold`, current: [], legacy: [], note: 'identical' },
    { id: 'payload-attr-blink', input: `${C}F%03blink`, current: [], legacy: ['text', 'fg', 'attrs'], note: 'the Angular parser predates the blink/dim prefixes and emits the whole control as text' },
    { id: 'payload-attr-dim', input: `${C}F.03dim`, current: [], legacy: ['text', 'fg', 'attrs'], note: 'the Angular parser predates the blink/dim prefixes and emits the whole control as text' },
    { id: 'combined-attr-foreground', input: `${C}*03star`, current: ['fg'], legacy: ['fg'], note: 'upstream consumes `*03` as an incomplete combined control and applies nothing; both parsers read it as a foreground color' },
    { id: 'set-attr-control', input: `${CTL.setAttr}\u0001bold`, current: [], legacy: [], note: 'identical' },
    { id: 'set-attr-printable', input: `${CTL.setAttr}*bold`, current: ['text', 'attrs'], legacy: ['text', 'attrs'], note: 'upstream consumes only `\x1a`, leaving `*` as text with no attribute; both parsers accept printable markers for IRC compatibility' },
    { id: 'remove-attr-printable', input: `${CTL.removeAttr}*plain`, current: ['text'], legacy: ['text'], note: 'same printable-marker divergence, with no attribute either way' },
    { id: 'keep-attributes', input: `${C}F*03a${C}F|04b`, current: [], legacy: [], note: 'identical' },
    { id: 'emphasis-on', input: `${C}Eemph`, current: ['fg'], legacy: ['fg', 'bg'], note: 'the library keeps emphasis as a marker; the parsers bake the emphasis theme color into fg (Angular also into bg)' },
    { id: 'emphasis-toggle-off', input: `${C}Eemph${C}E normal`, current: ['fg', 'bg', 'attrs'], legacy: ['fg', 'bg', 'attrs'], note: 'upstream toggles emphasis off at the second `\x19E`; both parsers leave it applied for the rest of the line' },
    { id: 'reset-colors', input: `${C}F03red${C}${CTL.reset}back`, current: [], legacy: [], note: 'identical when no attribute is active' },
    { id: 'reset-colors-keeps-attributes', input: `${CTL.setAttr}\u0001a${C}${CTL.reset}b`, current: [], legacy: [], note: 'all three keep an active attribute across `\x19\x1c`' },
    { id: 'reset-all', input: `${C}F03red${CTL.reset}back`, current: [], legacy: [], note: 'identical' },
    { id: 'theme-nick', input: `${C}14nick`, current: [], legacy: [], note: 'identical' },
    { id: 'theme-day-change', input: `${C}43day`, current: [], legacy: [], note: 'identical' },
    { id: 'theme-out-of-range', input: `${C}47x`, current: [], legacy: [], note: 'all three ignore an index outside the theme table' },
    { id: 'bar-controls', input: `a${C}bDb${C}b_ b`, current: ['text'], legacy: ['text'], note: 'upstream consumes bar layout controls; both parsers emit them as text' },
    { id: 'malformed-fg-window', input: `${C}F0xb`, current: ['text'], legacy: ['text'], note: 'upstream consumes the fixed-width `0x` payload; both parsers emit `F0xb`' },
    { id: 'malformed-combined', input: `${C}*03,@12 rest`, current: ['text', 'fg'], legacy: ['text', 'fg'], note: 'upstream applies nothing unless both sides parse, and consumes the fixed-width background window' },
    { id: 'out-of-palette-fg', input: `${C}F99oob`, current: [], legacy: [], note: 'all three ignore an index outside the 17-color palette' },
    { id: 'unicode', input: '😀 emoji 😀', current: [], legacy: [], note: 'identical' },
    { id: 'irc-converted', input: `${C}F02dark${C}B03light${CTL.setAttr}*bold${CTL.removeAttr}*plain${C}${CTL.reset}end`, current: ['text', 'fg', 'bg', 'attrs'], legacy: ['text', 'fg', 'bg', 'attrs'], note: 'the app converts IRC bold to `\x1a*`, which upstream renders as a literal `*`; IRC compatibility belongs in the adapter, not the library' },
];

describe('differential behavior against the existing parsers', () => {
    for (const testCase of CASES) {
        it(`${testCase.id}: ${JSON.stringify(testCase.input)}`, async () => {
            const parsers = await loadLegacyParsers();
            const library = signatureFromLibrary(parseWeeChatText(testCase.input));

            expect(differingDimensions(library, signatureFromLegacy(parsers.current(testCase.input))))
                .toEqual(testCase.current);
            expect(differingDimensions(library, signatureFromLegacy(parsers.legacy(testCase.input))))
                .toEqual(testCase.legacy);
        });
    }
});

describe('differential invariants', () => {
    const agreeing = CASES.filter((testCase) => testCase.current.length === 0 && testCase.legacy.length === 0);

    it('covers enough identical cases to be meaningful', () => {
        expect(agreeing.length).toBeGreaterThan(12);
    });

    it('every parser produces the same text for cases recorded as identical', async () => {
        const parsers = await loadLegacyParsers();
        for (const testCase of agreeing) {
            const library = signatureFromLibrary(parseWeeChatText(testCase.input));
            expect(library.text).toBe(signatureFromLegacy(parsers.current(testCase.input)).text);
            expect(library.text).toBe(signatureFromLegacy(parsers.legacy(testCase.input)).text);
        }
    });

    it('the current parser and the legacy Angular parser agree on those cases', async () => {
        const parsers = await loadLegacyParsers();
        for (const testCase of agreeing) {
            expect(signatureFromLegacy(parsers.current(testCase.input)))
                .toEqual(signatureFromLegacy(parsers.legacy(testCase.input)));
        }
    });
});
