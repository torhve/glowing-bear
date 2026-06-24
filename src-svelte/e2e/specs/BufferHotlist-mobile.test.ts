import { test, expect } from '@playwright/test';
import { createConnectedPage } from '../fixtures/auth';
import { sendWeechatCommand } from '../helpers/connection';
import { botSay } from '../helpers/messages';
import { switchToBuffer, switchToBufferMobile, waitForBuffer, waitForBufferMobile } from '../helpers/buffers';
import { irc } from '../helpers/irc-control';

let page: import('@playwright/test').Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
    page = await createConnectedPage(browser);
    await page.setViewportSize({ width: 375, height: 667 });
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
});

// Hotlist is not rendered on desktop viewport; title is visible.
test('hotlist hidden on desktop', async () => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await page.getByTestId('app-title').waitFor({ state: 'visible', timeout: 5000 });
    // On desktop bufferListVisible is always true, so BufferHotlist is not in DOM
    await expect(page.getByTestId('buffer-hotlist')).not.toBeAttached();
    await expect(page.getByTestId('app-title')).toBeVisible();
});

// On mobile after buffer selection, hotlist renders in place of title.
test('hotlist visible on mobile after buffer selection', async () => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await page.getByTestId('buffer-item').first().waitFor({ state: 'visible', timeout: 5000 });
    // Click a buffer from the list — visible before any selection on mobile
    await switchToBuffer(page, 'glowing-bear');
    await botSay('hotlist test message 2');
    // Buffer list hidden on mobile after selection
    await expect(page.getByTestId('buffer-list')).not.toBeVisible();
    // Title hidden, hotlist rendered in its place
    await expect(page.getByTestId('app-title')).not.toBeVisible();
    await expect(page.getByTestId('buffer-hotlist')).toBeAttached();
});

// Bot sends messages to #glowing-bear while user views core.weechat → hotlist populates.
test('hotlist shows buffers with unread messages', async () => {
    // Send PM to testuser which creates an inactive buffer (not #glowing-bear)
    await irc.sendPm('testuser', 'hotlist shows buffers with unread messages!');

    // Verify message rendered before checking hotlist — prevents false negatives when
    // relay delivery is slower than the test advances.
    const msgRow = page.locator('[data-testid="bufferline-row"] td.message').first();
    await expect(msgRow).toBeVisible({ timeout: 10000 });

    // Wait for hotlist to populate (sync interval fires every ~5s)
    await expect(async () => {
        const n = await page.getByTestId('hotlist-buffer-item').count();
        expect(n).toBeGreaterThanOrEqual(1);
    }).toPass({ timeout: 10000 });
    const items = page.getByTestId('hotlist-buffer-item');
    const firstItem = items.first();
    await expect(firstItem).toContainText('gbbot');
    const countBadge = firstItem.getByTestId('hotlist-count');
    await expect(countBadge).toContainText(/\(\d+\)/);
});

// Clicking a hotlist item switches to that buffer.
test('clicking hotlist item switches buffer', async () => {
    const items = page.getByTestId('hotlist-buffer-item');
    const count = await items.count();
    expect(count).toBeGreaterThanOrEqual(1);
    const firstItem = items.first();
    await firstItem.click();
    await botSay('switch test message');
    await expect(page.getByTestId('topic-bar')).toBeVisible({ timeout: 10000 });
    const topicText = await page.getByTestId('topic-bar').textContent();
    expect(topicText).toContain('gbbot');
});

// TODO: fix buffer creation via relay — sendWeechatCommand doesn't reliably create buffers in test environment
test.skip('long buffer names are truncated', async () => {
    // Skipped: requires WeeChat to create a new buffer via relay, which is not reliable in the test IRC server setup
});
