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
] as const;

export type Theme = typeof themes[number];

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
