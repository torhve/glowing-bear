import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { settings } from '#lib/stores/settings.ts';

/**
 * Reload settings.ts the way a fresh page would.
 *
 * The migration runs once, at module load, from what is in localStorage. Each test
 * therefore gets a clean storage and a fresh module graph — the only way to observe
 * what an upgrade from a pre-slot profile does.
 */
async function loadSettingsModule() {
    vi.resetModules();
    const fresh = await import('#lib/stores/settings.ts');
    return fresh.settings;
}

beforeEach(() => {
    localStorage.clear();
});

describe('theme slots (issue #13)', () => {
    it('defaults a fresh profile to dark for dark mode and light for light mode', async () => {
        const store = await loadSettingsModule();
        expect(get(store).themeDark).toBe('dark');
        expect(get(store).themeLight).toBe('light');
    });

    it('keeps a profile that already stores both slots', async () => {
        localStorage.setItem('gb-settings', JSON.stringify({
            themeDark: 'catppuccin-mocha',
            themeLight: 'base16-solarized-light',
        }));
        const store = await loadSettingsModule();
        expect(get(store).themeDark).toBe('catppuccin-mocha');
        expect(get(store).themeLight).toBe('base16-solarized-light');
    });

    it('pins both slots to a pre-slot theme from the settings blob', async () => {
        localStorage.setItem('gb-settings', JSON.stringify({ theme: 'catppuccin-frappe' }));
        const store = await loadSettingsModule();
        expect(get(store).themeDark).toBe('catppuccin-frappe');
        expect(get(store).themeLight).toBe('catppuccin-frappe');
        // The obsolete key must not survive into the store.
        expect('theme' in (get(store) as Record<string, unknown>)).toBe(false);
    });

    it('pins both slots to the pre-slot theme from the old gb_theme key', async () => {
        localStorage.setItem('gb_theme', 'blue-modern');
        const store = await loadSettingsModule();
        expect(get(store).themeDark).toBe('blue-modern');
        expect(get(store).themeLight).toBe('blue-modern');
        // The key is a one-way move: it is read, then removed.
        expect(localStorage.getItem('gb_theme')).toBeNull();
    });

    it('lets already-stored slots beat a stray gb_theme key', async () => {
        localStorage.setItem('gb-settings', JSON.stringify({
            themeDark: 'black',
            themeLight: 'cendre',
        }));
        localStorage.setItem('gb_theme', 'blue-modern');
        const store = await loadSettingsModule();
        expect(get(store).themeDark).toBe('black');
        expect(get(store).themeLight).toBe('cendre');
        expect(localStorage.getItem('gb_theme')).toBeNull();
    });

    it('drops a slot that names a palette that no longer exists', async () => {
        localStorage.setItem('gb-settings', JSON.stringify({
            themeDark: 'no-such-palette',
            themeLight: 'base16-light',
        }));
        const store = await loadSettingsModule();
        expect(get(store).themeDark).toBe('dark');
        expect(get(store).themeLight).toBe('base16-light');
    });

    it('ignores a gb_theme key holding something that was never a palette', async () => {
        localStorage.setItem('gb_theme', 'garbage');
        const store = await loadSettingsModule();
        expect(get(store).themeDark).toBe('dark');
        expect(get(store).themeLight).toBe('light');
        expect(localStorage.getItem('gb_theme')).toBeNull();
    });

    it('persists slot edits to the settings blob', async () => {
        const { updateSettings } = await import('#lib/stores/settings.ts');
        updateSettings({ themeLight: 'cendre' });
        const saved = JSON.parse(localStorage.getItem('gb-settings') ?? '{}');
        expect(saved.themeLight).toBe('cendre');
        expect(saved.themeDark).toBe('dark');
    });

    it('leaves the default settings object intact for the rest of the profile', async () => {
        localStorage.setItem('gb-settings', JSON.stringify({ theme: 'black' }));
        const store = await loadSettingsModule();
        expect(get(store).useFavico).toBe(true);
        expect(get(store).protocol).toBe('auto');
    });
});
