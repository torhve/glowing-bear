import { test, expect } from '@playwright/test';
import { connectToWeechat, waitForAppReady } from '../helpers/connection';
import { openSettings, closeSettings } from '../helpers/settings';

import { createConnectedPage } from '../fixtures/auth';

let page: import('@playwright/test').Page;

test.describe.configure({ mode: 'serial' });

// The app follows the system light/dark scheme (issue #13), so a test must say
// which one it is in. Light is the default the app's own defaults were written for.
test.beforeEach(async () => {
    await page.emulateMedia({ colorScheme: 'light' });
    const modalVisible = await page.getByTestId('settings-modal').isVisible().catch(() => false);
    if (modalVisible) {
        await closeSettings(page);
    }
});

/**
 * Choose both slots the way the modal does and close it. The page then re-resolves
 * on its own: no theme is applied by this spec, only by the app.
 */
async function setSlots(dark: string, light: string) {
    await openSettings(page);
    await page.getByTestId('theme-dark-selector').selectOption({ value: dark });
    await page.getByTestId('theme-light-selector').selectOption({ value: light });
    await closeSettings(page);
}

const appliedTheme = () =>
    page.evaluate(() => document.documentElement.getAttribute('data-theme'));

test.beforeAll(async ({ browser }) => {
    page = await createConnectedPage(browser);
});

test.afterAll(async () => {
    await page.close();
});

// Both slots list the full palette set; picking any palette in either is legal.
test('both theme selectors list every shipped palette', async () => {
    // Initial load under the emulated light scheme: default slots resolve to the
    // light palette and the browser chrome follows. The suite pins colorScheme 'dark'
    // globally, so this is the light-side initial-load coverage.
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#eff1f5');
    await openSettings(page);
    for (const testId of ['theme-dark-selector', 'theme-light-selector']) {
        const options = page.getByTestId(testId).locator('option');
        await expect(options).toHaveCount(16);
        const values = await options.evaluateAll((opts) => opts.map((o) => o.value));
        expect(values).toContain('dark');
        expect(values).toContain('light');
        expect(values).toContain('blue-modern');
        expect(values).toContain('catppuccin-mocha');
        expect(values).toContain('base16-solarized-light');
    }
});

// The emulated scheme selects its slot; the acceptance criterion for issue #13 is
// the second step — a live flip, no reload.
test('the emulated scheme selects its slot', async () => {
    await setSlots('catppuccin-mocha', 'base16-solarized-light');
    expect(await appliedTheme()).toBe('base16-solarized-light');

    await page.emulateMedia({ colorScheme: 'dark' });
    await expect.poll(appliedTheme).toBe('catppuccin-mocha');
});

test('a system flip re-applies the matching slot in both directions', async () => {
    await setSlots('black', 'light');
    expect(await appliedTheme()).toBe('light');

    await page.emulateMedia({ colorScheme: 'dark' });
    await expect.poll(appliedTheme).toBe('black');

    await page.emulateMedia({ colorScheme: 'light' });
    await expect.poll(appliedTheme).toBe('light');
});

test('slot choices persist across a reload', async () => {
    await setSlots('catppuccin-mocha', 'base16-solarized-light');

    await page.reload();
    await waitForAppReady(page);
    await connectToWeechat(page);

    expect(await appliedTheme()).toBe('base16-solarized-light');

    const saved = await page.evaluate(() =>
        JSON.parse(localStorage.getItem('gb-settings') ?? '{}'),
    );
    expect(saved.themeDark).toBe('catppuccin-mocha');
    expect(saved.themeLight).toBe('base16-solarized-light');
});

// A profile from before issue #13 stored a single palette. Upgrading must not
// repaint it, so that palette pins both slots.
test('a pre-slot theme pins both slots', async () => {
    await page.evaluate(() => {
        localStorage.setItem('gb-settings', JSON.stringify({ theme: 'catppuccin-frappe' }));
    });
    await page.reload();
    await waitForAppReady(page);
    await connectToWeechat(page);

    await openSettings(page);
    await expect(page.getByTestId('theme-dark-selector')).toHaveValue('catppuccin-frappe');
    await expect(page.getByTestId('theme-light-selector')).toHaveValue('catppuccin-frappe');
    await closeSettings(page);

    // The same holds for the old standalone key the theme store used to write.
    await page.evaluate(() => {
        localStorage.setItem('gb-settings', JSON.stringify({}));
        localStorage.setItem('gb_theme', 'blue-modern');
    });
    await page.reload();
    await waitForAppReady(page);
    await connectToWeechat(page);

    await openSettings(page);
    await expect(page.getByTestId('theme-dark-selector')).toHaveValue('blue-modern');
    await expect(page.getByTestId('theme-light-selector')).toHaveValue('blue-modern');
    await closeSettings(page);

    // The key is a one-way move: it is read, then removed.
    expect(await page.evaluate(() => localStorage.getItem('gb_theme'))).toBeNull();
});

// <meta name="theme-color"> tints the PWA/mobile browser chrome. It must follow
// the palette that is actually on screen — a hex palette passes through and the
// oklch one (blue-modern) arrives serialised to sRGB.
test('the browser chrome colour follows the active palette', async () => {
    const metaColor = () =>
        page.evaluate(
            () => document.querySelector('meta[name="theme-color"]')?.getAttribute('content') ?? null,
        );

    // Light is emulated, so the oklch palette is the one on screen.
    await setSlots('dark', 'blue-modern');
    await expect.poll(metaColor).toMatch(/^rgb\(\d+,\s*\d+,\s*\d+\)$/);

    await page.emulateMedia({ colorScheme: 'dark' });
    await expect.poll(metaColor).toBe('#181818');
});
