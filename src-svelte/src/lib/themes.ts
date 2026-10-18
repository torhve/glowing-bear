/**
 * The shipped palettes and their display labels.
 *
 * Pure data with no imports, deliberately kept out of `stores/theme.ts`:
 * `stores/settings.ts` has to recognise a stored palette while it migrates an old
 * profile, and `stores/theme.ts` imports the settings store. Reading the list from
 * the store module would turn that into a runtime import cycle whose values are not
 * initialised yet when the migration runs.
 *
 * Every name here is a `[data-theme="<name>"]` block in `app.css`; adding a palette
 * means adding both.
 */
export const themes = [
    'dark',
    'light',
    'black',
    'dark-spacious',
    'blue',
    'blue-modern',
    'base16-default',
    'base16-light',
    'base16-mocha',
    'base16-ocean-dark',
    'base16-solarized-dark',
    'base16-solarized-light',
    'cendre',
    'catppuccin-mocha',
    'catppuccin-macchiato',
    'catppuccin-frappe',
] as const;

export type Theme = typeof themes[number];

// Display-friendly labels for the theme selectors
export const themeLabels: Record<Theme, string> = {
    'dark': 'Dark',
    'light': 'Light',
    'black': 'Black',
    'dark-spacious': 'Dark Spacious',
    'blue': 'Blue',
    'blue-modern': 'Blue Modern',
    'base16-default': 'Base16 Default',
    'base16-light': 'Base16 Light',
    'base16-mocha': 'Base16 Mocha',
    'base16-ocean-dark': 'Base16 Ocean Dark',
    'base16-solarized-dark': 'Base16 Solarized Dark',
    'base16-solarized-light': 'Base16 Solarized Light',
    'catppuccin-mocha': '☕ Catppuccin Mocha',
    'catppuccin-macchiato': '🌿 Catppuccin Macchiato',
    'catppuccin-frappe': '🌺 Catppuccin Frappé',
    'cendre': '🔥 Cendre',
};

/** Guard a palette name that came from localStorage or a hand-edited settings blob. */
export function isTheme(value: unknown): value is Theme {
    return typeof value === 'string' && (themes as readonly string[]).includes(value);
}
