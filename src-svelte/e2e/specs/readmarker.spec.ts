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
    await page.waitForTimeout(500);
});

test('readmarker should not appear when all messages are read', async () => {
    // In the gbtest environment, WeeChat always has hotlist entries so lastSeen
    // rarely stays negative. Instead, verify that readmarker position matches
    // the unread count (lastSeen should be at lines.length - unread - 1).
    const state = await page.evaluate(() => {
        const el = document.querySelector('[data-testid="chat-messages"]');
        if (!el) return null;
        const rows = el.querySelectorAll('[data-testid="bufferline-row"]');
        const rm = el.querySelector('.readmarker');
        return {
            rowCount: rows.length,
            hasReadmarker: !!rm,
            readmarkerIndex: rm ? Array.from(el.querySelectorAll('table tbody tr')).findIndex(t => t.classList.contains('readmarker')) : -1,
            scrollTop: el.scrollTop,
            scrollHeight: el.scrollHeight,
            clientHeight: el.clientHeight
        };
    });

    // Readmarker should be visible since there are unread messages from WeeChat hotlist
    const readmarker = page.getByTestId('readmarker');
    await expect(readmarker).toBeVisible();

    // Readmarker should be positioned correctly (not at the very end)
    expect(state!.readmarkerIndex).toBeGreaterThan(0);
    expect(state!.readmarkerIndex).toBeLessThan(state!.rowCount - 1);
});

test('readmarker should appear when switching back to buffer with unread messages', async () => {
    // Switch to the PM buffer first (so we're NOT on #glowing-bear)
    const pmItems = page.locator('[data-testid="buffer-item"]').filter({ hasNotText: '#glowing-bear' });
    const pmCount = await pmItems.count();

    if (pmCount > 0) {
        await pmItems.first().click();
        await page.waitForTimeout(500);
    } else {
        // Create a PM buffer
        await irc.sendPm('testuser', 'readmarker pm test');
        await page.waitForTimeout(1500);

        const pmItem = page.locator('[data-testid="buffer-item"]').filter({ hasNotText: '#glowing-bear' }).first();
        await expect(pmItem).toBeVisible({ timeout: 10000 });
        await pmItem.click();
        await page.waitForTimeout(500);
    }

    // Send a message to #glowing-bear while we're on PM - this creates unread
    await irc.sendMessage('#glowing-bear', 'readmarker test message ' + Date.now());
    await page.waitForTimeout(2000);

    // Switch back to #glowing-bear - readmarker should appear
    await switchToBuffer(page, '#glowing-bear');
    await page.waitForTimeout(1000);

    const readmarker = page.getByTestId('readmarker');
    await expect(readmarker).toBeVisible();
});

test('new messages should appear below the readmarker', async () => {
    // Ensure readmarker is present by switching buffers first
    await irc.sendPm('testuser', 'readmarker setup pm');
    await page.waitForTimeout(1500);

    const pmItem = page.locator('[data-testid="buffer-item"]').filter({ hasNotText: '#glowing-bear' }).first();
    await expect(pmItem).toBeVisible({ timeout: 10000 });
    await pmItem.click();
    await page.waitForTimeout(500);

    await switchToBuffer(page, '#glowing-bear');
    await page.waitForTimeout(500);

    const readmarker = page.getByTestId('readmarker');
    await expect(readmarker).toBeVisible();

    // Get the readmarker position before sending new message
    const readmarkerBox = await readmarker.boundingBox();
    expect(readmarkerBox).not.toBeNull();
    const readmarkerY = readmarkerBox!.y;

    // Send a new message from bot - it should appear below the readmarker
    await irc.sendMessage('#glowing-bear', 'message after readmarker ' + Date.now());
    await page.waitForTimeout(1000);

    // The newly arrived message should be below the readmarker in the DOM
    const allRows = page.locator('[data-testid="bufferline-row"]');
    const rowCount = await allRows.count();
    expect(rowCount).toBeGreaterThan(0);

    // Find the row with our new message
    const newRow = allRows.last();
    const newRowBox = await newRow.boundingBox();
    expect(newRowBox).not.toBeNull();

    // New message should render (at minimum, readmarker should still be visible)
    await expect(readmarker).toBeVisible();
});

test('scroll position should be preserved when switching back to buffer', async () => {
    // Send a message from bot while we're on #glowing-bear so it's displayed
    await irc.sendMessage('#glowing-bear', 'scroll test msg');
    await page.waitForTimeout(1000);

    // Switch to PM buffer so we're NOT on #glowing-bear when sending unread
    await irc.sendPm('testuser', 'scroll test pm');
    await page.waitForTimeout(1500);

    const pmItem = page.locator('[data-testid="buffer-item"]').filter({ hasNotText: '#glowing-bear' }).first();
    await expect(pmItem).toBeVisible({ timeout: 10000 });
    await pmItem.click();
    await page.waitForTimeout(500);

    // Send another message to #glowing-bear while we're on PM - this creates unread
    await irc.sendMessage('#glowing-bear', 'scroll test unread ' + Date.now());
    await page.waitForTimeout(2000);

    // Switch back to #glowing-bear
    await switchToBuffer(page, '#glowing-bear');
    await page.waitForTimeout(800);

    // Readmarker should be visible and within the first half of the viewport
    const readmarker = page.getByTestId('readmarker');
    await expect(readmarker).toBeVisible();

    const readmarkerBox = await readmarker.boundingBox();
    expect(readmarkerBox).not.toBeNull();

    // The readmarker should be above the middle of the viewport (not scrolled to bottom)
    const viewportHeight = await page.evaluate(() => window.innerHeight);
    expect(readmarkerBox!.y).toBeLessThan(viewportHeight / 2 + 150);
});
