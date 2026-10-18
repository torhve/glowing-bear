import { derived, get, writable } from 'svelte/store';
import { type Theme } from '#lib/themes.ts';
import { settings } from '#lib/stores/settings.ts';

/** Which of a profile's two palettes is being configured or applied. */
export type ThemeSlot = 'dark' | 'light';

/**
 * The palette actually applied to the document.
 *
 * It is not a user choice: the user's choice is the pair of slots in settings, and
 * this store holds the one of them the OS scheme selected. Components that have to
 * repaint because the picture changed (the favicon badge) read this, because a
 * settings change to the *other* slot must not look like an appearance change that
 * repainted nothing.
 */
export const themeStore = writable<Theme>('dark');

const DARK_SCHEME_QUERY = '(prefers-color-scheme: dark)';

/** Whether the OS is asking for the dark slot right now. */
export function prefersDark(): boolean {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia(DARK_SCHEME_QUERY).matches;
}

/** Pure: which slot the given OS scheme selects. */
export function resolveTheme(slots: Record<ThemeSlot, Theme>, dark: boolean): Theme {
    return dark ? slots.dark : slots.light;
}

/** The profile's two slots as settings currently holds them. */
export function configuredSlots(): Record<ThemeSlot, Theme> {
    const current = get(settings);
    return { dark: current.themeDark, light: current.themeLight };
}

/**
 * Write a palette to the document: the `data-theme` attribute every palette in
 * app.css is keyed on, the store components read, and the browser chrome colour.
 */
export function applyTheme(theme: Theme): Theme {
    themeStore.set(theme);
    document.documentElement.setAttribute('data-theme', theme);
    syncThemeColorMeta();
    return theme;
}

/**
 * The two slots as one comparable value.
 *
 * `derived` only notifies when its value changes, and a pair of palettes would be a
 * fresh object on every settings update — a keystroke in the font field would look
 * like an appearance change. A key string dedupes it, so re-applying the palette
 * costs nothing until a palette really does change.
 */
export const themeSlotsKey = derived(settings, (s) => `${s.themeDark}|${s.themeLight}`);

/**
 * Resolve the profile's slots against the OS preference and apply the result.
 *
 * The entry point for anything that cannot see the settings store reactively — the OS
 * flip listener below, and the error page, which renders without the app mounted.
 * A custom-CSS rule that repaints --gb-bg is not seen here, the same limit the favicon
 * badge documents: only a palette change re-reads the colour.
 */
export function applyConfiguredTheme(): Theme {
    return applyTheme(resolveTheme(configuredSlots(), prefersDark()));
}

/**
 * Follow the OS light/dark preference live.
 *
 * Returns the stop function so the caller owns the listener's lifetime, the same
 * shape the indicator owner uses: the app has exactly one follower, and a reconnect
 * or a re-mounted page cannot stack a second one.
 */
export function startThemeFollow(): () => void {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};

    const query = window.matchMedia(DARK_SCHEME_QUERY);
    const onChange = () => {
        applyConfiguredTheme();
    };
    query.addEventListener('change', onChange);

    return () => query.removeEventListener('change', onChange);
}

// Most palettes declare --gb-bg as a plain hex, which the browser can read straight
// out of the custom property. `blue-modern` declares it as oklch(), and Chromium
// hands that token back unchanged rather than as an rgb() the meta tag is guaranteed
// to accept, so only the odd case pays for the canvas conversion below.
const PLAIN_COLOR = /^(#[0-9a-f]{3,8}|rgba?\([^)]*\))$/i;

// A fill colour no palette uses: an assignment the browser rejects leaves
// fillStyle on it, which is how an unparseable value is detected.
const PARSE_PROBE_COLOR = '#010203';

/**
 * Keep <meta name="theme-color"> on the palette that is actually on screen.
 *
 * The tag tints the PWA/mobile browser chrome, and app.html seeds it with the dark
 * palette's background for the pre-JS paint. Leaving it there while the app renders
 * a light palette is the bug issue #13 reports for the app itself, so it is rewritten
 * on every applied palette, including a live OS flip.
 */
function syncThemeColorMeta(): void {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) return;

    const raw = getComputedStyle(document.documentElement).getPropertyValue('--gb-bg').trim();
    if (!raw) return;

    const chromeColor = PLAIN_COLOR.test(raw) ? raw : resolveChromeColor(raw);
    if (chromeColor) meta.setAttribute('content', chromeColor);
}

/** Resolve any CSS colour the browser understands to sRGB, or null if it does not. */
function resolveChromeColor(value: string): string | null {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return null;

    ctx.fillStyle = PARSE_PROBE_COLOR;
    ctx.fillStyle = value;
    if (ctx.fillStyle === PARSE_PROBE_COLOR) return null;

    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return `rgb(${r}, ${g}, ${b})`;
}
