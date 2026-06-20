import { test, expect } from '@playwright/test';
import { connectToWeechat, clearSettings, waitForAppReady, sendWeechatCommand } from '../helpers/connection';
import { botSay } from '../helpers/messages';
import { switchToBuffer, switchToBufferMobile, waitForBuffer, waitForBufferMobile } from '../helpers/buffers';
import { irc } from '../helpers/irc-control';

let page: import('@playwright/test').Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await page.setViewportSize({ width: 375, height: 667 });
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
});

// Hotlist is not rendered on desktop viewport; title is visible.
test('hotlist hidden on desktop', async () => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await page.waitForTimeout(500);
    // On desktop bufferListVisible is always true, so BufferHotlist is not in DOM
    await expect(page.getByTestId('buffer-hotlist')).not.toBeAttached();
    await expect(page.getByTestId('app-title')).toBeVisible();
});

// On mobile after buffer selection, hotlist renders in place of title.
test('hotlist visible on mobile after buffer selection', async () => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await page.waitForTimeout(300);
    // Click a buffer from the list — visible before any selection on mobile
    await switchToBuffer(page, 'glowing-bear');
    await botSay('hotlist test message 2');
    await page.waitForTimeout(500);
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
    // relay delivery is slower than the test advances. The hotlist sync interval fires every ~5s,
    // so we wait for both DOM content and the sync cycle.
    const msgRow = page.locator('[data-testid="bufferline-row"] td.message').first();
    await expect(msgRow).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(3000);

    const items = page.getByTestId('hotlist-buffer-item');
    const count = await items.count();
    expect(count).toBeGreaterThanOrEqual(1);
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
    await page.waitForTimeout(3000);
    await page.waitForTimeout(500);
    const topicBar = page.getByTestId('topic-bar');
    await expect(topicBar).toBeVisible();
    const topicText = await topicBar.textContent();
    expect(topicText).toContain('gbbot');
});

// TODO: fix buffer creation via relay — sendWeechatCommand doesn't reliably create buffers in test environment
test.skip('long buffer names are truncated', async () => {
    // Skipped: requires WeeChat to create a new buffer via relay, which is not reliable in the test IRC server setup
});
