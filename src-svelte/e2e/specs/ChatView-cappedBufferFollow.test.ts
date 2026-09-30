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

// A long single line that wraps to several visual rows. The height mismatch
// between the trimmed row and the appended row is what makes the bug visible.
const longMessage =
    "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.";

const CONTAINER = '[data-testid="chat-messages"]';
// Row selector is written inline inside page.evaluate callbacks, where
// module-scope constants do not exist.

// Read the chat container's scroll geometry plus the rendered row count.
async function scrollState() {
    return await page.evaluate(
        (sel) => {
            const c = document.querySelector(sel) as HTMLElement | null;
            if (!c) return null;
            return {
                scrollTop: c.scrollTop,
                scrollHeight: c.scrollHeight,
                clientHeight: c.clientHeight,
                // Distance still left to the true bottom.
                diff: c.scrollHeight - c.clientHeight - c.scrollTop,
                rows: document.querySelectorAll('[data-testid="bufferline-row"]').length,
            };
        },
        CONTAINER,
    );
}

// Bottom gap (px) of the LAST rendered row relative to the container's viewport
// bottom. ~0 means the newest line is on screen at the bottom of the view.
async function lastRowBottomGap() {
    return await page.evaluate(
        (sel) => {
            const c = document.querySelector(sel) as HTMLElement | null;
            if (!c) return null;
            const rows = document.querySelectorAll<HTMLElement>('[data-testid="bufferline-row"]');
            if (rows.length === 0) return null;
            const rr = rows[rows.length - 1].getBoundingClientRect();
            return Math.round(c.getBoundingClientRect().bottom - rr.bottom);
        },
        CONTAINER,
    );
}

