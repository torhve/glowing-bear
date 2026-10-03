import { describe, it, expect, beforeEach } from 'vitest';
import { themes, themeLabels, setTheme, loadTheme, themeStore } from '#lib/stores/theme.ts';
import { get } from 'svelte/store';

// jsdom already provides a real localStorage and document, so tests drive those
// directly instead of stubbing globals.
beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
});

describe('themes array', () => {
    it('contains all original themes', () => {
        const originals = ['dark', 'light', 'black', 'dark-spacious', 'blue', 'blue-modern', 'base16-default', 'base16-light', 'base16-mocha', 'base16-ocean-dark', 'base16-solarized-dark', 'base16-solarized-light'];
        for (const t of originals) {
            expect(themes).toContain(t);
        }
    });

    it('contains all four Catppuccin themes', () => {
        expect(themes).toContain('catppuccin-mocha');
        expect(themes).toContain('catppuccin-macchiato');
        expect(themes).toContain('catppuccin-frappe');
        expect(themes).toContain('light');
    });

    it('has Catppuccin themes grouped at the end', () => {
        const catppuccinStart = themes.findIndex(t => t.startsWith('catppuccin-'));
        expect(catppuccinStart).toBeGreaterThan(-1);
        for (let i = catppuccinStart; i < themes.length; i++) {
            expect(themes[i]).toMatch(/^catppuccin-/);
        }
    });
});

describe('themeLabels', () => {
    it('has entries for all themes in the array', () => {
        for (const theme of themes) {
            expect(themeLabels[theme]).toBeDefined();
            expect(themeLabels[theme]).toBeTruthy();
        }
    });

    it('maps Catppuccin themes to friendly labels with icons', () => {
        expect(themeLabels['catppuccin-mocha']).toBe('☕ Catppuccin Mocha');
        expect(themeLabels['catppuccin-macchiato']).toBe('🌿 Catppuccin Macchiato');
        expect(themeLabels['catppuccin-frappe']).toBe('🌺 Catppuccin Frappé');
        expect(themeLabels['light']).toBe('Light');
    });

    it('maps original themes to simple labels', () => {
        expect(themeLabels['dark']).toBe('Dark');
        expect(themeLabels['light']).toBe('Light');
        expect(themeLabels['black']).toBe('Black');
        expect(themeLabels['dark-spacious']).toBe('Dark Spacious');
    });
});

describe('get theme from store', () => {
    it('returns current theme from store', () => {
        const theme = get(themeStore);
        expect(themes).toContain(theme);
    });
});

describe('setTheme', () => {
    it('updates the store value for a valid theme', () => {
        setTheme('catppuccin-mocha');
        expect(get(themeStore)).toBe('catppuccin-mocha');
    });

    it('cycles through all Catppuccin themes', () => {
        for (const t of ['catppuccin-mocha', 'catppuccin-macchiato', 'catppuccin-frappe']) {
            setTheme(t);
            expect(get(themeStore)).toBe(t);
        }
    });
});

describe('loadTheme', () => {
    it('returns "dark" when no stored theme', () => {
        expect(loadTheme()).toBe('dark');
    });

    it('returns stored Catppuccin theme when available', () => {
        localStorage.setItem('gb_theme', 'catppuccin-mocha');
        expect(loadTheme()).toBe('catppuccin-mocha');
    });

    it('returns "dark" for unknown stored theme', () => {
        localStorage.setItem('gb_theme', 'not-a-real-theme');
        expect(loadTheme()).toBe('dark');
    });

    it('returns each Catppuccin variant correctly', () => {
        for (const t of ['catppuccin-mocha', 'catppuccin-macchiato', 'catppuccin-frappe']) {
            localStorage.setItem('gb_theme', t);
            expect(loadTheme()).toBe(t);
        }
    });

    it('setTheme persists the choice to localStorage and the document', () => {
        setTheme('catppuccin-frappe');
        expect(localStorage.getItem('gb_theme')).toBe('catppuccin-frappe');
        expect(document.documentElement.getAttribute('data-theme')).toBe('catppuccin-frappe');
    });
});