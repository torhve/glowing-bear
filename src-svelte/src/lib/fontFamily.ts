import { cssPaints } from '#lib/cssValue.ts';

/**
 * The `fontfamily` setting, read once.
 *
 * Like the font size, this is free text the user types into SettingsModal, and
 * `+page.svelte` writes it into the `--font-mono` custom property that the chat
 * body, `.favorite-font` and the message rows read through
 * `font-family: var(--font-mono)`.
 *
 * Writing it verbatim is what had an observable consequence. Measured in the
 * running app (Chromium, typing into the real Settings field and reading
 * `getComputedStyle(document.body).fontFamily`):
 *
 * | typed | painted |
 * |---|---|
 * | `""` | `"Fira Mono", Consolas, Monaco, "Courier New", monospace` — the `@theme` default, because an empty custom property is absent |
 * | `Menlo, monospace` | `Menlo, monospace` |
 * | `"   "` | `-apple-system, …, sans-serif` — the **proportional UI font**, not a monospace one |
 * | `Foo, ` | the same proportional UI font |
 * | `inherit` | the same proportional UI font |
 * | `var(--x)` | the same proportional UI font |
 *
 * A value that is present but unpaintable becomes `unset` at computed-value
 * time, so the element inherits `html`'s Tailwind sans stack. The chat does not
 * fall back to a monospace font at all: it silently changes from monospace to
 * proportional, while Settings still shows what was typed. Whitespace is worse
 * than empty for the same reason it is for the size — empty is absent and the
 * stylesheet default applies, `"   "` is present and unpaintable.
 */

/**
 * The stack the app itself declares, in `app.css`'s `@theme` block.
 *
 * Spelled here so Settings can *say* what an empty field means instead of
 * naming a different stack. `font-family-default-guard.test.ts` fails if this
 * stops matching the declaration in the stylesheet, because two spellings of
 * one default is how the placeholder starts lying.
 */
export const FONT_FAMILY_DEFAULT_CSS = '"Fira Mono", "Consolas", "Monaco", "Courier New", monospace';

/**
 * The spelling to write into `--font-mono` for a stored family, or `null` when
 * the value says nothing CSS can paint.
 *
 * `null` is not "use this module's default": it means *say nothing*, so
 * `+page.svelte` removes the override and `@theme`'s own declaration paints.
 * That keeps exactly one place where the app's default family is written down.
 * A value CSS accepts is passed through untouched, including a family with no
 * generic fallback (`Georgia` was measured painting Georgia) — the user asked
 * for that font and the engine can honour it.
 */
export function fontFamilyCss(value: string | null | undefined): string | null {
    const trimmed = (value ?? '').trim();
    if (trimmed === '') return null;
    return cssPaints('font-family', trimmed) ? trimmed : null;
}
