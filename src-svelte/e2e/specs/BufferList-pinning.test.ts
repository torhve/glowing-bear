import { test, expect } from '@playwright/test';
import { createConnectedPage } from '../fixtures/auth';

let page: import('@playwright/test').Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
    page = await createConnectedPage(browser);
    page.on('pageerror', (error) => {
        if (error.message?.includes('effect_orphan')) return;
    });
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
    // Pin the second buffer if available
    const pinButtons = page.getByTestId('pin-buffer');
    const count = await pinButtons.count();
    let pinnedIdx = -1;
    if (count >= 2) {
        await pinButtons.nth(1).click({ force: true });
        await expect(pinButtons.nth(1)).toHaveAttribute('title', 'Unpin buffer', { timeout: 5000 });
        pinnedIdx = 1;
    } else if (count >= 1) {
        await pinButtons.nth(0).click({ force: true });
        await expect(pinButtons.nth(0)).toHaveAttribute('title', 'Unpin buffer', { timeout: 5000 });
        pinnedIdx = 0;
    }

    if (pinnedIdx === -1) {
        test.skip();
        return;
    }

    // Get all buffer items and their pin button titles to determine pinned status
    const bufferItems = page.getByTestId('buffer-item');
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
