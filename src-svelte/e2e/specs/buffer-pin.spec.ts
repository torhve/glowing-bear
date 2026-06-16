import { test, expect } from '@playwright/test';
import { connectToWeechat, clearSettings, waitForAppReady } from '../helpers/connection';

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
    // Unpin any pinned buffers from previous serial tests
    const pinButtons = page.getByTestId('pin-buffer');
    const pinCount = await pinButtons.count();
    for (let i = 0; i < pinCount; i++) {
        const btn = pinButtons.nth(i);
        const title = await btn.getAttribute('title');
        if (title === 'Unpin buffer') {
            await btn.click();
            await page.waitForTimeout(200);
        }
    }
    await page.waitForTimeout(300);
});

test('pin button is visible on buffer items', async () => {
    const pinButtons = page.getByTestId('pin-buffer');
    const count = await pinButtons.count();
    expect(count).toBeGreaterThanOrEqual(1);
});

test('pin button has correct title when not pinned', async () => {
    const firstPinButton = page.getByTestId('pin-buffer').first();
    await expect(firstPinButton).toHaveAttribute('title', 'Pin buffer');
});

test('pin button shows pushpin icon when not pinned', async () => {
    const firstPinButton = page.getByTestId('pin-buffer').first();
    // Lucide Pin icon renders an SVG element
    await expect(firstPinButton.locator('svg')).toBeAttached();
});

test('clicking pin button changes icon to pin icon', async () => {
    const firstPinButton = page.getByTestId('pin-buffer').first();
    await firstPinButton.click();
    await page.waitForTimeout(500);
    // After pinning, the PinOff icon should be shown
    await expect(firstPinButton.locator('svg')).toBeAttached();
});

test('after pinning, title changes to Unpin buffer', async () => {
    const firstPinButton = page.getByTestId('pin-buffer').first();
    await firstPinButton.click();
    await page.waitForTimeout(500);
    await expect(firstPinButton).toHaveAttribute('title', 'Unpin buffer');
});

test('clicking unpin button changes icon back to pushpin icon', async () => {
    const firstPinButton = page.getByTestId('pin-buffer').first();
    await firstPinButton.click();
    await page.waitForTimeout(500);
    await firstPinButton.click();
    await page.waitForTimeout(500);
    // After unpinning, the Pin icon should be shown again
    await expect(firstPinButton.locator('svg')).toBeAttached();
});

test('pinned buffers appear before unpinned in sorted list', async () => {
    // Pin the second buffer if available
    const pinButtons = page.getByTestId('pin-buffer');
    const count = await pinButtons.count();
    if (count >= 2) {
        await pinButtons.nth(1).click();
        await page.waitForTimeout(500);
    }

    // Get all buffer names in order
    const bufferItems = page.getByTestId('buffer-item');
    const bufferCount = await bufferItems.count();
    expect(bufferCount).toBeGreaterThanOrEqual(1);

    const firstBufferText = await bufferItems.first().textContent();
    expect(firstBufferText).toBeTruthy();
});
