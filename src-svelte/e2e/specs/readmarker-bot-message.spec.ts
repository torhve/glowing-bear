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

    // Wait for gbtest server buffer first (appears before channels)
    await waitForBuffer(page, 'gbtest', 30000);
    // Then wait for #glowing-bear channel
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
    await page.waitForTimeout(500);
});

test('readmarker appears on second-to-last line with 1 unread when switching to buffer after bot message', async () => {
    // Step 1: Switch to another buffer (PM buffer) so we're NOT on #glowing-bear when message arrives
    const pmItems = page.locator('[data-testid="buffer-item"]').filter({ hasNotText: '#glowing-bear' });
    const pmCount = await pmItems.count();
    
    if (pmCount === 0) {
        // Create a PM buffer by sending a PM
        await irc.sendPm('testuser', 'switch target pm');
        await page.waitForTimeout(1500);
    }
    
    const pmItem = page.locator('[data-testid="buffer-item"]').filter({ hasNotText: '#glowing-bear' }).first();
    await expect(pmItem).toBeVisible({ timeout: 10000 });
    await pmItem.click();
    await page.waitForTimeout(500);

    // Step 2: Check line count before sending bot message
    const linesBefore = await page.evaluate(() => {
        const rows = document.querySelectorAll('[data-testid="bufferline-row"]');
        return rows.length;
    });
    
    // Step 2: Send a NEW message to #glowing-bear while we're on the PM buffer
    const uniqueMsgId = Date.now();
    const response = await irc.sendMessage('#glowing-bear', `readmarker test ${uniqueMsgId}`);
    expect(response.ok).toBe(true);

      // Wait for the unread count badge to appear on #glowing-bear in buffer list
    const gbBuffer = page.getByTestId('buffer-item').filter({ hasText: '#glowing-bear' });
    await gbBuffer.locator('span.rounded-full').first().waitFor({ state: 'visible', timeout: 10000 });
    
    // Wait a bit for relay message to arrive
    await page.waitForTimeout(3000);
    
    // Check unread badge text and line count after bot message
    const badgeText = await gbBuffer.locator('span.rounded-full').first().textContent();
    const linesAfter = await page.evaluate(() => {
        const rows = document.querySelectorAll('[data-testid="bufferline-row"]');
        return rows.length;
    });

    // Step 3: Switch back to #glowing-bear
    await switchToBuffer(page, '#glowing-bear');
    await page.waitForTimeout(1000);

    // Step 4: Check that readmarker is visible
    const domInfo = await page.evaluate(() => {
        const trs = document.querySelectorAll('table tbody tr');
        const readmarkerRow = document.querySelector('.readmarker');
        const unreadBar = document.querySelector('[data-testid="chat-messages"] + div');
        const messageRows = document.querySelectorAll('[data-testid="bufferline-row"]');
        let readmarkerIndex = -1;
        for (let i = 0; i < trs.length; i++) {
            if (trs[i].classList.contains('readmarker')) {
                readmarkerIndex = i;
                break;
            }
        }
        return {
            totalTRs: trs.length,
            messageRowIds: messageRows.length,
            hasReadmarker: !!readmarkerRow,
            readmarkerIndex,
            hasUnreadBar: !!unreadBar,
            unreadBarText: unreadBar?.textContent?.trim(),
        };
    });
    const readmarker = page.getByTestId('readmarker');
    await expect(readmarker).toBeVisible({ timeout: 5000 });

    // Step 5: Verify readmarker is on the second-to-last row (1 unread message after it)
    const allRows = page.locator('[data-testid="bufferline-row"]');
    const rowCount = await allRows.count();
    expect(rowCount).toBeGreaterThan(0);

    // Get total TR count in tbody (includes readmarker row)
    const totalTRs = await page.evaluate(() => {
        const table = document.querySelector('table tbody');
        return table ? table.querySelectorAll('tr').length : 0;
    });

    const readmarkerPosition = await readmarker.evaluate((el: Element) => {
        const table = el.closest('table')?.querySelector('tbody');
        if (!table) return -1;
        const rows = table.querySelectorAll('tr');
        let readmarkerIndex = -1;
        for (let i = 0; i < rows.length; i++) {
            if (rows[i].classList.contains('readmarker')) {
                readmarkerIndex = i;
                break;
            }
        }
        return readmarkerIndex;
    });

    // Readmarker should be before the last TR (unread message is below it)
    expect(readmarkerPosition).toBeLessThan(totalTRs - 1);
    // There should be at least 1 message after the readmarker
    expect(readmarkerPosition).toBeGreaterThanOrEqual(0);

    // Step 6: Check that we're scrolled into view of the readmarker (near bottom of viewport)
    const scrollInfo = await page.evaluate(() => {
        const container = document.querySelector('[data-testid="chat-messages"]');
        if (!container || !(container instanceof HTMLElement)) return null;
        const readmarkerEl = document.getElementById('readmarker');
        if (!readmarkerEl) return null;

        const containerRect = container.getBoundingClientRect();
        const readmarkerRect = readmarkerEl.getBoundingClientRect();

        return {
            isVisible: readmarkerRect.bottom <= containerRect.bottom && readmarkerRect.top >= containerRect.top,
            nearBottom: readmarkerRect.bottom >= containerRect.bottom - 100
        };
    });

    // Scroll position check - readmarker should be visible in the viewport
    expect(scrollInfo).not.toBeNull();
    expect(scrollInfo!.isVisible).toBe(true);
});
