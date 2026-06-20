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
    // Capture debug logs from ChatView scrolling
    page.on('console', (msg) => {
        if (msg.text().includes('[ChatView]')) {
            console.log('SCROLL-DEBUG:', msg.text());
        }
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
    // Clear stale readmarker from prior serial tests by scrolling to bottom
    const chatContainer = page.locator('[data-testid="chat-messages"]');
    await chatContainer.evaluate((el) => {
        (el as HTMLElement).scrollTop = (el as HTMLElement).scrollHeight;
    });
    await page.waitForTimeout(500);
});

async function getChatScrollState() {
    return await page.evaluate(() => {
        const container = document.querySelector('[data-testid="chat-messages"]') as HTMLElement;
        if (!container) return null;
        const rows = document.querySelectorAll('[data-testid="bufferline-row"]');
        return {
            scrollTop: container.scrollTop,
            scrollHeight: container.scrollHeight,
            clientHeight: container.clientHeight,
            atBottom: container.scrollTop >= container.scrollHeight - container.clientHeight - 3,
            scrollDiffFromBottom: container.scrollHeight - container.clientHeight - container.scrollTop,
            totalLines: rows.length,
        };
    });
}

// Wait for scroll position to stabilize at bottom after buffer switch
async function waitForScrollSettled(timeout = 10000) {
    const container = '[data-testid="chat-messages"]';
    await page.waitForFunction(
        (sel) => {
            const el = document.querySelector(sel) as HTMLElement;
            if (!el) return false;
            // Browser clamps scrollTop to scrollHeight - clientHeight when at bottom
            const diff = el.scrollHeight - el.clientHeight - el.scrollTop;
            return diff <= 5;
        },
        container,
        { timeout }
    );
}

test('should scroll to bottom when switching to a buffer with many lines', async () => {
    // Wait for #glowing-bear to appear in buffer list
    await waitForBuffer(page, '#glowing-bear', 15000);

    // Send initial messages to ensure we have enough lines for scroll testing
    for (let i = 0; i < 10; i++) {
        await irc.sendMessage('#glowing-bear', `scroll-init-${Date.now()}-${i}`);
    }
    await page.waitForTimeout(3000);

    // Switch to the buffer and wait for data to load
    await switchToBuffer(page, '#glowing-bear');

    // Wait for chat messages to actually load (async fetchMoreLines from +page effect)
    const firstRow = page.locator('[data-testid="bufferline-row"]').first();
    await expect(firstRow).toBeVisible({ timeout: 20000 });

    // Wait for enough rows to load
    await page.waitForFunction(() => {
        const rows = document.querySelectorAll('[data-testid="bufferline-row"]');
        return rows.length >= 20;
    }, { timeout: 10000 });

    // Wait for scroll to settle at bottom
    await waitForScrollSettled(8000);

    await page.waitForTimeout(300);

    const state = await getChatScrollState();
    expect(state).not.toBeNull();
    expect(state!.totalLines).toBeGreaterThanOrEqual(20);
    expect(state!.atBottom).toBe(true);
    expect(state!.scrollDiffFromBottom).toBeLessThanOrEqual(3);
});

test('should scroll to readmarker when switching to buffer with unread messages', async () => {
    // First ensure we're on #glowing-bear and scrolled to bottom
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
    await waitForScrollSettled();

    // Switch away to gbtest buffer
    await waitForBuffer(page, 'gbtest', 10000);
    await switchToBuffer(page, 'gbtest');
    await page.waitForTimeout(500);

    // Send messages to #glowing-bear while we're NOT on it (creates unread)
    await irc.sendMessage('#glowing-bear', 'scroll test message 1');
    await irc.sendMessage('#glowing-bear', 'scroll test message 2');
    await page.waitForTimeout(2000);

    // Switch back to #glowing-bear — should scroll to readmarker, not bottom
    await switchToBuffer(page, '#glowing-bear');
    await page.waitForTimeout(1000);

    const state = await getChatScrollState();
    expect(state).not.toBeNull();
    // Readmarker should be visible (above middle of viewport)
    const readmarker = page.getByTestId('readmarker');
    await expect(readmarker).toBeVisible();
});

test('should scroll to bottom when switching to fresh buffer with no unread', async () => {
    // Switch to gbtest (core buffer — typically has fewer lines)
    await waitForBuffer(page, 'gbtest', 10000);
    await switchToBuffer(page, 'gbtest');
    await waitForScrollSettled();

    // Send a message to #glowing-bear from bot while we're on gbtest
    await irc.sendMessage('#glowing-bear', 'fresh scroll test ' + Date.now());
    await page.waitForTimeout(2000);

    // Switch back — since we were away, this is a "switch" and should show readmarker
    // But if there are NO unread (lastSeen was already set), it should scroll to bottom
    // This tests the edge case where buffer was fully read before leaving
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
    await waitForScrollSettled();

    const state = await getChatScrollState();
    expect(state).not.toBeNull();

    // Should be at or very near bottom (readmarker not expected since lastSeen already set)
    expect(state!.scrollDiffFromBottom).toBeLessThanOrEqual(5);
});

test('debug logging captures scroll state for all buffer switches', async () => {
    // This test verifies that debug logs are being emitted during buffer switches
    // The logs will appear in the console output prefixed with "SCROLL-DEBUG:"
    // Expected log keys: buffer, totalLines, visibleLinesEstimate, currentScrollTop,
    //   scrollHeight, isAtBottom, scrollDiffFromBottom, isLoadingMore, hasReadmarker

    const scrollLogs: string[] = [];
    page.on('console', (msg) => {
        if (msg.text().includes('[ChatView] scroll')) {
            scrollLogs.push(msg.text());
        }
    });

    // Switch between buffers multiple times
    await switchToBuffer(page, '#glowing-bear');
    await waitForScrollSettled();
    await switchToBuffer(page, 'gbtest');
    await waitForScrollSettled();
    await switchToBuffer(page, '#glowing-bear');
    await waitForScrollSettled();

    // Verify scroll debug logs were generated
    expect(scrollLogs.length).toBeGreaterThan(0);
    // Each log should contain key diagnostic info
    const firstLog = scrollLogs[0];
    expect(firstLog).toContain('totalLines');
    expect(firstLog).toContain('scrollHeight');
    expect(firstLog).toContain('isAtBottom');
});
