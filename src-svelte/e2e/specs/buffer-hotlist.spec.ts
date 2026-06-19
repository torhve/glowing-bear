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
    // Bot sends messages to #glowing-bear (inactive buffer)
    await botSay('hotlist test message 1');
    await botSay('hotlist test message 2');
    await irc.sendPm('testuser', 'hotlist shows buffers with unread messages!');
    await page.waitForTimeout(2000);
    // Wait for hotlist sync interval
    // why tho, buffer line added should show at once???
    // Hotlist should show ggbbot with count
    const items = page.getByTestId('hotlist-buffer-item');
    const count = await items.count();
    expect(count).toBeGreaterThanOrEqual(1);
    const firstItem = items.first();
    await expect(firstItem).toContainText('gbbot');
    // Count badge should show 2
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

// Long buffer names are truncated visually.
test('long buffer names are truncated', async () => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await page.waitForTimeout(300);
    // Join a channel with a very long name (>18 chars)
    await irc.botJoin('#this-is-a-very-long-channel-name-for-testing-purposes');
    // Wait for the buffer to appear in the list (on desktop where list is always visible)
    await waitForBufferMobile(page, '#this-is-a-very-long-channel-name-for-testing-purposes', 10000);
    // Switch to core.weechat so the long channel becomes inactive
    await switchToBufferMobile(page, 'weechat');
    // Bot sends message to the long-named channel to create unread
    await irc.sendMessage('#this-is-a-very-long-channel-name-for-testing-purposes', 'truncation test');
    await page.waitForTimeout(3000);
    // Find the hotlist item for this channel and check truncation
    const longChannelItem = page.getByTestId('hotlist-buffer-item').filter({ hasText: 'this-is-a-very' }).first();
    await expect(longChannelItem).toBeVisible({ timeout: 5000 });
    // Check that the name span has the max-width constraint applied
    const nameSpan = longChannelItem.locator('.truncate');
    const computedStyle = await nameSpan.evaluate(el => {
        const style = getComputedStyle(el);
        return { maxWidth: style.maxWidth, overflow: style.overflow };
    });
    expect(computedStyle.maxWidth).toBe('48px');
    expect(computedStyle.overflow).toBe('hidden');
    // Verify text content includes ellipsis character
    const textContent = await nameSpan.textContent();
    expect(textContent).toContain('\u2026');
    // Clean up: leave the long channel
    await irc.botPart('#this-is-a-very-long-channel-name-for-testing-purposes');
    await page.waitForTimeout(1000);
});
