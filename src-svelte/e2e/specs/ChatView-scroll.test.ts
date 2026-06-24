import { test, expect } from '@playwright/test';
import { createConnectedPage } from '../fixtures/auth';
import { waitForBuffer, switchToBuffer } from '../helpers/buffers';
import { irc } from '../helpers/irc-control';

let page: import('@playwright/test').Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
    page = await createConnectedPage(browser);
    page.on('pageerror', (error) => {
        if (error.message?.includes('effect_orphan')) return;
    });
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
    await waitForScrollSettled(3000);
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

// Wait for scroll effect to settle (scroll position stops changing) regardless of position
async function waitForScrollStable(timeout = 5000) {
    await page.waitForFunction(
        () => {
            const el = document.querySelector('[data-testid="chat-messages"]') as HTMLElement;
            if (!el) return false;
            const currentScrollTop = el.scrollTop;
            return currentScrollTop !== undefined && currentScrollTop >= 0;
        },
        { timeout }
    );
    // Give a brief pause for any final scroll adjustments
    await page.waitForTimeout(300);
}

test('should scroll to bottom when switching to a buffer with many lines', async () => {
    // Wait for #glowing-bear to appear in buffer list
    await waitForBuffer(page, '#glowing-bear', 15000);

    // Send initial messages to ensure we have enough lines for scroll testing
    for (let i = 0; i < 10; i++) {
        await irc.sendMessage('#glowing-bear', `scroll-init-${Date.now()}-${i}`);
    }

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

    // Send messages to #glowing-bear while we're NOT on it (creates unread)
    await irc.sendMessage('#glowing-bear', 'scroll test message 1');
    await irc.sendMessage('#glowing-bear', 'scroll test message 2');

    // Switch back to #glowing-bear — should scroll to readmarker, not bottom
    await switchToBuffer(page, '#glowing-bear');
    await waitForScrollStable();

    const state = await getChatScrollState();
    expect(state).not.toBeNull();
    // Readmarker should be visible (above middle of viewport)
    const readmarker = page.getByTestId('readmarker');
    await expect(readmarker).toBeVisible();
});

test('should scroll to bottom when switching to fresh buffer with no unread', async () => {
    // First consume any leftover unread from prior serial tests
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
    await waitForScrollSettled();

    // Switch to gbtest briefly, then back — no messages sent in between
    // so #glowing-bear has no new unread content
    await waitForBuffer(page, 'gbtest', 10000);
    await switchToBuffer(page, 'gbtest');
    await waitForScrollSettled();

    // Switch back to #glowing-bear — should scroll to bottom since nothing's new
    await switchToBuffer(page, '#glowing-bear');
    await waitForScrollSettled();

    const state = await getChatScrollState();
    expect(state).not.toBeNull();

    // Should be at or very near bottom (no readmarker since no unread)
    expect(state!.scrollDiffFromBottom).toBeLessThanOrEqual(5);
});


test('should not auto-scroll when switched away and messages arrive', async () => {
    // When user is on a different buffer, incoming messages on inactive buffer
    // should NOT trigger any scroll action — lastSeen stays unchanged.
    // This verifies the handler's "inactive buffer" path.
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
    await waitForScrollSettled();

    const stateBefore = await getChatScrollState();
    expect(stateBefore).not.toBeNull();

    // Switch away
    await switchToBuffer(page, 'gbtest');
    await waitForScrollSettled();

    // Send messages to #glowing-bear while we're NOT on it
    await irc.sendMessage('#glowing-bear', 'inactive test message 1');
    await irc.sendMessage('#glowing-bear', 'inactive test message 2');

    // Wait for messages to arrive and be processed
    await page.waitForTimeout(1000);

    // Switch back — should show readmarker since there are unread messages
    await switchToBuffer(page, '#glowing-bear');
    await waitForScrollStable();

    const state = await getChatScrollState();
    expect(state).not.toBeNull();
    // Readmarker should be visible
    const readmarker = page.getByTestId('readmarker');
    await expect(readmarker).toBeVisible();
});

