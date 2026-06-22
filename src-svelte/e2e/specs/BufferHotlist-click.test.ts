import { test, expect } from '@playwright/test';
import { connectToWeechat, clearSettings, setSettings, waitForAppReady } from '../helpers/connection';
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

function fillPortInput(p: import('@playwright/test').Page, port: string) {
    return p.evaluate((p) => {
        const input = document.querySelector('[data-testid="port-input"]');
        if (input) {
            (input as HTMLInputElement).value = p;
            input.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }, port);
}

async function reconnect(p: import('@playwright/test').Page) {
    await clearSettings(p);
    await setSettings(p, { savepassword: false, autoconnect: false });
    await p.getByTestId('disconnect-button').click().catch(() => {});
    await p.waitForTimeout(2000);
    await p.getByTestId('host-input').fill('localhost');
    await fillPortInput(p, '9001');
    await p.getByTestId('password-input').fill('testpassword123');
    await p.getByTestId('connect-button').click();
    await p.getByTestId('chat-view').waitFor({ state: 'visible', timeout: 45000 });
}

test('clicking hotlist item switches buffer', async () => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await page.waitForTimeout(500);

    // Reconnect to get fresh state at mobile viewport
    await reconnect(page);
    await switchToBuffer(page, 'gbtest');
    await page.waitForTimeout(500);

    // Send a message to another buffer to create hotlist entry
    await irc.sendMessage('#glowing-bear', 'hotlist-click-test-' + Date.now());
    await page.waitForTimeout(3000);

    const items = page.getByTestId('hotlist-buffer-item');
    const count = await items.count();
    expect(count).toBeGreaterThanOrEqual(1);

    // Click the first hotlist item
    await items.first().click();
    await page.waitForTimeout(500);

    // Verify topic bar updated
    const topicBar = page.getByTestId('topic-bar');
    await expect(topicBar).toBeVisible();
    const topicText = await topicBar.textContent();
    expect(topicText?.length).toBeGreaterThan(0);
});

test('hotlist item shows unread count badge', async () => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await page.waitForTimeout(500);

    await switchToBuffer(page, 'gbtest');
    await page.waitForTimeout(1000);

    await irc.sendMessage('#glowing-bear', 'count-test-1');
    await irc.sendMessage('#glowing-bear', 'count-test-2');
    await irc.sendMessage('#glowing-bear', 'count-test-3');
    await page.waitForTimeout(3000);

    const badges = page.getByTestId('hotlist-count');
    const badgeCount = await badges.count();
    expect(badgeCount).toBeGreaterThanOrEqual(1);
});

test('hotlist hidden on desktop viewport', async () => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await page.waitForTimeout(500);

    await expect(page.getByTestId('buffer-hotlist')).not.toBeAttached();
    await expect(page.getByTestId('app-title')).toBeVisible();
});
