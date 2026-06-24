import { test, expect } from '@playwright/test';
import { connectToWeechat, clearSettings, setSettings, waitForAppReady, reconnect, fillPortInput } from '../helpers/connection';
import { switchToBuffer } from '../helpers/buffers';
import { irc } from '../helpers/irc-control';

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
});

test.afterAll(async () => {
    await page.close();
});

test.beforeEach(async () => {
    page.on('pageerror', (error) => {
        if (error.message?.includes('effect_orphan')) return;
    });
});



test('clicking hotlist item switches buffer', async () => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await page.getByTestId('buffer-item').first().waitFor({ state: 'visible', timeout: 5000 });

    // Reconnect to get fresh state at mobile viewport
    await reconnect(page);
    await switchToBuffer(page, 'gbtest');

    // Send a message to another buffer to create hotlist entry
    const msg = 'hotlist-click-test-' + Date.now();
    await irc.sendMessage('#glowing-bear', msg);
    await expect(page.getByTestId('hotlist-buffer-item').first()).toBeVisible({ timeout: 10000 });

    const items = page.getByTestId('hotlist-buffer-item');
    const count = await items.count();
    expect(count).toBeGreaterThanOrEqual(1);

    // Click the first hotlist item
    await items.first().click();

    // Verify topic bar updated
    const topicBar = page.getByTestId('topic-bar');
    await expect(topicBar).toBeVisible();
    const topicText = await topicBar.textContent();
    expect(topicText?.length).toBeGreaterThan(0);
});

test('hotlist item shows unread count badge', async () => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await page.getByTestId('buffer-item').first().waitFor({ state: 'visible', timeout: 5000 });

    await switchToBuffer(page, 'gbtest');

    await irc.sendMessage('#glowing-bear', 'count-test-1');
    await irc.sendMessage('#glowing-bear', 'count-test-2');
    await irc.sendMessage('#glowing-bear', 'count-test-3');

    const badges = page.getByTestId('hotlist-count');
    await expect(badges.first()).toBeVisible({ timeout: 10000 });
    const badgeCount = await badges.count();
    expect(badgeCount).toBeGreaterThanOrEqual(1);
});

test('hotlist hidden on desktop viewport', async () => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await page.getByTestId('app-title').waitFor({ state: 'visible', timeout: 5000 });

    await expect(page.getByTestId('buffer-hotlist')).not.toBeAttached();
    await expect(page.getByTestId('app-title')).toBeVisible();
});