// Scroll the container to its true bottom and wait for it to settle there.
async function scrollContainerToBottom() {
    await page.evaluate((sel) => {
        (document.querySelector(sel) as HTMLElement).scrollTop =
            (document.querySelector(sel) as HTMLElement).scrollHeight;
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

/**
 * Pad the channel until the buffer stops growing, i.e. until it hits
 * settings.maxBufferLines and every incoming line trims one off the front.
 * Detecting the cap by "row count no longer increases" keeps this test valid
 * whatever the configured cap is, and it is exactly the state where the
 * length-based change detection used to break.
 */
async function padUntilCapped(maxMessages = 600) {
    let prevRows = -1;
    let stable = 0;
    for (let i = 0; i < maxMessages; i++) {
        const rows = (await scrollState())?.rows ?? 0;
        if (rows === prevRows) {
            stable++;
            if (stable >= 2) return rows;
        } else {
            stable = 0;
        }
        prevRows = rows;
        await irc.sendMessage("#glowing-bear", `cap-pad-${Date.now()}-${i}`);
        await page.waitForTimeout(40);
    }
    return prevRows;
}

// Wait until a row containing `text` is rendered.
async function waitForRow(text: string) {
    await page.waitForFunction(
        (t) =>
            Array.from(document.querySelectorAll('[data-testid="bufferline-row"]')).some((r) =>
                r.textContent?.includes(t),
            ),
        text,
        { timeout: 15000 },
    );
}

// Pad to the cap and settle at the bottom — the user's state before the new line.
async function setupCappedAtBottom() {
    await switchToBuffer(page, "#glowing-bear");
    const rows = await padUntilCapped();
    await page.waitForTimeout(400);
    await scrollContainerToBottom();
    const at = await scrollState();
    // Precondition: the buffer really is capped and really is scrollable.
    expect(rows).toBeGreaterThan(50);
    expect(at).not.toBeNull();
    expect(at!.scrollHeight - at!.clientHeight).toBeGreaterThan(100);
    expect(at!.diff).toBeLessThanOrEqual(2);
    return at!;
}

test("at the line cap, a long own message still follows to the bottom", async () => {
    // Regression test: once a buffer reaches maxBufferLines, handlers append the
    // new line and trim one off the front in the same update, so messages.length
    // never changes. The auto-scroll effect used to gate on
    // "messages.length > previous length", which is false forever after — so
    // auto-follow silently stopped and the newest line landed below the fold.
    const before = await setupCappedAtBottom();

    const text = `cap-own-long-${Date.now()}`;
    const input = page.getByTestId("message-input");
    await input.click();
    await input.fill(`${text}: ${longMessage}`);
    await input.press("Enter");

    await waitForRow(text);
    // Give the settle-window pin loop time to run (it pins for up to ~400ms).
    await page.waitForTimeout(900);

    const after = await scrollState();
    expect(after).not.toBeNull();
    // Row count must still be pinned at the cap (the trim happened too).
    expect(after!.rows).toBe(before.rows);
    // The container must be at its true bottom...
    expect(after!.diff).toBeLessThanOrEqual(2);
    // ...with the newest row actually on screen.
    const gap = await lastRowBottomGap();
    expect(gap).not.toBeNull();
    expect(gap!).toBeLessThanOrEqual(12);
});

test("at the line cap, a long incoming message still follows to the bottom", async () => {
    const before = await setupCappedAtBottom();

    const text = `cap-bot-long-${Date.now()}`;
    await irc.sendMessage("#glowing-bear", `${text}: ${longMessage}`);
    await waitForRow(text);
    await page.waitForTimeout(900);

    const after = await scrollState();
    expect(after).not.toBeNull();
    expect(after!.rows).toBe(before.rows);
    expect(after!.diff).toBeLessThanOrEqual(2);
    const gap = await lastRowBottomGap();
    expect(gap).not.toBeNull();
    expect(gap!).toBeLessThanOrEqual(12);
});

test("at the line cap, a short own message still follows to the bottom", async () => {
    await setupCappedAtBottom();

    const text = `cap-own-short-${Date.now()}`;
    const input = page.getByTestId("message-input");
    await input.click();
    await input.fill(text);
    await input.press("Enter");

    await waitForRow(text);
    await page.waitForTimeout(900);

    const after = await scrollState();
    expect(after).not.toBeNull();
    expect(after!.diff).toBeLessThanOrEqual(2);
    const gap = await lastRowBottomGap();
    expect(gap).not.toBeNull();
    expect(gap!).toBeLessThanOrEqual(12);
});

test("at the line cap, a user who scrolled up is not dragged to the bottom", async () => {
    // The cap fix must not turn auto-follow into a forced scroll: a reader who
    // scrolled back to catch up keeps their position.
    await setupCappedAtBottom();

    await page.evaluate((sel) => {
        const c = document.querySelector(sel) as HTMLElement;
        c.scrollTop = c.scrollHeight - c.clientHeight - 600;
    }, CONTAINER);
    await page.waitForTimeout(400);

    const parked = await scrollState();
    expect(parked).not.toBeNull();
    expect(parked!.diff).toBeGreaterThan(100);

    const text = `cap-scrollaway-${Date.now()}`;
    await irc.sendMessage("#glowing-bear", `${text}: ${longMessage}`);
    await waitForRow(text);
    await page.waitForTimeout(900);

    const after = await scrollState();
    expect(after).not.toBeNull();
    // Still holding the same reading position, well above the bottom.
    expect(Math.abs(after!.scrollTop - parked!.scrollTop)).toBeLessThan(60);
    expect(after!.diff).toBeGreaterThan(100);
});

test("at the line cap, a reader who breaks away after a flood is not dragged back", async () => {
    // While a reader is following, incoming lines re-pin the view to the bottom for
    // a short settle window, so during a fast flood (~1 line per 120ms) the view
    // stays pinned and cannot be broken out of mid-flood. That is existing
    // behaviour, measured as identical below the line cap before and after this
    // fix; it is not asserted or re-designed here. What this test does pin down is
    // the guarantee that matters for the cap fix: once the settle window expires and
    // the reader is free, incoming lines accumulate behind them.
    await setupCappedAtBottom();

    for (let i = 0; i < 15; i++) {
        await irc.sendMessage("#glowing-bear", `cap-flood-${Date.now()}-${i}`);
        await page.waitForTimeout(120);
    }
    // Let the follow-settle window expire.
    await page.waitForTimeout(600);

    // Break away.
    await page.evaluate((sel) => {
        const c = document.querySelector(sel) as HTMLElement;
        c.scrollTop = Math.max(0, c.scrollHeight - c.clientHeight - 400);
        c.dispatchEvent(new Event("scroll", { bubbles: true }));
    }, CONTAINER);
    await page.waitForTimeout(400);

    const away = await scrollState();
    expect(away).not.toBeNull();
    expect(away!.diff).toBeGreaterThan(100);

    // A new line must land behind the reader, out of view.
    const marker = `cap-after-flood-${Date.now()}`;
    await irc.sendMessage("#glowing-bear", marker);
    await waitForRow(marker);
    await page.waitForTimeout(900);

    const after = await scrollState();
    expect(after).not.toBeNull();
    expect(after!.diff).toBeGreaterThan(100);
    // The newest row sits below the viewport: the reader was not pulled back down.
    const gap = await lastRowBottomGap();
    expect(gap).not.toBeNull();
    expect(gap!).toBeLessThan(0);
});