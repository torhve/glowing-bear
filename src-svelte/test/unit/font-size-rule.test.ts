/**
 * The `fontsize` setting has one value rule (`lib/fontSize.ts`), and it has to
 * serve two languages: a pixel count for the slider, a CSS length for the page.
 *
 * The bug this pins was measured, not inferred. In Chromium a length with a
 * space between the number and the unit (`--font-size: 15 px`) is invalid at
 * computed-value time, so the property becomes `unset` and the element inherits
 * the browser default — which also means a fallback written as
 * `var(--font-size, 14px)` never fires, because the property is present, just
 * not valid. Typing " 15 px " therefore left the slider reading 15px while the
 * chat rendered at the browser's 16px. The cases below are the strings that
 * produced that, read back through the rule that now owns them.
 * Which strings count as a size is the engine's answer (`CSS.supports`), not a
 * hand-written grammar: the same value list was measured in Chromium and in the
 * jsdom these tests run in, and both give the same table, so the unit
 * expectations here are not guessing about a browser they cannot see.
 */
import { describe, expect, it } from 'vitest';
import {
    FONT_SIZE_DEFAULT_CSS,
    FONT_SIZE_DEFAULT_PX,
    fontSizeCss,
    parseFontSizePx,
} from '#lib/fontSize.ts';

describe('the pixel count the slider reads', () => {
    it('reads a plain number and the same number with a unit', () => {
        expect(parseFontSizePx('15')).toBe(15);
        expect(parseFontSizePx('15px')).toBe(15);
    });

    it('reads a value the text field padded, which the field used to reject', () => {
        // The two parsers used to disagree here: the modal's sync effect accepted
        // whitespace and an internal space, its oninput handler did not.
        expect(parseFontSizePx(' 15 px ')).toBe(15);
        expect(parseFontSizePx('15 px')).toBe(15);
        expect(parseFontSizePx('\t18px\n')).toBe(18);
    });

    it('reads nothing in a value that is not a pixel count', () => {
        expect(parseFontSizePx('')).toBeNull();
        expect(parseFontSizePx('   ')).toBeNull();
        expect(parseFontSizePx('large')).toBeNull();
        // A decimal or a negative number is not what the slider can hold, and a
        // trailing unit other than px belongs to CSS rather than to this rule.
        expect(parseFontSizePx('1.5px')).toBeNull();
        expect(parseFontSizePx('-15px')).toBeNull();
        expect(parseFontSizePx('15em')).toBeNull();
        expect(parseFontSizePx(undefined)).toBeNull();
    });
});

describe('the CSS length the page writes', () => {
    it('rewrites a padded value into the spelling CSS accepts', () => {
        // This is the fix: before, this string went to CSS verbatim and the
        // declared size became the browser default instead of 15px.
        expect(fontSizeCss(' 15 px ')).toBe('15px');
        expect(fontSizeCss('15')).toBe('15px');
    });

    it('passes through a size CSS will actually paint', () => {
        // Upstream's rule was "no unit means pixels, otherwise pass it on", and a
        // size the slider cannot express is a deliberate choice rather than a
        // malformed one. These are the values `CSS.supports` says yes to, checked
        // against what Chromium then computes rather than against a grammar.
        expect(fontSizeCss('1.2em')).toBe('1.2em');
        expect(fontSizeCss('12pt')).toBe('12pt');
        expect(fontSizeCss('15rem')).toBe('15rem');
        expect(fontSizeCss('large')).toBe('large');
        expect(fontSizeCss('calc(10px + 2vw)')).toBe('calc(10px + 2vw)');
        expect(fontSizeCss('  1.2em  ')).toBe('1.2em');
    });

    it('replaces a value CSS would refuse instead of letting it paint the browser default', () => {
        // A font family typed into the size field, or a half-typed list, is a
        // declaration CSS rejects — and a rejected custom property becomes
        // `unset`, so the chat paints at the browser's own size and the
        // `var(--font-size, …)` fallback never fires. That is the same failure
        // the padded pixel value caused, just reached by a different string.
        expect(fontSizeCss('Georgia')).toBe(FONT_SIZE_DEFAULT_CSS);
        expect(fontSizeCss('  Georgia  ')).toBe(FONT_SIZE_DEFAULT_CSS);
        expect(fontSizeCss('Foo, ')).toBe(FONT_SIZE_DEFAULT_CSS);
        expect(fontSizeCss('bogus')).toBe(FONT_SIZE_DEFAULT_CSS);
    });

    it('refuses a value the engine accepts but cannot paint as a size of its own', () => {
        // `CSS.supports` answers `true` for every value here. Measured in
        // Chromium against the app's own shape, each one keeps the root fallback
        // at 14px while the inheriting body sits at the browser's 16px — the
        // same split the padded pixel value caused, through a valid door.
        expect(fontSizeCss('var(--x)')).toBe(FONT_SIZE_DEFAULT_CSS);
        expect(fontSizeCss('var(--font-size)')).toBe(FONT_SIZE_DEFAULT_CSS);
        expect(fontSizeCss('calc(var(--x))')).toBe(FONT_SIZE_DEFAULT_CSS);
        expect(fontSizeCss('inherit')).toBe(FONT_SIZE_DEFAULT_CSS);
        expect(fontSizeCss('INHERIT')).toBe(FONT_SIZE_DEFAULT_CSS);
        expect(fontSizeCss('unset')).toBe(FONT_SIZE_DEFAULT_CSS);
        expect(fontSizeCss('revert')).toBe(FONT_SIZE_DEFAULT_CSS);
    });

    it('answers the default when there is no engine to ask', () => {
        // Fail closed: without `CSS.supports` there is no engine that could paint
        // the value, so passing it through would only be an unchecked string.
        const supports = CSS.supports;
        try {
            CSS.supports = undefined as unknown as typeof CSS.supports;
            expect(fontSizeCss('1.2em')).toBe(FONT_SIZE_DEFAULT_CSS);
            expect(fontSizeCss('Georgia')).toBe(FONT_SIZE_DEFAULT_CSS);
        } finally {
            CSS.supports = supports;
        }
    });

    it('writes the default for a blank value rather than a declaration CSS rejects', () => {
        // A whitespace-only custom property is present-but-empty, which lands in
        // the same unset path as an invalid one: it is not "absent, use the
        // fallback". So the blank case has to be decided here, not left to CSS.
        expect(fontSizeCss('')).toBe(FONT_SIZE_DEFAULT_CSS);
        expect(fontSizeCss('   ')).toBe(FONT_SIZE_DEFAULT_CSS);
        expect(fontSizeCss(undefined)).toBe(FONT_SIZE_DEFAULT_CSS);
        expect(FONT_SIZE_DEFAULT_CSS).toBe(`${FONT_SIZE_DEFAULT_PX}px`);
    });
});
