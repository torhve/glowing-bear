import { test, expect } from '@playwright/test';
import { createConnectedPage } from '../fixtures/auth';

import { setupEffectOrphanFilter } from '../helpers/pageerror';

let page: import('@playwright/test').Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
    page = await createConnectedPage(browser);
    setupEffectOrphanFilter(page)
});

test.afterAll(async () => {
    await page.close();
});

test.beforeEach(async () => {
    setupEffectOrphanFilter(page)
    // Unpin any pinned buffers from previous serial tests
    const pinButtons = page.getByTestId('pin-buffer');
    const pinCount = await pinButtons.count();
    for (let i = 0; i < pinCount; i++) {
        const btn = pinButtons.nth(i);
        const title = await btn.getAttribute('title');
        if (title === 'Unpin buffer') {
            await btn.click({ force: true });
            await expect(btn).toHaveAttribute('title', 'Pin buffer', { timeout: 5000 });
        }
    }
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
    await firstPinButton.click({ force: true });
    await expect(firstPinButton).toHaveAttribute('title', 'Unpin buffer', { timeout: 5000 });
    // After pinning, the PinOff icon should be shown
    await expect(firstPinButton.locator('svg')).toBeAttached();
});

test('after pinning, title changes to Unpin buffer', async () => {
    const firstPinButton = page.getByTestId('pin-buffer').first();
    await firstPinButton.click({ force: true });
    await expect(firstPinButton).toHaveAttribute('title', 'Unpin buffer');
});

test('clicking unpin button changes icon back to pushpin icon', async () => {
    const firstPinButton = page.getByTestId('pin-buffer').first();
    await firstPinButton.click({ force: true });
    await expect(firstPinButton).toHaveAttribute('title', 'Unpin buffer', { timeout: 5000 });
    await firstPinButton.click({ force: true });
    await expect(firstPinButton).toHaveAttribute('title', 'Pin buffer', { timeout: 5000 });
    // After unpinning, the Pin icon should be shown again
    await expect(firstPinButton.locator('svg')).toBeAttached();
});

test('pinned buffers appear before unpinned in sorted list', async () => {
    // Pin a buffer and verify it moves to the top of the sorted list.
    // After pinning, the list re-sorts (pinned first), so we identify
    // the pinned buffer by its text content, not by index position.
    const bufferItems = page.getByTestId('buffer-item');
    const count = await bufferItems.count();
    expect(count).toBeGreaterThanOrEqual(2);

    // Identify the second buffer item by its text content before pinning
    const targetName = await bufferItems.nth(1).textContent();
    const targetBuffer = page.getByTestId('buffer-item').filter({ hasText: targetName?.trim() || '' }).first();
    const targetPinButton = targetBuffer.getByTestId('pin-buffer');

    await targetPinButton.click({ force: true });
    // Wait for re-sort — identify the same buffer by text content
    await expect(targetBuffer.getByTestId('pin-buffer')).toHaveAttribute('title', 'Unpin buffer', { timeout: 5000 });

    // Get all buffer items and their pin button titles to determine pinned status
    const bufferCount = await bufferItems.count();
    expect(bufferCount).toBeGreaterThanOrEqual(2);

    // Collect buffer names and whether each is pinned
    const bufferData: { name: string; pinned: boolean }[] = [];
    for (let i = 0; i < bufferCount; i++) {
        const name = await bufferItems.nth(i).textContent();
        // Check the pin button title on this specific buffer item
        const pinBtn = bufferItems.nth(i).getByTestId('pin-buffer');
        const title = await pinBtn.getAttribute('title');
        bufferData.push({ name: name || '', pinned: title === 'Unpin buffer' });
    }

    // All pinned buffers should appear before all unpinned buffers
    let foundUnpinned = false;
    for (const buf of bufferData) {
        if (buf.pinned && foundUnpinned) {
            // A pinned buffer appeared after an unpinned one — failure
            throw new Error(`Pinned buffer "${buf.name}" found after unpinned buffer`);
        }
        if (!buf.pinned) {
            foundUnpinned = true;
        }
    }
});
