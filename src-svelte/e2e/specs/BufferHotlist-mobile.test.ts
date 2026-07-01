import { test, expect } from '@playwright/test';
import { createConnectedPage } from '../fixtures/auth';
import { botSay, botPm } from '../helpers/messages';
import { switchToBuffer } from '../helpers/buffers';

import { setupEffectOrphanFilter } from '../helpers/pageerror';

declare global {
    interface Window {
        __showBufferListOnMobile?: () => void;
    }
}

let page: import('@playwright/test').Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
    page = await createConnectedPage(browser);
    await page.setViewportSize({ width: 375, height: 667 });
    setupEffectOrphanFilter(page);
});

test.afterAll(async () => {
    await page.close();
});

// Clear leftover unread from previous serial tests so each test starts with
// an empty hotlist. Pressing Alt+A repeatedly jumps to each unread buffer,
// which clears its counts via setActiveBuffer — natural user action.
async function clearAllUnread(p: typeof page) {
    const orig = (await p.viewportSize()) || { width: 375, height: 667 };
    await p.setViewportSize({ width: 1280, height: 720 });
    await p.evaluate(() => window.dispatchEvent(new Event('resize')));
    for (let i = 0; i < 10; i++) {
        await p.keyboard.press('Alt+A');
        await p.waitForTimeout(200);
    }
    await p.setViewportSize(orig);
    await p.evaluate(() => window.dispatchEvent(new Event('resize')));
}

test.beforeEach(async () => {
    setupEffectOrphanFilter(page);
    await clearAllUnread(page);
});

// Hotlist is not rendered on desktop viewport; title is visible.
test('hotlist hidden on desktop', async () => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await page
        .getByTestId('app-title')
        .waitFor({ state: 'visible', timeout: 5000 });
    // On desktop bufferListVisible is always true, so BufferHotlist is not in DOM
    await expect(page.getByTestId('buffer-hotlist')).not.toBeAttached();
    await expect(page.getByTestId('app-title')).toBeVisible();
});

// On mobile after buffer selection, hotlist renders in place of title.
test('hotlist visible on mobile after buffer selection', async () => {
    await page.setViewportSize({ width: 375, height: 667 });
    // Dispatch resize so Svelte's reactive isMobileState updates.
    // Playwright's setViewportSize doesn't fire DOM events, so we need this.
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    // Buffer list is hidden by default on mobile — show it via dev helper
    await page.evaluate(() => window.__showBufferListOnMobile?.());
    await page.waitForFunction(
        () => document.querySelector('[data-testid="buffer-item"]') !== null,
        { timeout: 10000 },
    );
    // Click a buffer from the list
    await switchToBuffer(page, 'glowing-bear');
    await botSay('hotlist test message 2');
    // Buffer list hidden on mobile after selection
    await expect(page.getByTestId('buffer-list')).not.toBeVisible();
    // Title hidden, hotlist rendered in its place
    await expect(page.getByTestId('app-title')).not.toBeVisible();
    await expect(page.getByTestId('buffer-hotlist')).toBeAttached();
});

// Bot sends PM to testuser creating a query buffer with unread.
// On mobile, the hotlist only renders after a buffer is selected (buffer list hides).
// Click #glowing-bear from buffer list so hotlist appears, then send PM to create unread.
test('hotlist shows buffers with unread messages', async () => {
    // Ensure viewport is mobile
    await page.setViewportSize({ width: 375, height: 667 });
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));

    // Show buffer list so we can click a buffer
    await page.evaluate(() => window.__showBufferListOnMobile?.());
    await page.waitForFunction(
        () => document.querySelector('[data-testid="buffer-item"]') !== null,
        { timeout: 10000 },
    );

    // Click #glowing-bear to trigger buffer selection → hotlist renders
    await switchToBuffer(page, 'glowing-bear');

    // Now hotlist should be visible on mobile. Send a PM to create an
    // inactive query buffer with unread messages that appears in hotlist.
    await botPm('hotlist test message!');

    // Wait for hotlist to populate (sync interval fires every ~5s)
    await expect(async () => {
        const n = await page.getByTestId('hotlist-buffer-item').count();
        expect(n).toBeGreaterThanOrEqual(1);
    }).toPass({ timeout: 30000 });

    const items = page.getByTestId('hotlist-buffer-item');
    const firstItem = items.first();
    await expect(firstItem).toContainText(/g?gbbot\d*/);
    const countBadge = firstItem.getByTestId('hotlist-count');
    await expect(countBadge).toContainText(/\(\d+\)/);
});

// Clicking a hotlist item switches to that buffer.
test('clicking hotlist item switches buffer', async () => {
    // Ensure viewport is mobile
    await page.setViewportSize({ width: 375, height: 667 });
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));

    // Show buffer list so we can click #glowing-bear
    await page.evaluate(() => window.__showBufferListOnMobile?.());
    await page.waitForFunction(
        () => document.querySelector('[data-testid="buffer-item"]') !== null,
        { timeout: 10000 },
    );

    // Click #glowing-bear to trigger buffer selection → hotlist renders
    await switchToBuffer(page, 'glowing-bear');

    // Send a PM to create an inactive query buffer with unread
    await botPm('hotlist switch test!');

    // Wait for hotlist to populate (sync interval fires every ~5s)
    await expect(async () => {
        const n = await page.getByTestId('hotlist-buffer-item').count();
        expect(n).toBeGreaterThanOrEqual(1);
    }).toPass({ timeout: 30000 });

    const items = page.getByTestId('hotlist-buffer-item');
    const firstItem = items.first();
    await firstItem.click();

    // Verify we switched to the query buffer
    await botPm('switch confirm');
    await expect(page.getByTestId('topic-bar')).toBeVisible({ timeout: 10000 });
    const topicText = await page.getByTestId('topic-bar').textContent();
    expect(topicText).toMatch(/g?gbbot\d*/);
});

// TODO: fix buffer creation via relay — sendWeechatCommand doesn't reliably create buffers in test environment
test.skip('long buffer names are truncated', async () => {
    // Skipped: requires WeeChat to create a new buffer via relay, which is not reliable in the test IRC server setup
});
