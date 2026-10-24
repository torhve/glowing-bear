/**
 * The `fontfamily` setting has one value rule: `lib/fontFamily.ts`.
 *
 * `+page.svelte` used to write the stored string straight into `--font-mono`.
 * That is harmless for the values a user types deliberately and silently wrong
 * for the ones they half-type: a custom property that is present but invalid
 * becomes `unset` at computed-value time, the reading element inherits, and a
 * `var(--font-mono)` with no fallback — which is how `app.css` reads it on
 * `body` and `.favorite-font` — has nothing to fall back to either. Measured in
 * the running app, `"   "`, `Foo, `, `inherit` and `var(--x)` each painted the
 * chat with the proportional UI font while Settings still showed the typed text.
 *
 * The rule is asked of CSS rather than guessed, because the engine is the thing
 * that decides; the two constructs it accepts and still refuses (`var()`,
 * CSS-wide keywords) are refused in `lib/cssValue.ts`, shared with the size.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FONT_FAMILY_DEFAULT_CSS, fontFamilyCss } from '#lib/fontFamily.ts';

describe('the family rule answers what CSS will paint', () => {
    it('passes through a family list CSS accepts, trimmed', () => {
        expect(fontFamilyCss('Menlo, monospace')).toBe('Menlo, monospace');
        expect(fontFamilyCss('Inconsolata, Consolas, Monaco, Ubuntu Mono, monospace'))
            .toBe('Inconsolata, Consolas, Monaco, Ubuntu Mono, monospace');
        expect(fontFamilyCss('  "Fira Code", monospace  ')).toBe('"Fira Code", monospace');
    });

    it('passes through a single family with no generic fallback', () => {
        // The user asked for that font and the engine can honour it: `Georgia`
        // was measured painting Georgia in the running app.
        expect(fontFamilyCss('Georgia')).toBe('Georgia');
    });

    it.each([
        ['whitespace only', '   '],
        ['a half-typed list', 'Foo, '],
        ['a CSS-wide keyword', 'inherit'],
        ['a var() the app never defines', 'var(--x)'],
        ['a var() inside calc()', 'calc(var(--x))'],
    ])('refuses %s so the stylesheet default can paint', (_label, value) => {
        expect(fontFamilyCss(value), `${value} must not reach CSS`).toBeNull();
    });

    it('says nothing for a value that is absent', () => {
        expect(fontFamilyCss('')).toBeNull();
        expect(fontFamilyCss(null)).toBeNull();
        expect(fontFamilyCss(undefined)).toBeNull();
    });
});

describe('the app default family is written down once', () => {
    it('is the same stack `app.css` declares for --font-mono', () => {
        // The default lives in the stylesheet, because that is the only place
        // it can apply before the page effect runs. `FONT_FAMILY_DEFAULT_CSS`
        // exists so Settings can name it; this is what stops the two spellings
        // drifting apart and the placeholder describing a font that is never
        // painted.
        const css = readFileSync('src-svelte/src/app.css', 'utf8');
        const declared = css.match(/--font-mono:\s*([^;]+);/)?.[1]?.trim();
        expect(declared, 'app.css no longer declares --font-mono the way the setting says it does')
            .toBe(FONT_FAMILY_DEFAULT_CSS);
    });

    it('is a value CSS itself would paint', () => {
        // Otherwise "fall back to the default" is a promise the engine would
        // break too.
        expect(fontFamilyCss(FONT_FAMILY_DEFAULT_CSS)).toBe(FONT_FAMILY_DEFAULT_CSS);
    });
});
