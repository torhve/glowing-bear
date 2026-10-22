import { test, expect } from '@playwright/test';
import { connectToWeechat, disconnect, reconnect, clearSettings, setSettings, waitForAppReady } from '../helpers/connection';
import { switchToBuffer, waitForBuffer } from '../helpers/buffers';
import { swipeOnDocument, swipeOnElement } from '../helpers/touch';

import { createConnectedPage } from '../fixtures/auth';



let page: import('@playwright/test').Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
    page = await createConnectedPage(browser);
});

test.afterAll(async () => {
    await page.close();
});

// Get the current active buffer's short name from the topic bar
async function getCurrentBufferName(p: import('@playwright/test').Page): Promise<string> {
    // Read directly from .topic-channel-name span to get clean buffer name
    const channelName = await p.locator('.topic-channel-name').textContent();
    return channelName?.trim() || '';
}

test('vertical swipe on chat area does not switch buffers', async () => {
    // Fresh connection to ensure clean state
    await clearSettings(page);
    await setSettings(page, { showNicklist: false });
    await page.goto('http://localhost:8001/');
    await waitForAppReady(page);
    await page.setViewportSize({ width: 375, height: 667 });
    await connectToWeechat(page);

    // Use existing #glowing-bear buffer
    await waitForBuffer(page, 'glowing-bear', 10000);
    await switchToBuffer(page, 'glowing-bear');

    const beforeBuffer = await getCurrentBufferName(page);
    expect(beforeBuffer).toBe('#glowing-bear');

    const width = 375;
    const height = 667;

    // Vertical swipe inside chat-messages area (scrolling up then down)
    // startY is near middle of viewport, endY scrolls significantly downward
    await swipeOnElement(
        page,
        '[data-testid="chat-messages"]',
        width / 2,
        height * 0.3,
        width / 2,
        height * 0.8,
    );

    // Buffer should NOT have changed
    const afterBuffer = await getCurrentBufferName(page);
    expect(afterBuffer).toBe(beforeBuffer);
});

test('horizontal swipe right from left edge shows buffer list on mobile', async () => {
    // Fresh connection to ensure clean state
    await clearSettings(page);
    await page.goto('http://localhost:8001/');
    await waitForAppReady(page);
    await page.setViewportSize({ width: 375, height: 667 });
    await connectToWeechat(page);

    // Buffer list should not be visible on mobile by default
    await expect(page.getByTestId('buffer-list')).not.toBeVisible({ timeout: 5000 });

    const width = 375;
    const height = 667;

    // Swipe right from left edge on document-level (not element-targeted)
    await swipeOnDocument(page, 10, height / 2, width - 50, height / 2);

    // Buffer list should now be visible
    await expect(page.getByTestId('buffer-list')).toBeVisible({ timeout: 5000 });
});

test('horizontal swipe left from right edge opens nicklist on mobile', async () => {
    // Ensure we're connected with alwaysnicklist enabled
    await clearSettings(page);
    await setSettings(page, { alwaysnicklist: true });
    await page.goto('http://localhost:8001/');
    await waitForAppReady(page);
    await page.setViewportSize({ width: 375, height: 667 });
    await connectToWeechat(page);

    // Ensure buffer list is shown so we start from a clean state
    await swipeOnDocument(page, 10, 334, 325, 334);

    const width = 375;
    const height = 667;

    // Mobile nicklist overlay starts off-screen (translate-x-full).
    // Check that the overlay container has the 'translate-x-full' class (hidden).
    const overlay = page.locator('.mobile-nicklist-overlay');
    await expect(overlay).toHaveClass(/translate-x-full/);

    // Swipe left from right edge (start ~50px in, within 80px threshold)
    await swipeOnDocument(page, width - 50, height / 2, 50, height / 2);

    // Nicklist overlay should now be on-screen (translate-x-0)
    await expect(overlay).toHaveClass(/translate-x-0/);
});

// Swipe right on nicklist closes it and opens buffer list (overlays are mutually exclusive).
test('swipe right on nicklist closes it and opens buffer list', async () => {
    // Ensure we're connected with alwaysnicklist enabled
    await clearSettings(page);
    await setSettings(page, { alwaysnicklist: true });
    await page.goto('http://localhost:8001/');
    await waitForAppReady(page);
    await page.setViewportSize({ width: 375, height: 667 });
    await connectToWeechat(page);

    const width = 375;
    const height = 667;

    // Open nicklist by swiping left from right edge
    await swipeOnDocument(page, width - 50, height / 2, 50, height / 2);

    // Nicklist overlay should be visible
    const overlay = page.locator('.mobile-nicklist-overlay');
    await expect(overlay).toHaveClass(/translate-x-0/);

    // Buffer list should NOT be visible yet
    await expect(page.getByTestId('buffer-list')).not.toBeVisible();

    // Swipe right on the nicklist overlay itself to close it
    // Start from left edge of overlay, swipe past right edge for >50px deltaX
    // Overlay is ~52px wide (w-52), positioned at right edge of viewport
    await swipeOnElement(page, '.mobile-nicklist-overlay', width - 52, height / 2, width + 10, height / 2);

    // Nicklist should now be closed (translate-x-full)
    await expect(overlay).toHaveClass(/translate-x-full/);

    // Buffer list should now be visible (overlays are mutually exclusive)
    await expect(page.getByTestId('buffer-list')).toBeVisible({ timeout: 5000 });
});


