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
    // Close settings if still open from a previous test
    const modalVisible = await page.getByTestId('settings-modal').isVisible().catch(() => false);
    if (modalVisible) {
        await closeSettings(page);
    }
});

test('should have custom CSS textarea in settings modal', async () => {
    await openSettings(page);
    const textarea = page.getByTestId('custom-css-textarea');
    await expect(textarea).toBeVisible();
    await expect(textarea).toHaveAttribute('placeholder', '/* Your custom CSS here */');
});

test('should type into custom CSS textarea and see value persist', async () => {
    await openSettings(page);
    const textarea = page.getByTestId('custom-css-textarea');

    const testCss = 'body { background-color: red; }';
    await textarea.fill(testCss);

    // The value should reflect what was typed
    await expect(textarea).toHaveValue(testCss);
});

test('should persist custom CSS to localStorage', async () => {
    await openSettings(page);
    const textarea = page.getByTestId('custom-css-textarea');

    const testCss = '.nick { font-weight: bold; }';
    await textarea.fill(testCss);
    await expect(textarea).toHaveValue(testCss);

    await closeSettings(page);

    // Read back from localStorage via the dev helper
    const stored = await page.evaluate(() => {
        const saved = localStorage.getItem('gb-settings');
        if (!saved) return '';
        try {
            return JSON.parse(saved).customCSS || '';
        } catch {
            return '';
        }
    });
    expect(stored).toBe(testCss);
});

test('should load custom CSS from localStorage on reload', async () => {
    await openSettings(page);
    const textarea = page.getByTestId('custom-css-textarea');

    const testCss = 'body { color: blue; }';
    await textarea.fill(testCss);
    await closeSettings(page);

    // Reload and reconnect
    await page.reload();
    await waitForAppReady(page);
    await connectToWeechat(page);
    await openSettings(page);

    await expect(textarea).toHaveValue(testCss);
});

test('should inject custom CSS into document head', async () => {
    await openSettings(page);
    const textarea = page.getByTestId('custom-css-textarea');

    const testCss = '.test-custom-css { display: none; }';
    await textarea.fill(testCss);
    await expect(textarea).toHaveValue(testCss);

    // Check that the style tag was injected into <head>
    const injectedCss = await page.evaluate(() => {
        const tag = document.getElementById('custom-css-tag');
        return tag ? tag.textContent : '';
    });
    expect(injectedCss).toBe(testCss);
});

test('should update injected CSS when custom CSS changes', async () => {
    await openSettings(page);
    const textarea = page.getByTestId('custom-css-textarea');

    const css1 = '.first { color: red; }';
    await textarea.fill(css1);
    await expect(textarea).toHaveValue(css1);

    let injectedCss = await page.evaluate(() => {
        const tag = document.getElementById('custom-css-tag');
        return tag ? tag.textContent : '';
    });
    expect(injectedCss).toBe(css1);

    const css2 = '.second { color: blue; }';
    await textarea.fill(css2);
    await expect(textarea).toHaveValue(css2);

    injectedCss = await page.evaluate(() => {
        const tag = document.getElementById('custom-css-tag');
        return tag ? tag.textContent : '';
    });
    expect(injectedCss).toBe(css2);
});

test('should remove injected CSS when custom CSS is cleared', async () => {
    await openSettings(page);
    const textarea = page.getByTestId('custom-css-textarea');

    await textarea.fill('.temp { margin: 0; }');
    await expect(textarea).toHaveValue('.temp { margin: 0; }');

    // Verify it was injected
    let injectedCss = await page.evaluate(() => {
        const tag = document.getElementById('custom-css-tag');
        return tag ? tag.textContent : '';
    });
    expect(injectedCss).toBe('.temp { margin: 0; }');

    // Clear the field
    await textarea.clear();
    await expect(textarea).toHaveValue('');

    // Verify the style tag was removed
    const tagExists = await page.evaluate(() => {
        return document.getElementById('custom-css-tag') !== null;
    });
    expect(tagExists).toBe(false);
});
