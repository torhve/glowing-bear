import { describe, it, expect, vi, beforeEach } from 'vitest';
import { themes, themeLabels, setTheme, loadTheme, themeStore } from '$lib/stores/theme';
import { get } from 'svelte/store';

// Mock localStorage and document for DOM-dependent functions
beforeEach(() => {
    vi.stubGlobal('localStorage', {
        getItem: vi.fn(),
        setItem: vi.fn(),
        removeItem: vi.fn(),
    });
    vi.stubGlobal('document', {
        documentElement: {
            setAttribute: vi.fn(),
        },
    });
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
        (localStorage.getItem as vi.Mock).mockReturnValue(null);
        expect(loadTheme()).toBe('dark');
    });

    it('returns stored Catppuccin theme when available', () => {
        (localStorage.getItem as vi.Mock).mockImplementation((key) => {
            if (key === 'gb_theme') return 'catppuccin-mocha';
            return null;
        });
        expect(loadTheme()).toBe('catppuccin-mocha');
    });

    it('returns "dark" for unknown stored theme', () => {
        (localStorage.getItem as vi.Mock).mockImplementation((key) => {
            if (key === 'gb_theme') return 'not-a-real-theme';
            return null;
        });
        expect(loadTheme()).toBe('dark');
    });

    it('returns each Catppuccin variant correctly', () => {
        for (const t of ['catppuccin-mocha', 'catppuccin-macchiato', 'catppuccin-frappe']) {
            (localStorage.getItem as vi.Mock).mockImplementation((key) => {
                if (key === 'gb_theme') return t;
                return null;
            });
            expect(loadTheme()).toBe(t);
        }
    });
});