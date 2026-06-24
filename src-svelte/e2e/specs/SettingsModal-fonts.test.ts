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

// --- Font Family Tests ---

test('should have font family text input in settings modal', async () => {
    await openSettings(page);
    const input = page.getByTestId('font-family-input');
    await expect(input).toBeVisible();
    await expect(input).toHaveAttribute('placeholder', 'Inconsolata, Consolas, Monaco, monospace');
});

test('should accept custom font family value', async () => {
    await openSettings(page);
    const input = page.getByTestId('font-family-input');

    const customFont = 'Fira Code, monospace';
    await input.fill(customFont);
    await expect(input).toHaveValue(customFont);
});

test('should persist font family to localStorage', async () => {
    await openSettings(page);
    const input = page.getByTestId('font-family-input');

    const customFont = 'Liberation Mono, monospace';
    await input.fill(customFont);
    await expect(input).toHaveValue(customFont);

    await closeSettings(page);

    const stored = await page.evaluate(() => {
        const saved = localStorage.getItem('gb-settings');
        if (!saved) return null;
        try {
            return JSON.parse(saved).fontfamily || null;
        } catch {
            return null;
        }
    });
    expect(stored).toBe(customFont);
});

test('should load font family from localStorage on reload', async () => {
    await openSettings(page);
    const input = page.getByTestId('font-family-input');

    const customFont = 'DejaVu Sans Mono, monospace';
    await input.fill(customFont);
    await closeSettings(page);

    await page.reload();
    await waitForAppReady(page);
    await connectToWeechat(page);
    await openSettings(page);

    await expect(input).toHaveValue(customFont);
});

// --- Font Size Tests ---

test('should have font size text input and slider in settings modal', async () => {
    await openSettings(page);
    const textInput = page.getByTestId('font-size-input');
    const slider = page.getByTestId('font-size-slider');
    await expect(textInput).toBeVisible();
    await expect(slider).toBeVisible();
    await expect(slider).toHaveAttribute('min', '6');
    await expect(slider).toHaveAttribute('max', '36');
});

test('should update text field when slider moves', async () => {
    await openSettings(page);
    const slider = page.getByTestId('font-size-slider');
    const textInput = page.getByTestId('font-size-input');

    // Type a new value into the text field first to set initial state
    await textInput.fill('20px');

    // Wait for the effect to sync the slider position
    await expect(async () => {
        const val = await slider.inputValue();
        expect(val).toBe('20');
    }).toPass({ timeout: 2000, intervals: [50] });

    // Now move the slider to 28
    await slider.evaluate((el) => { (el as HTMLInputElement).value = '28'; el.dispatchEvent(new Event('input', { bubbles: true })); });

    // Wait for text field to update
    await expect(textInput).toHaveValue('28px', { timeout: 2000 });
});

test('should persist font size to localStorage', async () => {
    await openSettings(page);
    const textInput = page.getByTestId('font-size-input');

    await textInput.fill('18px');
    await expect(textInput).toHaveValue('18px');

    await closeSettings(page);

    const stored = await page.evaluate(() => {
        const saved = localStorage.getItem('gb-settings');
        if (!saved) return null;
        try {
            return JSON.parse(saved).fontsize || null;
        } catch {
            return null;
        }
    });
    expect(stored).toBe('18px');
});

test('should load font size from localStorage on reload', async () => {
    await openSettings(page);
    const textInput = page.getByTestId('font-size-input');

    await textInput.fill('22px');
    await closeSettings(page);

    await page.reload();
    await waitForAppReady(page);
    await connectToWeechat(page);
    await openSettings(page);

    await expect(textInput).toHaveValue('22px');

    // Also verify slider synced
    const slider = page.getByTestId('font-size-slider');
    await expect(async () => {
        const val = await slider.inputValue();
        expect(val).toBe('22');
    }).toPass({ timeout: 2000, intervals: [50] });
});
