/**
 * Differential tests against both application parsers:
 *
 *   - current:  src-svelte/src/lib/weechat-colors.ts — an adapter over this library
 *   - legacy:   src-angular/js/weechat.js            (`WeeChatProtocol.rawText2Rich`)
 *
 * These are not parity tests. The library follows WeeChat 4.10.1; the adapter adds
 * the app's CSS vocabulary and its mIRC translation on top. Every divergence is
 * recorded in `CASES`/`IRC_CASES` below, which is the executable half of the
 * behavior difference ledger in docs/behavior-differences.md: a divergence that is
 * not listed fails the suite, and a listed divergence that no longer exists fails
 * it too, so the ledger cannot silently drift.
 *
 * Comparison is rendering semantics, not parser mechanics. Each parser's output
 * becomes its text plus the sequence of *distinct* style runs (adjacent runs with
 * identical styles are merged on both sides), and the dimensions compared are:
 * text, fg, bg, attrs.
 *
 * The legacy attribute model has no "inherited" state, so a legacy `false` and the
 * library's `inherited`/`disabled` all normalize to "off"; only attributes that are
 * actually on are compared.
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

interface StyledRun extends StyleCell {
    /** How many characters of output this style covers. */
    length: number;
}

interface Signature {
    text: string;
    runs: StyledRun[];
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
    const merged: StyledRun[] = [];
    let text = '';
    for (const run of runs) {
        text += run.text;
        const previous = merged[merged.length - 1];
        if (previous && previous.fg === run.fg && previous.bg === run.bg && previous.attrs === run.attrs) {
            previous.length += run.text.length;
            continue;
        }
        merged.push({ fg: run.fg, bg: run.bg, attrs: run.attrs, length: run.text.length });
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
    const dimensions: Dimension[] = [];
    if (a.text !== b.text) {
        dimensions.push('text');
    }
    for (const key of ['fg', 'bg', 'attrs'] as const) {
        if (stylesDiffer(a, b, key)) {
            dimensions.push(key);
        }
    }
    return dimensions;
}

/**
 * Compare the style drawn at each character, so a parser that splits a run in a
 * different place is not reported as a color or attribute difference.
 */
function stylesDiffer(a: Signature, b: Signature, key: 'fg' | 'bg' | 'attrs'): boolean {
    const length = Math.min(a.text.length, b.text.length);
    let index = 0;
    for (const run of a.runs) {
        for (let seen = 0; seen < run.length && index < length; seen++, index++) {
            const other = styleAt(b, index);
            if (other && run[key] !== other[key]) {
                return true;
            }
        }
    }
    return false;
}

function styleAt(sig: Signature, index: number): StyledRun | undefined {
    let position = 0;
    for (const run of sig.runs) {
        if (index < position + run.length) {
            return run;
        }
        position += run.length;
    }
    return undefined;
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

// The application parser is now this library plus the adapter's CSS vocabulary, so
// the divergences that used to be "both parsers vs the library" are gone; what is
// left is the adapter's own documented choices and the Angular parser's history.
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
    { id: 'combined-attr-foreground', input: `${C}*03star`, current: [], legacy: ['fg'], note: 'upstream consumes `*03` as an incomplete combined control and applies nothing; the Angular parser reads it as a foreground color' },
    { id: 'set-attr-control', input: `${CTL.setAttr}\u0001bold`, current: [], legacy: [], note: 'identical' },
    { id: 'set-attr-printable', input: `${CTL.setAttr}*bold`, current: [], legacy: ['text', 'attrs'], note: 'upstream consumes only `\x1a`, leaving `*` as text with no attribute; the Angular parser accepts printable markers' },
    { id: 'remove-attr-printable', input: `${CTL.removeAttr}*plain`, current: [], legacy: ['text'], note: 'same printable-marker divergence, with no attribute either way' },
    { id: 'keep-attributes', input: `${C}F*03a${C}F|04b`, current: [], legacy: [], note: 'identical' },
    { id: 'emphasis-on', input: `${C}Eemph`, current: ['fg'], legacy: ['fg', 'bg'], note: 'the library keeps emphasis as a marker and the adapter maps it onto the emphasis foreground; the Angular parser also bakes it into the background' },
    { id: 'emphasis-toggle-off', input: `${C}Eemph${C}E normal`, current: ['fg'], legacy: ['fg', 'bg', 'attrs'], note: 'emphasis now toggles off at the second `\x19E` in both; only the emphasis color mapping differs' },
    { id: 'reset-colors', input: `${C}F03red${C}${CTL.reset}back`, current: [], legacy: [], note: 'identical when no attribute is active' },
    { id: 'reset-colors-keeps-attributes', input: `${CTL.setAttr}\u0001a${C}${CTL.reset}b`, current: [], legacy: [], note: 'all three keep an active attribute across `\x19\x1c`' },
    { id: 'reset-all', input: `${C}F03red${CTL.reset}back`, current: [], legacy: [], note: 'identical' },
    { id: 'theme-nick', input: `${C}14nick`, current: [], legacy: [], note: 'identical' },
    { id: 'theme-day-change', input: `${C}43day`, current: [], legacy: [], note: 'identical' },
    { id: 'theme-out-of-range', input: `${C}47x`, current: [], legacy: [], note: 'all three ignore an index outside the theme table' },
    { id: 'theme-obsolete-slot', input: `${C}17obsolete`, current: ['fg', 'bg', 'attrs'], legacy: ['fg', 'bg', 'attrs'], note: 'the library keeps the removed chat_nick1 reference symbolic, the adapter renders it as the default color, and the Angular parser named it "invalid"' },
    { id: 'bar-controls', input: `a${C}bDb${C}b_ b`, current: [], legacy: ['text'], note: 'upstream consumes bar layout controls; the Angular parser emits them as text' },
    { id: 'malformed-fg-window', input: `${C}F0xb`, current: [], legacy: ['text'], note: 'upstream consumes the fixed-width `0x` payload; the Angular parser emits `F0xb`' },
    { id: 'malformed-combined', input: `${C}*03,@12 rest`, current: [], legacy: ['text', 'fg'], note: 'upstream applies nothing unless both sides parse, and consumes the fixed-width background window' },
    { id: 'out-of-palette-fg', input: `${C}F99oob`, current: [], legacy: [], note: 'all three ignore an index outside the 17-color palette' },
    { id: 'combined-out-of-range-fg', input: `${C}*99,01oob`, current: [], legacy: ['fg'], note: 'the library and adapter model an out-of-palette combined foreground as an extended color; upstream indexes a palette table out of bounds and the Angular parser ignored it' },
    { id: 'combined-out-of-range-bg', input: `${C}*03,99bg oob`, current: [], legacy: ['bg'], note: 'same modeling on the background side' },
    { id: 'unicode', input: '😀 emoji 😀', current: [], legacy: [], note: 'identical' },
    { id: 'irc-converted-controls', input: `${C}F02dark${C}B03light${CTL.setAttr}\u0001bold${CTL.removeAttr}\u0001plain${C}${CTL.reset}end`, current: [], legacy: [], note: 'the adapter emits WeeChat control characters, so converted IRC text parses identically here' },
];

// Raw mIRC text: the adapter translates it first, the library does not. The point
// of these cases is that the adapter's translation is exactly what the library
// then renders, and that the translation now matches WeeChat's own IRC plugin.
const IRC_CASES: Array<{ id: string; input: string; legacy: Dimension[]; note: string }> = [
    { id: 'irc-bold', input: '\x02bold\x02normal', legacy: ['text', 'attrs'], note: 'the Angular parser left the mIRC byte in the text' },
    { id: 'irc-color', input: '\x0304red\x03', legacy: ['text', 'fg'], note: 'the Angular parser left the mIRC byte in the text' },
    { id: 'irc-color-fg-bg', input: '\x0312,04fgbg', legacy: ['text', 'fg', 'bg'], note: 'mapped through WeeChat\'s IRC color table into one combined control' },
    { id: 'irc-color-out-of-range', input: '\x0328(Leaving\x03', legacy: ['text', 'fg'], note: 'IRC 28 maps to terminal color 88, not to a theme index' },
    { id: 'irc-hex-color', input: '\x04ff0000hex', legacy: ['text', 'fg'], note: 'nearest terminal color, as irc_color_decode() computes it' },
    { id: 'irc-reverse', input: '\x16reverse', legacy: ['text', 'attrs'], note: 'set-attribute control instead of a literal byte' },
    { id: 'irc-italic', input: '\x1ditalic', legacy: ['text', 'attrs'], note: 'set-attribute control instead of a literal byte' },
    { id: 'irc-underline', input: '\x1funderline', legacy: ['text', 'attrs'], note: 'set-attribute control instead of a literal byte' },
    { id: 'irc-strikethrough', input: '\x1estrikethrough', legacy: ['text', 'attrs'], note: 'WeeChat has no strikethrough, so it renders as dim' },
    { id: 'irc-reset', input: '\x02bold\x0fplain', legacy: ['text', 'attrs'], note: 'mIRC reset becomes the full WeeChat reset' },
    { id: 'irc-weechat-text-untouched', input: `${C}F03keep\x02bold`, legacy: ['text', 'attrs'], note: 'WeeChat controls pass through the conversion unchanged' },
];

describe('differential behavior against the application parsers', () => {
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

describe('the adapter is the library plus the IRC translation', () => {
    for (const testCase of IRC_CASES) {
        it(`${testCase.id}: ${JSON.stringify(testCase.input)}`, async () => {
            const parsers = await loadLegacyParsers();
            const viaAdapter = signatureFromLegacy(parsers.current(testCase.input));
            const viaLibrary = signatureFromLibrary(parseWeeChatText(parsers.convertIrcCodes(testCase.input)));

            expect(differingDimensions(viaLibrary, viaAdapter)).toEqual([]);
            expect(differingDimensions(viaLibrary, signatureFromLegacy(parsers.legacy(testCase.input))))
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

    it('the adapter and the legacy Angular parser agree on those cases', async () => {
        const parsers = await loadLegacyParsers();
        for (const testCase of agreeing) {
            expect(signatureFromLegacy(parsers.current(testCase.input)))
                .toEqual(signatureFromLegacy(parsers.legacy(testCase.input)));
        }
    });

    it('the adapter differs from the library only where the ledger says it does', async () => {
        const parsers = await loadLegacyParsers();
        for (const testCase of CASES) {
            const dimensions = differingDimensions(
                signatureFromLibrary(parseWeeChatText(testCase.input)),
                signatureFromLegacy(parsers.current(testCase.input)),
            );
            expect(dimensions, testCase.note).toEqual(testCase.current);
        }
    });
});
