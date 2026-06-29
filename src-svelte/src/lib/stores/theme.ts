import { writable } from 'svelte/store';

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
    'catppuccin-mocha',
    'catppuccin-macchiato',
    'catppuccin-frappe',
] as const;

export type Theme = typeof themes[number];

// Display-friendly labels for the theme selector dropdown
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
};

export const themeStore = writable<Theme>('dark');

// Theme CSS variables (--gb-*) are now baked into the built app.css bundle.
// Only need to set the data-theme attribute on <html> to activate a theme.

export function setTheme(theme: Theme) {
    themeStore.set(theme);
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('gb_theme', theme);
}

export function loadTheme(): Theme {
    const stored = localStorage.getItem('gb_theme') as Theme | null;
    if (stored && themes.includes(stored)) {
        return stored;
    }
    return 'dark';
}

export function initTheme() {
    const theme = loadTheme();
    themeStore.set(theme);
    document.documentElement.setAttribute('data-theme', theme);
}
