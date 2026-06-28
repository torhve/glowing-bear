import { test, expect } from '@playwright/test';
import { createConnectedPage } from '../fixtures/auth';
import { switchToBuffer } from '../helpers/buffers';
import { irc } from '../helpers/irc-control';

import { setupEffectOrphanFilter } from '../helpers/pageerror';

let page: import('@playwright/test').Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
    page = await createConnectedPage(browser);
    setupEffectOrphanFilter(page);
});

test.afterAll(async () => {
    await page.close();
});

// Helper: wait for scroll position to settle at bottom.
// With very large buffers from many accumulated serial tests, rendering can take
// a long time. Use generous default timeout.
async function waitForScrollSettled(timeoutMs = 60000) {
    const container = '[data-testid="chat-messages"]';
    await page.waitForFunction(
        (sel) => {
            const el = document.querySelector(sel) as HTMLElement;
            if (!el) return false;
            const diff = el.scrollHeight - el.clientHeight - el.scrollTop;
            return diff <= 5;
        },
        container,
        { timeout: timeoutMs },
    );
}

test.beforeEach(async () => {
    setupEffectOrphanFilter(page);

    // Reset buffer state to absorb all unread messages from prior serial tests.
    // Sending a message triggers the handler to update lastSeen to cover all lines,
    // effectively clearing the readmarker and providing a clean baseline for each test.
    await switchToBuffer(page, '#glowing-bear');
    await page.waitForTimeout(500);

    // Scroll to bottom so handler absorbs any existing unread.
    // With very large buffers from many accumulated serial tests, use generous timeout.
    const chatContainer = page.locator('[data-testid="chat-messages"]');
    await chatContainer.evaluate((el) => {
        (el as HTMLElement).scrollTop = (el as HTMLElement).scrollHeight;
    });
    await waitForScrollSettled(120000);

    // Send a dummy message to advance lastSeen past all existing content.
    await irc.sendMessage('#glowing-bear', `BEFORE-EACH-RESET-${Date.now()}`);
    await page.waitForTimeout(2000);
    await waitForScrollSettled(120000);
});

// Helper: wait for readmarker to appear in DOM and be positioned.
async function waitForReadmarkerPositioned(timeoutMs = 10000) {
    await page.waitForFunction(() => {
        const rmRow = document.querySelector('.readmarker');
        if (!rmRow || !rmRow.parentElement) return false;
        const rect = (rmRow as HTMLElement).getBoundingClientRect();
        return rect.height > 0;
    }, {}, { timeout: timeoutMs });
}

test('should scroll to bottom when posting own message while readmarker is present', async () => {
    // Create unread messages by switching away and having bot send messages.
    await switchToBuffer(page, 'gbtest');
    await page.waitForTimeout(500);

    const botMsg1 = `bot-unread-1-${Date.now()}`;
    const botMsg2 = `bot-unread-2-${Date.now()}`;
    await irc.sendMessage('#glowing-bear', botMsg1);
    await irc.sendMessage('#glowing-bear', botMsg2);
    await page.waitForTimeout(1000);

    // Switch back to #glowing-bear — readmarker should appear.
    await switchToBuffer(page, '#glowing-bear');

    // Wait for readmarker to render AND be positioned in the viewport.
    await waitForReadmarkerPositioned(10000);
    await page.waitForTimeout(1000);

    // Now send a message via the input bar — this is the self-posted message.
    const userMsg = `own-msg-${Date.now()}`;
    const input = page.getByTestId('message-input');
    await input.click();
    await input.fill(userMsg);
    await input.press('Enter');

    // Wait for echoed line to render in DOM.
    await page.waitForFunction(
        (text) => {
            const rows = Array.from(document.querySelectorAll('[data-testid="bufferline-row"]'));
            return rows.some((row) => row.textContent?.includes(text));
        },
        userMsg,
        { timeout: 10000 },
    );

    // Allow time for scroll effects to settle (multiple rAF cycles may fire).
    await page.waitForTimeout(3000);

    // Verify view scrolled to bottom — user's own message should be visible near bottom.
    const msgVisibility = await page.evaluate((text) => {
        const container = document.querySelector('[data-testid="chat-messages"]') as HTMLElement;
        if (!container) return null;
        const rows = Array.from(document.querySelectorAll('[data-testid="bufferline-row"]'));
        const targetRow = rows.find((row) => row.textContent?.includes(text));
        if (!targetRow) return null;

        const rowRect = (targetRow as HTMLElement).getBoundingClientRect();
        const contRect = container.getBoundingClientRect();
        const relativeY = (rowRect.top - contRect.top) / contRect.height;

        return {
            visible: rowRect.bottom > contRect.top && rowRect.top < contRect.bottom,
            relativeY,
            atBottom: container.scrollTop >= container.scrollHeight - container.clientHeight - 3,
        };
    }, userMsg);

    expect(msgVisibility).not.toBeNull();
    expect(msgVisibility!.visible).toBe(true);
    // Message should be in lower 40% of viewport (near bottom),
    // proving the view scrolled down after posting own message.
    expect(msgVisibility!.relativeY).toBeGreaterThan(0.6);
    // View should be at or very near bottom (allow tolerance for layout timing).
    expect(msgVisibility!.atBottom || msgVisibility!.relativeY > 0.8).toBe(true);

});