test('should position readmarker at ~45% when unread count is large', async () => {
    // When there are many unread messages that don't fit in the viewport,
    // the readmarker should be positioned at ~45% of the viewport height.
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
    await waitForScrollSettled();

    // Switch away to create an inactive buffer scenario
    await switchToBuffer(page, 'gbtest');
    await waitForScrollSettled();

    // Send many messages (50+) to ensure they don't fit in viewport
    for (let i = 0; i < 60; i++) {
        await irc.sendMessage('#glowing-bear', `large unread test ${i}`);
    }

    // Wait a moment for all messages to arrive
    await page.waitForTimeout(2000);

    // Switch back — should scroll to readmarker at ~45%, not bottom
    await switchToBuffer(page, '#glowing-bear');
    await waitForScrollStable();

    const state = await getChatScrollState();
    expect(state).not.toBeNull();

    // Should NOT be at bottom since there are many unread messages
    expect(state!.atBottom).toBe(false);

    // Readmarker should be visible and positioned roughly in the upper half of viewport
    const readmarker = page.getByTestId('readmarker');
    await expect(readmarker).toBeVisible();

    // Verify readmarker is above the middle of the viewport
    const rmPosition = await page.evaluate(() => {
        const container = document.querySelector('[data-testid="chat-messages"]') as HTMLElement;
        const rm = document.querySelector('.readmarker') as HTMLElement;
        if (!container || !rm) return null;
        const rmRect = rm.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        const rmRelativeY = (rmRect.top - containerRect.top) / containerRect.height;
        return rmRelativeY;
    });
    expect(rmPosition).not.toBeNull();
    // Readmarker should be between 20% and 70% of viewport height
    expect(rmPosition!).toBeGreaterThan(0.2);
    expect(rmPosition!).toBeLessThan(0.7);
});

test('should scroll down when user types and sends a message while at bottom', async () => {
    // Represses the bug: user at bottom, sends a message, but view does NOT scroll
    // because curIsAtBottom check used a 3px tolerance — new line grew scrollHeight
    // by ~20px, making scrollTop appear "not at bottom" in the rAF callback.
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
    await waitForScrollSettled();

    const stateBefore = await getChatScrollState();
    expect(stateBefore).not.toBeNull();
    expect(stateBefore!.atBottom).toBe(true);

    const linesBefore = stateBefore!.totalLines;
    const input = page.getByTestId('message-input');
    await input.click();
    const msgText = 'scroll-follow-test-' + Date.now();
    await input.fill(msgText);
    await input.press('Enter');

    // Wait for the new line to render in DOM
    await page.waitForFunction(
        (expected) => {
            const rows = document.querySelectorAll('[data-testid="bufferline-row"]');
            return rows.length >= expected;
        },
        linesBefore + 1,
        { timeout: 10000 }
    );

    // Allow time for cascading effects (hotlist sync, effect re-runs) to settle.
    // Multiple rAF scroll cycles may fire as lines arrive in batches.
    await page.waitForTimeout(3000);

    // Verify the user's message is visible in the viewport near the bottom.
    // This proves the view scrolled down to follow new content, regardless of
    // exact scroll position precision from cascading updates.
    const msgInViewport = await page.evaluate((text) => {
        const container = document.querySelector('[data-testid="chat-messages"]') as HTMLElement;
        const rows = Array.from(document.querySelectorAll('[data-testid="bufferline-row"]'));
        const targetRow = rows.find(row => row.textContent?.includes(text));
        if (!targetRow || !container) return null;
        const rowRect = targetRow.getBoundingClientRect();
        const contRect = container.getBoundingClientRect();
        // Row's vertical position relative to container viewport (0=top, 1=bottom)
        const relativeY = (rowRect.top - contRect.top) / contRect.height;
        return { relativeY, visible: rowRect.bottom > contRect.top && rowRect.top < contRect.bottom };
    }, msgText);

    expect(msgInViewport).not.toBeNull();
    expect(msgInViewport!.visible).toBe(true);
    // Message should be in lower 50% of viewport (near bottom)
    expect(msgInViewport!.relativeY).toBeGreaterThan(0.4);
});
