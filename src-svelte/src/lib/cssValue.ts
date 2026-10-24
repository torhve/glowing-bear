/**
 * Whether CSS will paint a typed setting value as a value of its own.
 *
 * Every setting that ends up written into a CSS custom property passes through
 * here. These values are free text from SettingsModal, and the failure mode is
 * silent: a value CSS cannot paint does not throw, it becomes `unset`, the
 * element inherits, and a fallback written as `var(--x, default)` never fires
 * because the custom property is present. So the question "would this paint?"
 * is asked of the engine rather than guessed with a grammar.
 *
 * Measured in Chromium against the app's own shape — a custom property on the
 * root, `font-family: var(--font-mono)` and `font-size: var(--font-size, …)`
 * on the elements that read it — `CSS.supports` agreed with what the engine
 * then computed for every value tried: `15px`, `15 px`, `1.2em`, `12pt`,
 * `large`, `Georgia`, `Foo, `, empty, whitespace-only, `calc(10px + 2vw)`.
 *
 * Two constructs are refused by name because there the engine's syntactic
 * answer and its painting answer disagree.
 */

/**
 * Values the engine accepts syntactically but that discard whatever the app
 * was about to paint.
 *
 * A CSS-wide keyword replaces the property with the inherited or initial
 * value; a `var()` in a setting value can only name a custom property the app
 * never defines, or the very property it is written into. Both were measured
 * in Chromium and in the running app: `inherit`, `var(--x)` and `var(--x)` in
 * a `calc()` each left the reading element at the inherited value while
 * `CSS.supports` answered `true`.
 */
const CSS_WIDE_KEYWORDS = new Set(['inherit', 'initial', 'unset', 'revert', 'revert-layer']);

/**
 * @param property the CSS property the value will be written into
 * @param value the trimmed value as the user typed it
 * @returns true when the engine will paint this value as itself
 *
 * An environment with no `CSS.supports` answers *no*: with no engine to ask,
 * nothing can paint the value anyway, so the caller's default is the only
 * honest answer rather than an unchecked pass-through. The settings that use
 * this are applied from a Svelte `$effect`, which never runs during SSR, so
 * that branch is unreachable where it matters.
 */
export function cssPaints(property: string, value: string): boolean {
    if (typeof CSS === 'undefined' || typeof CSS.supports !== 'function') return false;
    const lower = value.toLowerCase();
    if (lower.includes('var(') || CSS_WIDE_KEYWORDS.has(lower)) return false;
    return CSS.supports(property, value);
}
