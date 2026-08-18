import { test, expect } from "@playwright/test";
import { createConnectedPage } from "../fixtures/auth";
import { switchToBuffer } from "../helpers/buffers";
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

// A very long single line that wraps to many visual lines in the chat view.
const longMessage =
    "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum. Sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium doloremque laudantium, totam rem aperiam, eaque ipsa quae ab illo inventore veritatis et quasi architecto beatae vitae dicta sunt explicabo.";

const CONTAINER = '[data-testid="chat-messages"]';

// Read the chat container's scroll geometry.
async function scrollState() {
    return await page.evaluate((sel) => {
        const c = document.querySelector(sel) as HTMLElement | null;
        if (!c) return null;
        return {
            scrollTop: c.scrollTop,
            scrollHeight: c.scrollHeight,
            clientHeight: c.clientHeight,
            diff: c.scrollHeight - c.clientHeight - c.scrollTop,
            rows: document.querySelectorAll('[data-testid="bufferline-row"]').length,
        };
    }, CONTAINER);
}

// Bottom gap (px) of the LAST rendered row relative to the container's viewport
// bottom. ~0 means the newest line is at the bottom of the view.
async function lastRowBottomGap() {
    return await page.evaluate((sel) => {
        const c = document.querySelector(sel) as HTMLElement | null;
        if (!c) return null;
        const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="bufferline-row"]'));
        if (rows.length === 0) return null;
        const rr = rows[rows.length - 1].getBoundingClientRect();
        const cr = c.getBoundingClientRect();
        return Math.round(cr.bottom - rr.bottom);
    }, CONTAINER);
}

// Scroll the container to its true bottom and wait for it to settle there.
async function scrollContainerToBottom() {
    await page.evaluate((sel) => {
        const c = document.querySelector(sel) as HTMLElement;
        c.scrollTop = c.scrollHeight;
    }, CONTAINER);
    await page.waitForFunction(
        (sel) => {
            const c = document.querySelector(sel) as HTMLElement;
            return c.scrollHeight - c.clientHeight - c.scrollTop <= 2;
        },
        CONTAINER,
        { timeout: 10000 },
    );
}

// Pad the channel with short messages until the buffer is genuinely scrollable
// (content taller than the viewport by at least `minExtra` px). This makes
// "at bottom" a real, non-vacuous state — the precondition for the bug.
async function padUntilScrollable(minExtra = 250) {
    for (let i = 0; i < 80; i++) {
        const s = await scrollState();
        if (s && s.scrollHeight - s.clientHeight > minExtra) break;
        await irc.sendMessage("#glowing-bear", `pad-${Date.now()}-${i}`);
        await page.waitForTimeout(80);
    }
}

test.beforeEach(async () => {
    await switchToBuffer(page, "#glowing-bear");
    // Make the buffer scrollable, then sit at the true bottom — the user's
    // starting state before typing the long line.
    await padUntilScrollable();
    await page.waitForTimeout(400);
    await scrollContainerToBottom();
});

test("typing a long wrapping line while at the bottom keeps the newest line visible", async () => {
    // Regression test for the Tauri/WKWebView scroll-stranding bug:
    //   1. User is at the bottom of a scrollable buffer.
    //   2. User types a long line — the input bar grows (up to 150px), shrinking
    //      the chat container.
    //   3. User sends — the input bar collapses and the wrapping line reflows
    //      across several frames (scrollHeight bounces).
    // A stray mid-layout scroll event could flip isAtBottom to false and leave
    // the view stranded above the true bottom. After the fix (settle-window pin
    // + sticky isAtBottom), the LAST row must end up at the viewport bottom.
    const before = await scrollState();
    expect(before).not.toBeNull();
    // Confirm we genuinely start at the bottom of a scrollable buffer.
    expect(before!.scrollHeight - before!.clientHeight).toBeGreaterThan(100);
    expect(before!.diff).toBeLessThanOrEqual(2);

    const msgText = `long-wrap-${Date.now()}`;
    const fullMessage = `${msgText}: ${longMessage}`;

    // Type the long line the way a user does (fill sets the value and fires
    // input, which grows the textarea). The grown input bar shrinks the
    // container — the exact geometry that triggered the bug.
    const input = page.getByTestId("message-input");
    await input.click();
    await input.fill(fullMessage);
    // Let the input bar finish growing.
    await page.waitForTimeout(300);

    const afterType = await scrollState();
    expect(afterType).not.toBeNull();
    // The container should have shrunk (clientHeight dropped) while the textarea
    // is grown — confirms we exercised the real geometry, not a no-op.
    expect(afterType!.clientHeight).toBeLessThan(before!.clientHeight);

    // Send.
    await input.press("Enter");

    // Wait for the echo to render, then for the scroll to settle at the bottom.
    await page.waitForFunction(
        (text) => {
            const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="bufferline-row"]'));
            return rows.some((r) => r.textContent?.includes(text));
        },
        msgText,
        { timeout: 15000 },
    );
    // Give the settle-window pin loop time to run (it pins for up to ~400ms).
    await page.waitForFunction(
        (sel) => {
            const c = document.querySelector(sel) as HTMLElement;
            return c.scrollHeight - c.clientHeight - c.scrollTop <= 2;
        },
        CONTAINER,
        { timeout: 15000 },
    );
    await page.waitForTimeout(600);

    // The container must be at its true bottom...
    const after = await scrollState();
    expect(after).not.toBeNull();
    expect(after!.diff).toBeLessThanOrEqual(2);

    // ...and the LAST row (the newest line) must be at the viewport bottom.
    // The container has ~4-6px of CSS bottom padding, so allow a small residual.
    const gap = await lastRowBottomGap();
    expect(gap).not.toBeNull();
    expect(gap!).toBeLessThanOrEqual(12);
});
