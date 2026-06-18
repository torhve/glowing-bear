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
});

async function getReadmarkerState() {
    return await page.evaluate(() => {
        const container = document.querySelector('[data-testid="chat-messages"]') as HTMLElement;
        if (!container) return null;
        const rows = document.querySelectorAll('[data-testid="bufferline-row"]');
        const rm = container.querySelector('.readmarker');
        const allRows = container.querySelectorAll('table tbody tr');
        const rmIndex = Array.from(allRows).findIndex(t => t.classList.contains('readmarker'));
        const lastLineIndex = rows.length - 1;
        return {
            hasReadmarker: !!rm,
            readmarkerIndex: rmIndex,
            totalLines: rows.length,
            linesBelowReadmarker: rmIndex >= 0 ? lastLineIndex - rmIndex : -1,
            scrollTop: container.scrollTop,
            scrollHeight: container.scrollHeight,
            clientHeight: container.clientHeight,
            atBottom: container.scrollTop >= container.scrollHeight - container.clientHeight - 3,
            scrollDiffFromBottom: container.scrollHeight - container.clientHeight - container.scrollTop,
        };
    });
}

test('readmarker position should be correct when switching away and back to same buffer', async () => {
    // Wait for #glowing-bear to appear in buffer list
    await waitForBuffer(page, '#glowing-bear', 15000);

    // Switch to #glowing-bear and ensure we're at bottom (fully read)
    await switchToBuffer(page, '#glowing-bear');
    await page.waitForTimeout(1000);

    // Verify we're at the bottom
    let state = await getReadmarkerState();
    expect(state).not.toBeNull();
    expect(state!.atBottom).toBe(true);

    // Send a few messages while we're on this buffer (these are fully read)
    await irc.sendMessage('#glowing-bear', 'readmarker-switch-test msg-1');
    await irc.sendMessage('#glowing-bear', 'readmarker-switch-test msg-2');
    await irc.sendMessage('#glowing-bear', 'readmarker-switch-test msg-3');
    await page.waitForTimeout(2000);

    // Switch away to gbtest buffer
    await switchToBuffer(page, 'gbtest');
    await page.waitForTimeout(500);

    // Send messages to #glowing-bear while we're NOT on it (creates unread)
    await irc.sendMessage('#glowing-bear', 'readmarker-switch-test unread-msg-1');
    await irc.sendMessage('#glowing-bear', 'readmarker-switch-test unread-msg-2');
    await page.waitForTimeout(2000);

    // Switch back to #glowing-bear — readmarker should appear at correct position
    await switchToBuffer(page, '#glowing-bear');
    await page.waitForTimeout(1000);

    state = await getReadmarkerState();
    expect(state).not.toBeNull();

    // Readmarker should be visible
    const readmarker = page.getByTestId('readmarker');
    await expect(readmarker).toBeVisible();

    // Readmarker should NOT be at the very end (there should be lines below it)
    expect(state!.linesBelowReadmarker).toBeGreaterThan(0);

    // Readmarker should be above the middle of the visible content (not scrolled to bottom)
    const viewportHeight = await page.evaluate(() => window.innerHeight);
    const readmarkerBox = await readmarker.boundingBox();
    expect(readmarkerBox).not.toBeNull();
    expect(readmarkerBox!.y).toBeLessThan(viewportHeight / 2 + 150);

    // We should NOT be at the bottom — readmarker position means we have unread above
    expect(state!.atBottom).toBe(false);
});

test('readmarker should stay consistent after multiple buffer switches', async () => {
    // Wait for #glowing-bear to appear in buffer list
    await waitForBuffer(page, '#glowing-bear', 15000);

    // Switch to #glowing-bear and ensure we're at bottom
    await switchToBuffer(page, '#glowing-bear');
    await page.waitForTimeout(1000);

    // Send messages while on this buffer (fully read)
    await irc.sendMessage('#glowing-bear', 'multi-switch-test msg-1');
    await page.waitForTimeout(1000);

    // Switch away to gbtest
    await switchToBuffer(page, 'gbtest');
    await page.waitForTimeout(500);

    // Send unread messages to #glowing-bear
    await irc.sendMessage('#glowing-bear', 'multi-switch-test unread-1');
    await page.waitForTimeout(1500);

    // Switch back to #glowing-bear — readmarker should appear
    await switchToBuffer(page, '#glowing-bear');
    await page.waitForTimeout(1000);

    let state = await getReadmarkerState();
    expect(state).not.toBeNull();

    const readmarker = page.getByTestId('readmarker');
    await expect(readmarker).toBeVisible();

    const firstSwitchLinesBelow = state!.linesBelowReadmarker;
    expect(firstSwitchLinesBelow).toBeGreaterThan(0);

    // Scroll to bottom to mark as fully read from UI perspective
    const chatContainer = page.locator('[data-testid="chat-messages"]');
    await chatContainer.evaluate((el) => {
        (el as HTMLElement).scrollTop = (el as HTMLElement).scrollHeight;
    });
    await page.waitForTimeout(500);

    // Switch away again
    await switchToBuffer(page, 'gbtest');
    await page.waitForTimeout(500);

    // Send more unread messages
    await irc.sendMessage('#glowing-bear', 'multi-switch-test unread-2');
    await page.waitForTimeout(1500);

    // Switch back — readmarker should still be correct
    await switchToBuffer(page, '#glowing-bear');
    await page.waitForTimeout(1000);

    state = await getReadmarkerState();
    expect(state).not.toBeNull();
    await expect(readmarker).toBeVisible();

    // Should have at least 1 line below readmarker (the new unread message)
    expect(state!.linesBelowReadmarker).toBeGreaterThanOrEqual(1);

    // The position should make sense: not at -2 from bottom or similar bug
    expect(state!.atBottom).toBe(false);
});
