/**
 * The `fontsize` setting, parsed once.
 *
 * The value is free text the user types into SettingsModal, and it reaches two
 * different languages: the slider needs a number, and `+page.svelte` writes the
 * string straight into a CSS custom property and `document.body.style.fontSize`.
 * Those consumers used to each carry their own rule — the modal had two regexes
 * that disagreed about whitespace, and the page applied the typed string verbatim.
 *
 * Applying it verbatim was the part with an observable consequence. Measured in
 * Chromium: `--font-size: 15 px` (a space between the number and the unit) is
 * invalid at computed-value time, which means the property becomes `unset` and
 * the element inherits the browser default — so a fallback written as
 * `var(--font-size, 14px)` never fires either. The slider said 15px while the
 * chat was rendering at 16px. A whitespace-only value is worse than empty: an
 * empty custom property is absent and the fallback applies, but `" "` is present
 * and empty, which lands in the same `unset` path.
 */

import { cssPaints } from '#lib/cssValue.ts';

/** The size the app falls back to when the stored value says nothing usable. */
export const FONT_SIZE_DEFAULT_PX = 14;

/** The same default in the spelling CSS reads. */
export const FONT_SIZE_DEFAULT_CSS = `${FONT_SIZE_DEFAULT_PX}px`;

/**
 * The pixel count in a font-size value, or `null` when there is none.
 *
 * Surrounding whitespace and an internal space before `px` are tolerated: the
 * value comes from a text field, and a stray space is the user meaning a size,
 * not a size that should silently become the browser default.
 */
export function parseFontSizePx(value: string | null | undefined): number | null {
    const match = /^\s*(\d+)\s*(?:px)?\s*$/.exec(value ?? '');
    if (!match || match[1] === undefined) return null;
    return Number.parseInt(match[1], 10);
}

/**
 * Values the engine accepts but that still hand the size back to the browser.
 *
 * Measured in Chromium against the app's own shape — `--font-size` on the root,
 * an inline size on `body`, rows reading `var(--font-size, 14px)`: `var(--x)`,
 * `var(--missing)`, `calc(var(--x))`, `inherit`, `initial`, `unset` and
 * `revert` each keep the root fallback at 14px while the inheriting body sits
 * at the browser's 16px, and `CSS.supports` answers `true` for every one of
 * them. That is why `lib/cssValue.ts` refuses them by name instead of asking
 * the engine alone, and why a hand-written grammar is not used either: for
 * `15px`, `15 px`, `1.2em`, `12pt`, `large`, `Georgia`, `Foo, `, empty,
 * whitespace-only, `calc(10px + 2vw)`, `min(12px, 2vw)` and `15rem`, jsdom and
 * Chromium return the identical table.
 */

/**
 * The stored value in a spelling CSS accepts, or the default.
 *
 * A plain pixel count is rewritten canonically. Anything else is passed through
 * only if CSS will paint it: the upstream app's rule was "no unit means pixels,
 * otherwise pass it on", and a size the slider cannot express (`1.2em`, `12pt`,
 * `large`) is a deliberate choice rather than a malformed one. Everything else —
 * a font family typed into the size field, a half-typed list, whitespace — is a
 * declaration CSS rejects, and letting it through makes the property `unset`,
 * which paints the browser's default rather than this app's default. The
 * decision therefore belongs here, where the value is read, and not left to the
 * cascade — and "will CSS paint this value?" is asked once, in
 * `lib/cssValue.ts`, shared with the `fontfamily` setting.
 */
export function fontSizeCss(value: string | null | undefined): string {
    const px = parseFontSizePx(value);
    if (px !== null) return `${px}px`;
    const trimmed = (value ?? '').trim();
    if (trimmed === '' || !cssPaints('font-size', trimmed)) return FONT_SIZE_DEFAULT_CSS;
    return trimmed;
}
