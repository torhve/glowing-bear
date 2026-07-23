import { test, expect } from "@playwright/test";
import { createConnectedPage } from "../fixtures/auth";
import { waitForBuffer, switchToBuffer } from "../helpers/buffers";
import { irc } from "../helpers/irc-control";
import { setupEffectOrphanFilter } from "../helpers/pageerror";

let page: import("@playwright/test").Page;

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
    page = await createConnectedPage(browser);
    setupEffectOrphanFilter(page);
});

test.afterAll(async () => {
    if (page) await page.close();
});

// A very long single line that should wrap to multiple visual lines in the chat view.
// Typical viewport width is ~600-800px; with standard fonts this wraps after ~80-120 chars per line.
// Repeating lorem ipsum enough times ensures the message spans at least 3+ visual lines.
const longMessage =
  "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum. Sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium doloremque laudantium, totam rem aperiam, eaque ipsa quae ab illo inventore veritatis et quasi architecto beatae vitae dicta sunt explicabo.";

// Helper: read scroll state of the chat container
async function getChatScrollState() {
    return await page.evaluate(() => {
        const container = document.querySelector(
            '[data-testid="chat-messages"]',
        ) as HTMLElement;
        if (!container) return null;
        const rows = document.querySelectorAll('[data-testid="bufferline-row"]');
        return {
            scrollTop: container.scrollTop,
            scrollHeight: container.scrollHeight,
            clientHeight: container.clientHeight,
            atBottom:
        container.scrollTop >=
        container.scrollHeight - container.clientHeight - 3,
            scrollDiffFromBottom:
        container.scrollHeight - container.clientHeight - container.scrollTop,
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
            const diff = el.scrollHeight - el.clientHeight - el.scrollTop;
            return diff <= 5;
        },
        container,
        { timeout },
    );
}

// Wait for scroll effect to settle regardless of position
async function waitForScrollStable(timeout = 5000) {
    await page.waitForFunction(
        () => {
            const el = document.querySelector(
                '[data-testid="chat-messages"]',
            ) as HTMLElement;
            if (!el) return false;
            const currentScrollTop = el.scrollTop;
            return currentScrollTop !== undefined && currentScrollTop >= 0;
        },
        { timeout },
    );
    await page.waitForTimeout(300);
}

test.beforeEach(async () => {
    // Reset buffer state: absorb all unread and scroll to bottom for a clean baseline
    await switchToBuffer(page, "#glowing-bear");
    await waitForScrollSettled(3000);

    const chatContainer = page.locator('[data-testid="chat-messages"]');
    await chatContainer.evaluate((el) => {
        (el as HTMLElement).scrollTop = (el as HTMLElement).scrollHeight;
    });
    await waitForScrollSettled(3000);

    // Send a dummy message to advance lastSeen past all existing content
    await irc.sendMessage("#glowing-bear", `BEFORE-EACH-RESET-${Date.now()}`);
    await page.waitForTimeout(2000);
    await chatContainer.evaluate((el) => {
        (el as HTMLElement).scrollTop = (el as HTMLElement).scrollHeight;
    });
    await waitForScrollSettled(10000);
});

test("long wrapping message should still trigger scroll follow when at bottom", async () => {
    // Regression test: a very long line that wraps to multiple visual lines can
    // cause scrollHeight to grow significantly (~100px+), potentially breaking the
    // tolerance-based isAtBottom check in the auto-scroll effect. This test verifies
    // that scroll follow still works correctly for wrapped messages.
    await switchToBuffer(page, "#glowing-bear");
    await waitForScrollSettled();

    const stateBefore = await getChatScrollState();
    expect(stateBefore).not.toBeNull();
    expect(stateBefore!.atBottom).toBe(true);

    const linesBefore = stateBefore!.totalLines;
    const msgText = `long-wrap-test-${Date.now()}`;
    // Prepend a unique prefix so we can find the row by text content
    const fullMessage = `${msgText}: ${longMessage}`;

    const input = page.getByTestId("message-input");
    await input.click();
    await input.fill(fullMessage);
    await input.press("Enter");

    // Wait for the new line to render in DOM
    await page.waitForFunction(
        (expected) => {
            const rows = document.querySelectorAll('[data-testid="bufferline-row"]');
            return rows.length >= expected;
        },
        linesBefore + 1,
        { timeout: 15000 },
    );

    // Wait for scroll effects to settle after rendering the tall wrapped message
    await waitForScrollStable(15000);

    // Verify the message row rendered with multiple visual lines
    const rowHeight = await page.evaluate((text) => {
        const rows = Array.from(
            document.querySelectorAll('[data-testid="bufferline-row"]'),
        );
        const targetRow = rows.find((row) => row.textContent?.includes(text));
        if (!targetRow) return null;
        return targetRow.getBoundingClientRect().height;
    }, msgText);
    expect(rowHeight).not.toBeNull();
    // A single-line message is ~24-30px; a wrapped message should be significantly taller
    expect(rowHeight!).toBeGreaterThan(60);

    // Verify the view scrolled to bottom after sending the long message
    const stateAfter = await getChatScrollState();
    expect(stateAfter).not.toBeNull();
    expect(stateAfter!.atBottom).toBe(true);
    expect(stateAfter!.scrollDiffFromBottom).toBeLessThanOrEqual(5);

    // Verify the new message is visible in viewport near bottom
    await expect(async () => {
        const result = await page.evaluate((text) => {
            const container = document.querySelector(
                '[data-testid="chat-messages"]',
            ) as HTMLElement;
            if (!container) return null;
            const rows = Array.from(
                document.querySelectorAll('[data-testid="bufferline-row"]'),
            );
            const targetRow = rows.find((row) => row.textContent?.includes(text));
            if (!targetRow) return null;
            const rowRect = targetRow.getBoundingClientRect();
            const contRect = container.getBoundingClientRect();
            const relativeY = (rowRect.top - contRect.top) / contRect.height;
            return {
                relativeY,
                visible: rowRect.bottom > contRect.top && rowRect.top < contRect.bottom,
                height: rowRect.height,
            };
        }, msgText);
        expect(result).not.toBeNull();
        expect(result!.visible).toBe(true);
        // The end of the wrapped message should be near the bottom of the viewport
        expect(result!.relativeY).toBeGreaterThan(0.3);
    }).toPass({ timeout: 20000, intervals: [500] });
});

test("long wrapping message should NOT auto-scroll when user scrolled up", async () => {
    // When the user has intentionally scrolled up to read older messages,
    // a long wrapping message arriving should NOT cause the view to scroll.
    await switchToBuffer(page, "#glowing-bear");
    await waitForScrollSettled();

    // Send enough padding messages first to ensure the container is scrollable
    for (let i = 0; i < 15; i++) {
        await irc.sendMessage("#glowing-bear", `scroll-pad-${Date.now()}-${i}`);
    }
    await page.waitForFunction(
        () => {
            const rows = document.querySelectorAll('[data-testid="bufferline-row"]');
            return rows.length >= 15;
        },
        { timeout: 15000 },
    );
    await page.waitForTimeout(500);
    await waitForScrollSettled(10000);

    const state = await getChatScrollState();
    if (!state || state.scrollHeight - state.clientHeight < 100) {
        test.skip();
        return;
    }

    // Scroll up to ~60% from top (clearly not at bottom)
    const scrollBefore = await page.evaluate(() => {
        const container = document.querySelector(
            '[data-testid="chat-messages"]',
        ) as HTMLElement;
        if (!container) return null;
        const maxScrollTop = container.scrollHeight - container.clientHeight;
        const targetScrollTop = maxScrollTop * 0.4;
        container.scrollTop = targetScrollTop;
        container.dispatchEvent(new Event("scroll", { bubbles: true }));
        return {
            scrollTop: container.scrollTop,
            scrollHeight: container.scrollHeight,
            clientHeight: container.clientHeight,
        };
    });
    expect(scrollBefore).not.toBeNull();
    const diffFromBottom =
    scrollBefore!.scrollHeight -
    scrollBefore!.clientHeight -
    scrollBefore!.scrollTop;
    expect(diffFromBottom).toBeGreaterThan(100);

    // Send the long wrapping message via IRC while user is scrolled up
    const msgText = `long-wrap-no-scroll-${Date.now()}`;
    const fullMessage = `${msgText}: ${longMessage}`;
    await irc.sendMessage("#glowing-bear", fullMessage);

    // Wait for the message to render
    await page.waitForTimeout(2000);
    await waitForScrollStable();

    // Verify scroll position stayed roughly the same (within 50px)
    const scrollAfter = await page.evaluate(() => {
        const container = document.querySelector(
            '[data-testid="chat-messages"]',
        ) as HTMLElement;
        if (!container) return null;
        return {
            scrollTop: container.scrollTop,
            scrollHeight: container.scrollHeight,
            clientHeight: container.clientHeight,
        };
    });
    expect(scrollAfter).not.toBeNull();
    const scrollShift = Math.abs(
    scrollAfter!.scrollTop - scrollBefore!.scrollTop,
    );
    expect(scrollShift).toBeLessThan(50);

    // Readmarker should be visible since there are unread messages
    const readmarker = page.getByTestId("readmarker");
    await expect(readmarker).toBeVisible();

    // The new message should exist in DOM but NOT be visible in viewport
    const newMsgVisibility = await page.evaluate((text) => {
        const container = document.querySelector(
            '[data-testid="chat-messages"]',
        ) as HTMLElement;
        const rows = Array.from(
            document.querySelectorAll('[data-testid="bufferline-row"]'),
        );
        const targetRow = rows.find((row) => row.textContent?.includes(text));
        if (!targetRow || !container) return null;
        const rowRect = targetRow.getBoundingClientRect();
        const contRect = container.getBoundingClientRect();
        return {
            exists: true,
            visible: rowRect.bottom > contRect.top && rowRect.top < contRect.bottom,
        };
    }, msgText);
    expect(newMsgVisibility).not.toBeNull();
    expect(newMsgVisibility!.exists).toBe(true);
    expect(newMsgVisibility!.visible).toBe(false);
});
