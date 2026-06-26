import { test, expect } from '@playwright/test';
import { clearSettings, connectToWeechat, waitForAppReady } from '../helpers/connection';
import { openSettings, closeSettings } from '../helpers/settings';

let page: import('@playwright/test').Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await page.goto('http://localhost:8001/');
    await waitForAppReady(page);
    await clearSettings(page);
    page.on('pageerror', (error) => {
        if (error.message?.includes('effect_orphan')) return;
    });
    await connectToWeechat(page);
});

test.afterAll(async () => {
    await page.close();
});

test.beforeEach(async () => {
    page.on('pageerror', (error) => {
        if (error.message?.includes('effect_orphan')) return;
    });
    const modalVisible = await page.getByTestId('settings-modal').isVisible().catch(() => false);
    if (modalVisible) {
        await closeSettings(page);
    }
});

// Catppuccin themes appear in the dropdown with friendly labels
const catppuccinThemes = [
    { id: 'catppuccin-mocha', label: '☕ Catppuccin Mocha' },
    { id: 'catppuccin-macchiato', label: '🌿 Catppuccin Macchiato' },
    { id: 'catppuccin-frappe', label: '🌺 Catppuccin Frappé' },
    { id: 'catppuccin-latte', label: '🪴 Catppuccin Latte' },
];

test('should list all Catppuccin themes in the theme selector', async () => {
    await openSettings(page);
    const selector = page.getByTestId('theme-selector');
    await expect(selector).toBeVisible();

    for (const { label } of catppuccinThemes) {
        await expect(selector).toContainText(label);
    }
});

// Selecting a Catppuccin theme updates data-theme attribute and applies correct CSS variables
for (const { id, label } of catppuccinThemes) {
    test(`selecting "${label}" should set data-theme="${id}"`, async () => {
        await openSettings(page);
        const selector = page.getByTestId('theme-selector');
        await selector.selectOption({ value: id });

        const themeAttr = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
        expect(themeAttr).toBe(id);
    });
}

test('Catppuccin Mocha should apply correct background color', async () => {
    await openSettings(page);
    await page.getByTestId('theme-selector').selectOption({ value: 'catppuccin-mocha' });

    const bgColor = await page.evaluate(() => {
        const root = document.documentElement;
        return getComputedStyle(root).getPropertyValue('--gb-bg').trim();
    });
    expect(bgColor).toBe('#1e1e2e');
});

test('Catppuccin Latte should apply correct background color', async () => {
    await openSettings(page);
    await page.getByTestId('theme-selector').selectOption({ value: 'catppuccin-latte' });

    const bgColor = await page.evaluate(() => {
        const root = document.documentElement;
        return getComputedStyle(root).getPropertyValue('--gb-bg').trim();
    });
    expect(bgColor).toBe('#eff1f5');
});

test('theme selection should persist to localStorage', async () => {
    await openSettings(page);
    await page.getByTestId('theme-selector').selectOption({ value: 'catppuccin-frappe' });
    await closeSettings(page);

    const storedTheme = await page.evaluate(() => {
        const saved = localStorage.getItem('gb-settings');
        if (!saved) return null;
        try {
            return JSON.parse(saved).theme || null;
        } catch {
            return null;
        }
    });
    expect(storedTheme).toBe('catppuccin-frappe');
});

test('Catppuccin theme should survive page reload', async () => {
    await openSettings(page);
    await page.getByTestId('theme-selector').selectOption({ value: 'catppuccin-macchiato' });
    await closeSettings(page);

    await page.reload();
    await waitForAppReady(page);
    await connectToWeechat(page);

    const themeAttr = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    expect(themeAttr).toBe('catppuccin-macchiato');
});
