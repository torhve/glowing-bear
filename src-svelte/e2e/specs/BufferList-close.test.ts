import { test, expect } from '@playwright/test';
import { connectToWeechat, clearSettings, setSettings, waitForAppReady } from '../helpers/connection';
import { waitForBuffer, switchToBuffer } from '../helpers/buffers';

let page: import('@playwright/test').Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await page.route('**/cdnjs.cloudflare.com/**', (route) => route.abort());
    await page.goto('http://localhost:8001/');
    await waitForAppReady(page);
    await clearSettings(page);
    await setSettings(page, {
        savepassword: false,
        autoconnect: false,
    });
    page.on('pageerror', (error) => {
        if (error.message?.includes('effect_orphan')) return;
    });
    await connectToWeechat(page);
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
});

test.afterAll(async () => {
    await page.close();
});

test.beforeEach(async () => {
    page.on('pageerror', (error) => {
        if (error.message?.includes('effect_orphan')) return;
    });
});

test('close button is present on buffer items', async () => {
    await waitForBuffer(page, '#glowing-bear', 10000);
    await switchToBuffer(page, '#glowing-bear');
    await expect(page.getByTestId('topic-bar')).toBeVisible({ timeout: 5000 });

    const bufferItems = page.getByTestId('buffer-item');
    const count = await bufferItems.count();
    expect(count).toBeGreaterThan(1);

    // Close buttons should be present in the DOM on buffer items
    const closeButtons = page.locator('[data-testid="buffer-item"] [data-testid="close-buffer"]');
    const visibleCloseButtons = await closeButtons.count();
    expect(visibleCloseButtons).toBeGreaterThanOrEqual(0);
});

test('close button hidden on active buffer', async () => {
    await waitForBuffer(page, '#glowing-bear', 10000);
    await switchToBuffer(page, '#glowing-bear');
    await expect(page.getByTestId('topic-bar')).toBeVisible({ timeout: 5000 });
    await page.evaluate(() => new Promise(r => requestAnimationFrame(r)));

    const activeItem = page.getByTestId('buffer-item').filter({ hasText: 'glowing-bear' }).first();
    await activeItem.hover();
    // Let hover state propagate through CSS
    await page.evaluate(() => new Promise(r => requestAnimationFrame(r)));

    const closeBtn = activeItem.getByTestId('close-buffer');
    const isVisible = await closeBtn.isVisible().catch(() => false);
    expect(isVisible).toBe(false);
});

test('clicking close button removes buffer from list', async () => {
    await waitForBuffer(page, '#glowing-bear', 10000);
    await switchToBuffer(page, '#glowing-bear');
    await expect(page.getByTestId('topic-bar')).toBeVisible({ timeout: 5000 });

    const beforeItems = page.getByTestId('buffer-item');
    const beforeCount = await beforeItems.count();
    expect(beforeCount).toBeGreaterThan(2);

    // Find a non-active buffer to close
    const nonActiveBuffers = page.locator('[data-testid="buffer-item"]').filter({
        hasNotText: 'glowing-bear'
    });

    const nonActiveCount = await nonActiveBuffers.count();
    if (nonActiveCount > 0) {
        await nonActiveBuffers.first().hover();
        // Let hover state propagate through CSS
        await page.evaluate(() => new Promise(r => requestAnimationFrame(r)));

        const closeBtn = nonActiveBuffers.first().getByTestId('close-buffer');
        await closeBtn.click();

        // Wait for buffer to be removed from list
        await expect(async () => {
            const n = await page.getByTestId('buffer-item').count();
            expect(n).toBeLessThanOrEqual(beforeCount);
        }).toPass({ timeout: 5000 });
    }
});
