import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { get } from 'svelte/store';
import { themes, themeLabels, isTheme } from '#lib/themes.ts';
import {
    applyConfiguredTheme,
    applyTheme,
    configuredSlots,
    prefersDark,
    resolveTheme,
    startThemeFollow,
    themeSlotsKey,
    themeStore,
} from '#lib/stores/theme.ts';
import { updateSettings } from '#lib/stores/settings.ts';

// jsdom already provides a real localStorage and document, so tests drive those
// directly instead of stubbing globals. The fake matchMedia installed by
// test/unit/setup.ts is flipped through the handle it exposes.
function setSystemDark(dark: boolean) {
    const flip = (window as Window & { __setPrefersColorSchemeDark?: (dark: boolean) => void })
        .__setPrefersColorSchemeDark;
    if (!flip) throw new Error('matchMedia shim missing from test/unit/setup.ts');
    flip(dark);
}

beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.style.removeProperty('--gb-bg');
    setSystemDark(false);
    updateSettings({ themeDark: 'dark', themeLight: 'light' });
});

afterEach(() => {
    // The fake query lists live on a window a worker reuses across test files: leave
    // the scheme where the app's own default puts it.
    setSystemDark(false);
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

describe('isTheme', () => {
    it('accepts a shipped palette', () => {
        expect(isTheme('catppuccin-mocha')).toBe(true);
    });

    it('rejects anything else, including a non-string', () => {
        expect(isTheme('not-a-real-theme')).toBe(false);
        expect(isTheme('')).toBe(false);
        expect(isTheme(undefined)).toBe(false);
        expect(isTheme(7)).toBe(false);
    });
});

describe('resolveTheme', () => {
    const slots = { dark: 'catppuccin-mocha', light: 'base16-solarized-light' } as const;

    it('selects the dark slot when the system prefers dark', () => {
        expect(resolveTheme(slots, true)).toBe('catppuccin-mocha');
    });

    it('selects the light slot otherwise', () => {
        expect(resolveTheme(slots, false)).toBe('base16-solarized-light');
    });

    it('pins one look when both slots hold the same palette', () => {
        const pinned = { dark: 'black', light: 'black' } as const;
        expect(resolveTheme(pinned, true)).toBe('black');
        expect(resolveTheme(pinned, false)).toBe('black');
    });
});

describe('configuredSlots', () => {
    it('reads the pair settings currently holds', () => {
        updateSettings({ themeDark: 'blue', themeLight: 'base16-light' });
        expect(configuredSlots()).toEqual({ dark: 'blue', light: 'base16-light' });
    });
});

describe('prefersDark', () => {
    it('reports the scheme the system reports', () => {
        expect(prefersDark()).toBe(false);
        setSystemDark(true);
        expect(prefersDark()).toBe(true);
    });
});

describe('applyConfiguredTheme', () => {
    it('applies the slot the system selects, to the store and to the document', () => {
        updateSettings({ themeDark: 'catppuccin-mocha', themeLight: 'base16-solarized-light' });

        setSystemDark(true);
        expect(applyConfiguredTheme()).toBe('catppuccin-mocha');
        expect(get(themeStore)).toBe('catppuccin-mocha');
        expect(document.documentElement.getAttribute('data-theme')).toBe('catppuccin-mocha');

        setSystemDark(false);
        expect(applyConfiguredTheme()).toBe('base16-solarized-light');
        expect(get(themeStore)).toBe('base16-solarized-light');
        expect(document.documentElement.getAttribute('data-theme')).toBe('base16-solarized-light');
    });
});

describe('startThemeFollow', () => {
    it('re-applies the matching slot on a system flip with no settings change', () => {
        updateSettings({ themeDark: 'black', themeLight: 'light' });
        setSystemDark(true);
        applyConfiguredTheme();
        expect(document.documentElement.getAttribute('data-theme')).toBe('black');

        const stop = startThemeFollow();
        try {
            setSystemDark(false);
            expect(document.documentElement.getAttribute('data-theme')).toBe('light');
            expect(get(themeStore)).toBe('light');
        } finally {
            stop();
        }
    });

    it('stops writing the document once its owner stops it', () => {
        setSystemDark(true);
        applyConfiguredTheme();

        const stop = startThemeFollow();
        stop();

        setSystemDark(false);
        expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    });
});

describe('themeSlotsKey', () => {
    it('notifies only when a palette slot changes', () => {
        const seen: string[] = [];
        const unsub = themeSlotsKey.subscribe((value) => seen.push(value));
        try {
            expect(seen).toEqual(['dark|light']);

            // An unrelated setting must not look like an appearance change.
            updateSettings({ fontfamily: 'monospace' });
            expect(seen.length).toBe(1);

            updateSettings({ themeLight: 'cendre' });
            expect(seen).toEqual(['dark|light', 'dark|cendre']);
        } finally {
            unsub();
        }
    });
});

describe('theme-color meta tag', () => {
    it('follows the palette that was applied', () => {
        const meta = document.createElement('meta');
        meta.name = 'theme-color';
        meta.content = '#181818';
        document.head.appendChild(meta);

        try {
            document.documentElement.style.setProperty('--gb-bg', '#abcdef');
            applyTheme('light');
            expect(meta.getAttribute('content')).toBe('#abcdef');

            document.documentElement.style.setProperty('--gb-bg', '#000000');
            applyTheme('black');
            expect(meta.getAttribute('content')).toBe('#000000');
        } finally {
            meta.remove();
        }
    });

    it('leaves the document alone when there is no theme-color tag', () => {
        expect(document.querySelector('meta[name="theme-color"]')).toBeNull();
        expect(() => applyTheme('dark')).not.toThrow();
    });
});
