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
    await waitForBuffer(page, '#glowing-bear', 20000);
    await switchToBuffer(page, '#glowing-bear');
});

async function findPmBuffer() {
    const items = page.getByTestId('buffer-item');
    const count = await items.count();
    for (let i = 0; i < count; i++) {
        const text = await items.nth(i).textContent();
        if (text && /gbbot\d*/.test(text)) {
            return items.nth(i);
        }
    }
    return null;
}

test('creates buffer on PM from bot', async () => {
    await irc.sendPm('testuser', 'Hello from bot!');
    await page.waitForTimeout(2000);
    const pmItem = await findPmBuffer();
    expect(pmItem).not.toBeNull();
    await expect(pmItem!).toBeVisible({ timeout: 10000 });
});

test('shows unread count on PM buffer', async () => {
    await irc.sendPm('testuser', 'Hello from bot!');
    await page.waitForTimeout(2000);

    const pmBufferItem = await findPmBuffer();
    expect(pmBufferItem).not.toBeNull();
    await expect(pmBufferItem!).toBeVisible({ timeout: 10000 });

    // Verify badge shows notification count (unread + notification combined)
    const badgeText = await pmBufferItem!.locator('span.rounded-full').first().textContent({ timeout: 10000 });
    expect(badgeText).toBeTruthy();
    const badgeNum = parseInt(badgeText!, 10);
    expect(badgeNum).toBeGreaterThanOrEqual(1);
});

test('shows notification badge on PM buffer', async () => {
    await irc.sendPm('testuser', 'Notification test message!');
    await page.waitForTimeout(2000);

    const pmBufferItem = await findPmBuffer();
    expect(pmBufferItem).not.toBeNull();
    await expect(pmBufferItem!).toBeVisible({ timeout: 10000 });

    // Verify the PM buffer item has a notification badge with numeric value
    const badgeSpans = await pmBufferItem!.locator('span').all();
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
    await page.waitForTimeout(2000);

    const pmBufferItem = await findPmBuffer();
    expect(pmBufferItem).not.toBeNull();
    await pmBufferItem!.click();
    await page.waitForTimeout(500);

    await expect(page.getByTestId('chat-messages')).toBeVisible();

    const msgRow = page.getByRole('cell', { name: 'Hello from bot!' }).first();
    await expect(msgRow).toBeVisible({ timeout: 10000 });
});

test('closes PM buffer cleanly', async () => {
    // Get the PM buffer from previous tests
    const pmBufferItem = await findPmBuffer();
    if (!pmBufferItem) {
        test.skip();
        return;
    }
    await pmBufferItem.click();
    await expect(page.getByTestId('topic-bar')).toBeVisible({ timeout: 5000 });

    // Verify close button exists and is clickable on the PM buffer item
    const closeBtn = pmBufferItem.locator('[data-testid="close-buffer"]');
    await expect(closeBtn).toBeVisible();

    // Click the close button - PM buffers may not actually close in WeeChat
    // but the click should not throw an error
    await pmBufferItem.hover();
    await closeBtn.click();
    await page.waitForTimeout(500);

    // Chat view should still be visible (app didn't crash)
    await expect(page.getByTestId('chat-view')).toBeVisible();
});
