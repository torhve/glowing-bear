import { test, expect } from '@playwright/test';
import { connectToWeechat, clearSettings, waitForAppReady } from '../helpers/connection';
import { waitForBuffer, switchToBuffer } from '../helpers/buffers';
import { irc } from '../helpers/irc-control';

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
    await waitForBuffer(page, '#glowing-bear', 10000);
    await switchToBuffer(page, '#glowing-bear');
});

async function getNonChannelBuffer() {
    const items = page.getByTestId('buffer-item');
    const count = await items.count();
    for (let i = 0; i < count; i++) {
        const text = await items.nth(i).textContent();
        if (text && !text.includes('#glowing-bear')) {
            return items.nth(i);
        }
    }
    return items.first();
}

test('creates buffer on PM from bot', async () => {
    await irc.sendPm('testuser', 'Hello from bot!');
    const items = page.getByTestId('buffer-item');
    const count = await items.count();
    expect(count).toBeGreaterThanOrEqual(2);
});

test('shows unread count on PM buffer', async () => {
    await irc.sendPm('testuser', 'Hello from bot!');
    await page.waitForTimeout(2000);

    const pmItems = page.locator('[data-testid="buffer-item"]').filter({ hasNotText: '#glowing-bear' });
    await expect(pmItems.first()).toBeVisible({ timeout: 10000 });

    // Verify badge shows notification count (unread + notification combined)
    const pmBufferItem = pmItems.first();
    const badgeText = await pmBufferItem.locator('span.rounded-full').first().textContent();
    expect(badgeText).toBeTruthy();
    const badgeNum = parseInt(badgeText!, 10);
    expect(badgeNum).toBeGreaterThanOrEqual(1);
});

test('shows notification badge on PM buffer', async () => {
    await irc.sendPm('testuser', 'Notification test message!');
    await page.waitForTimeout(2000);

    // Get all buffer items and find the PM buffer (non-channel)
    const pmItems = page.locator('[data-testid="buffer-item"]').filter({ hasNotText: '#glowing-bear' });
    await expect(pmItems.first()).toBeVisible({ timeout: 10000 });

    // Verify the PM buffer item has a notification badge with numeric value
    const pmBufferItem = pmItems.first();
    const badgeSpans = await pmBufferItem.locator('span').all();
    let foundBadge = false;
    for (const span of badgeSpans) {
        const text = await span.textContent();
        if (text && /^\d+$/.test(text.trim())) {
            const num = parseInt(text.trim(), 10);
            expect(num).toBeGreaterThanOrEqual(1);
            foundBadge = true;
            break;
        }
    }
    expect(foundBadge).toBe(true);
});

test('switches to PM buffer and shows message', async () => {
    await irc.sendPm('testuser', 'Hello from bot!');
    const items = page.getByTestId('buffer-item');
    const count = await items.count();
    expect(count).toBeGreaterThanOrEqual(2);

    const pmItem = await getNonChannelBuffer();
    await pmItem.click();

    await expect(page.getByTestId('chat-messages')).toBeVisible();

    const msgRow = page.getByRole('cell', { name: 'Hello from bot!' }).first();
    await expect(msgRow).toBeVisible({ timeout: 10000 });
});

test('closes PM buffer cleanly', async () => {
    await irc.sendPm('testuser', 'Hello from bot!');
    const items = page.getByTestId('buffer-item');
    const count = await items.count();
    expect(count).toBeGreaterThanOrEqual(2);

    const pmItem = await getNonChannelBuffer();
    await pmItem.click();
    await expect(page.getByTestId('topic-bar')).toBeVisible({ timeout: 5000 });

    // Close it using the close button on the PM buffer item
    const closeBtn = pmItem.locator('[data-testid="close-buffer"]');
    await pmItem.hover();
    await closeBtn.waitFor({ state: 'visible' });
    await closeBtn.click();

    // Buffer count should have decreased
    const remainingItems = page.getByTestId('buffer-item');
    const remainingCount = await remainingItems.count();
    expect(remainingCount).toBeGreaterThanOrEqual(1);

    // The closed PM buffer should no longer appear
    const pmItems = page.locator('[data-testid="buffer-item"]').filter({ hasNotText: '#glowing-bear' });
    const pmCount = await pmItems.count();
    expect(pmCount).toBe(0);

    // Chat view still visible
    await expect(page.getByTestId('chat-view')).toBeVisible();
});
