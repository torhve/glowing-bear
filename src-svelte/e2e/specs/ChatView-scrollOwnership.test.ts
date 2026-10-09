import { test, expect } from '@playwright/test';
import { createConnectedPage } from '../fixtures/auth';
import { switchToBuffer } from '../helpers/buffers';
import { irc, sendSequence } from '../helpers/irc-control';
import { setupEffectOrphanFilter } from '../helpers/pageerror';
import { waitForChatSettled, waitForRow, waitForRowCountAtLeast } from '../helpers/waits';

let page: import('@playwright/test').Page;

test.describe.configure({ mode: 'serial' });

// gbtest keeps its channel history between runs, so every token this spec sends is
// unique per run: a bare marker would match a row left over from an earlier run.
const runStamp = Date.now();

test.beforeAll(async ({ browser }) => {
    page = await createConnectedPage(browser);
    setupEffectOrphanFilter(page);
});

test.afterAll(async () => {
    if (page) await page.close();
});

const longMessage =
    'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.';

/** The view's own report of what it is still doing. */
async function followState() {
    return page.evaluate(() => {
        const hook = (window as typeof window & {
            __chatFollowState?: () => {
                pinning: boolean;
                pendingFrames: number;
                mode: string;
                pinActivations: number;
            };
        }).__chatFollowState;
        return hook ? hook() : null;
    });
}

/**
 * Where one rendered row sits relative to the chat viewport.
 *
 * `scrollTop` is the wrong quantity to assert on: when the app trims retained
 * rows off the front, the height above the reader changes and the browser moves
 * `scrollTop` to keep the same content on screen. What the reader actually
 * experiences is a row staying at the same place in the window they are looking
 * at, so that is the quantity measured here.
 */
async function rowPlacement(text: string | null) {
    return page.evaluate((needle) => {
        const container = document.querySelector('[data-testid="chat-messages"]') as HTMLElement | null;
        if (!container) return null;
        const rows = Array.from(document.querySelectorAll('[data-testid="bufferline-row"]'));
        const row = needle === null ? rows[rows.length - 1] : rows.find((r) => r.textContent?.includes(needle));
        if (!row) return null;
        const box = container.getBoundingClientRect();
        const rect = row.getBoundingClientRect();
        return {
            offsetInViewport: Math.round(rect.top - box.top),
            visible: rect.bottom > box.top && rect.top < box.bottom,
            rowIndex: rows.indexOf(row),
            rowCount: rows.length,
            scrollTop: Math.round(container.scrollTop),
            diffFromBottom: Math.round(container.scrollHeight - container.clientHeight - container.scrollTop),
        };
    }, text);
}

/**
 * Move the view with a real wheel gesture and wait until it holds there.
 *
 * A scrollTop assignment is not an option here. It fires no wheel event, and the
 * view is entitled to read a scroll it did not see a gesture for as its own
 * layout — inside the follow-settle window that is exactly what it assumes. Only
 * a gesture is the reader's own intent, and these tests are about intent.
 */
async function wheelChat(deltaY: number) {
    const box = await page.locator('[data-testid="chat-messages"]').boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.wheel(0, deltaY);
    await waitForChatSettled(page);
}

async function parkAtBottom() {
    // Being at the tail is a geometric fact, not a claim about who moved the view,
    // so this one write is honest. A single wheel is not: engines clamp a large
    // delta, and a wheel aimed at "the bottom" lands wherever it lands.
    await page.evaluate(() => {
        const el = document.querySelector('[data-testid="chat-messages"]') as HTMLElement;
        el.scrollTop = el.scrollHeight;
    });
    await waitForChatSettled(page);
    const at = await rowPlacement(null);
    expect(at).not.toBeNull();
    expect(at!.diffFromBottom).toBeLessThanOrEqual(4);
}

/** Park `offset` px above the bottom and confirm the view actually stayed there. */
async function parkAbove(offset: number) {
    await wheelChat(-offset);
    const at = await rowPlacement(null);
    expect(at).not.toBeNull();
    expect(at!.diffFromBottom).toBeGreaterThanOrEqual(offset - 40);
}
/**
 * The rendered row directly above the row containing `exclude`.
 *
 * The reader has to be above the content that will grow. Anchoring on a row below
 * it would measure the growth itself and read it as the reader having moved.
 */
async function pickRowAbove(exclude: string) {
    return page.evaluate((needle) => {
        const container = document.querySelector('[data-testid="chat-messages"]') as HTMLElement;
        const box = container.getBoundingClientRect();
        const rows = Array.from(document.querySelectorAll('[data-testid="bufferline-row"]'));
        const idx = rows.findIndex((r) => r.textContent?.includes(needle));
        if (idx < 1) return '';
        const row = rows[idx - 1];
        const rect = row.getBoundingClientRect();
        if (rect.bottom <= box.top || rect.top >= box.bottom) return '';
        return row.textContent ?? '';
    }, exclude);
}

/** Pad the channel until the view is genuinely scrollable. */
async function padChannel(count: number, stamp = Date.now()) {
    await sendSequence(
        '#glowing-bear',
        Array.from({ length: count }, (_, i) => `own-pad-${stamp}-${i}`),
    );
    await waitForRowCountAtLeast(page, 40);
    return stamp;
}

test('a reader keeps the row they were reading at the same place in the viewport while content above is trimmed', async () => {
    await switchToBuffer(page, '#glowing-bear');
    await padChannel(160);
    await parkAtBottom();

    // Park well above the bottom, then pick the row nearest the top of the window.
    await parkAbove(700);
    const anchorText = await page.evaluate(() => {
        const container = document.querySelector('[data-testid="chat-messages"]') as HTMLElement;
        const box = container.getBoundingClientRect();
        const rows = Array.from(document.querySelectorAll('[data-testid="bufferline-row"]'));
        // The first row that is still on screen is the one the reader is looking at.
        const row = rows.find((r) => r.getBoundingClientRect().bottom > box.top + 4);
        return row?.textContent ?? '';
    });
    expect(anchorText).not.toBe('');

    const parked = await rowPlacement(anchorText);
    expect(parked).not.toBeNull();
    expect(parked!.visible).toBe(true);
    expect(parked!.diffFromBottom).toBeGreaterThan(200);

    // New lines arrive below the reader, and the retained-row cap trims rows off
    // the front — the content above the anchor changes on both sides.
    await irc.sendMessage('#glowing-bear', `own-after-anchor-${runStamp}`);
    await waitForRow(page, `own-after-anchor-${runStamp}`);
    await waitForChatSettled(page);

    const after = await rowPlacement(anchorText);
    expect(after).not.toBeNull();
    // Same row, same place in the window.
    // A couple of pixels is row-height rounding, not movement: the row the reader
    // was looking at is still the row they are looking at.
    expect(Math.abs(after!.offsetInViewport - parked!.offsetInViewport)).toBeLessThanOrEqual(2);
    expect(after!.visible).toBe(true);
    // The reader was not dragged: the newest line is still out of view below them.
    expect(after!.diffFromBottom).toBeGreaterThan(200);
    // The row they were reading is no longer the same row from the top of the DOM,
    // which is what proves the offset was held through a change above it.
    expect(after!.rowIndex).not.toBe(parked!.rowIndex);
});

test('a reader who scrolls away during an active follow pin keeps their position', async () => {
    await switchToBuffer(page, '#glowing-bear');
    await parkAtBottom();
    const pinsBefore = (await followState())?.pinActivations ?? 0;

    // A burst of long lines re-wraps over several frames, so a follow pin is
    // running while the reader interrupts it. Whether a pin actually ran is read
    // from a count rather than from `pinning`: a pin lasts a few frames, and a
    // poll aimed at that window is a race, not a check.
    const stamp = Date.now();
    await sendSequence(
        '#glowing-bear',
        Array.from({ length: 6 }, (_, i) => `interrupt-${stamp}-${i}: ${longMessage}`),
    );

    // A real wheel gesture, not a scrollTop assignment. A programmatic write fires
    // no wheel event, so the view cannot tell it from its own layout — and inside
    // the follow-settle window that is exactly what it is assumed to be. Only a
    // gesture is the reader's own intent.
    const box = await page.locator('[data-testid="chat-messages"]').boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.wheel(0, -400);
    await waitForChatSettled(page);

    const state = await page.evaluate(() => {
        const el = document.querySelector('[data-testid="chat-messages"]') as HTMLElement;
        return {
            diff: el.scrollHeight - el.clientHeight - el.scrollTop,
            newestVisible: (() => {
                const rows = Array.from(document.querySelectorAll('[data-testid="bufferline-row"]'));
                const last = rows[rows.length - 1];
                if (!last) return false;
                const box = el.getBoundingClientRect();
                return last.getBoundingClientRect().top < box.bottom;
            })(),
        };
    });

    // A pin really did run for these lines, and it finished where the reader left
    // the view instead of pulling them back to the lines that caused it.
    expect((await followState())?.pinActivations).toBeGreaterThan(pinsBefore);
    expect(state.diff).toBeGreaterThan(150);
    expect(state.newestVisible).toBe(false);
});

test('a buffer whose content fits the viewport has nothing to scroll and settles idle', async () => {
    // A freshly joined channel carries only the IRC server's join and topic lines,
    // which is the reachable near-empty state: content that does not fill the view.
    // A buffer with literally zero lines is covered in the controller's own suite,
    // where that state can be constructed exactly.
    const channel = `#gb-idle-${Date.now()}`;
    const input = page.getByTestId('message-input');
    await input.click();
    await input.fill(`/join ${channel}`);
    await input.press('Enter');
    await switchToBuffer(page, channel);

    await expect
        .poll(async () => page.locator('[data-testid="bufferline-row"]').count(), { timeout: 10000 })
        .toBeGreaterThan(0);

    const idle = await page.evaluate(() => {
        const el = document.querySelector('[data-testid="chat-messages"]') as HTMLElement;
        return { scrollTop: el.scrollTop, scrollable: el.scrollHeight - el.clientHeight };
    });
    expect(idle.scrollable).toBeLessThanOrEqual(0);
    expect(idle.scrollTop).toBe(0);
    await waitForChatSettled(page);
    const state = await followState();
    expect(state?.pendingFrames).toBe(0);
    expect(state?.pinning).toBe(false);
    // Nothing to place, so nothing was placed: the view reached idle without starting
    // a single follow pin. Counted from here rather than from zero because the
    // controller outlives the buffer it is placed on.
    const pinsAtIdle = state?.pinActivations ?? 0;
    await waitForChatSettled(page);
    expect((await followState())?.pinActivations).toBe(pinsAtIdle);

    // The first new line still has to become visible.
    await irc.sendMessage(channel, `first-line-in-short-${runStamp}`);
    await waitForRow(page, `first-line-in-short-${runStamp}`);
    await waitForChatSettled(page);
    const placed = await rowPlacement(`first-line-in-short-${runStamp}`);
    expect(placed?.visible).toBe(true);
    expect(placed!.diffFromBottom).toBeLessThanOrEqual(5);

    await input.click();
    await input.fill(`/part ${channel}`);
    await input.press('Enter');
    await switchToBuffer(page, '#glowing-bear');
});

test('a narrow viewport still follows a long wrapping line to the bottom', async () => {
    const previous = page.viewportSize();
    await page.setViewportSize({ width: 380, height: 520 });
    try {
        await switchToBuffer(page, '#glowing-bear');
        await parkAtBottom();

        await irc.sendMessage('#glowing-bear', `narrow-long: ${longMessage}`);
        await waitForRow(page, 'narrow-long');
        await waitForChatSettled(page);

        const state = await page.evaluate(() => {
            const el = document.querySelector('[data-testid="chat-messages"]') as HTMLElement;
            const rows = Array.from(document.querySelectorAll('[data-testid="bufferline-row"]'));
            const last = rows[rows.length - 1];
            const box = el.getBoundingClientRect();
            return {
                diff: Math.round(el.scrollHeight - el.clientHeight - el.scrollTop),
                lastVisible: last ? last.getBoundingClientRect().bottom <= box.bottom + 4 : false,
                scrollable: el.scrollHeight - el.clientHeight,
            };
        });
        // A narrow viewport wraps the same line into many more visual rows, which is
        // exactly when the follow decision matters.
        expect(state.scrollable).toBeGreaterThan(100);
        expect(state.diff).toBeLessThanOrEqual(5);
        expect(state.lastVisible).toBe(true);
    } finally {
        if (previous) await page.setViewportSize(previous);
    }
});

test('media that expands after the fact grows the layout below a parked reader without moving them', async () => {
    const stamp = Date.now();
    // Served from the app's own origin. A routed off-site URL is not enough: the
    // app's service worker is a fetch-through, and on WebKit it answers the image
    // request before Playwright's route is consulted, so the picture never arrives
    // and the test would pass without ever growing the layout.
    const url = new URL('/gb-embed-probe.svg', page.url()).href;

    await switchToBuffer(page, '#glowing-bear');
    await padChannel(60, stamp);
    await parkAtBottom();

    await irc.sendMessage('#glowing-bear', `slow-media-${stamp} ${url}`);
    // Filler after the media line, so the media row is not the newest content.
    // If it were, revealing it would also be the view's own tail and the test
    // could not tell following from being dragged.
    await sendSequence(
        '#glowing-bear',
        Array.from({ length: 20 }, (_, i) => `after-media-${stamp}-${i}`),
    );

    const mediaRow = page
        .locator('[data-testid="bufferline-row"]')
        .filter({ hasText: `slow-media-${stamp}` })
        .first();
    await expect(mediaRow.locator('[data-testid="show-embed"]')).toBeVisible({ timeout: 10000 });

    // Park with the reader's own row on screen and the media row below them,
    // still collapsed to a single line. The reveal button has to be on screen
    // already: Playwright scrolls a target into view before clicking it, which
    // would itself move the view and destroy the state under test.
    // Park far enough above the bottom to be unambiguously away from the tail,
    // and far enough down that the collapsed media row is still on screen.
    await parkAbove(150);
    const anchorText = await pickRowAbove(`slow-media-${stamp}`);
    expect(anchorText).not.toBe('');
    const parked = await rowPlacement(anchorText);
    expect(parked?.visible).toBe(true);
    await expect(mediaRow.locator('[data-testid="show-embed"]')).toBeInViewport();
    const heightBefore = await mediaRow.evaluate((el) => (el as HTMLElement).getBoundingClientRect().height);

    // The picture is revealed: the row grows by hundreds of pixels and nothing
    // about the message list changed.
    await mediaRow.locator('[data-testid="show-embed"]').click();
    const img = mediaRow.locator('img.embed');
    await expect(img).toBeVisible({ timeout: 10000 });
    await expect
        .poll(async () => img.evaluate((el) => (el as HTMLImageElement).naturalWidth), { timeout: 10000 })
        .toBeGreaterThan(0);
    const heightAfter = await mediaRow.evaluate((el) => (el as HTMLElement).getBoundingClientRect().height);
    expect(heightAfter - heightBefore).toBeGreaterThan(100);

    await waitForChatSettled(page);

    const after = await rowPlacement(anchorText);
    expect(after).not.toBeNull();
    // The reader is still looking at the same row, at the same height in the
    // window. The row that grew below them did not take them with it.
    expect(after!.visible).toBe(true);
    expect(Math.abs(after!.offsetInViewport - parked!.offsetInViewport)).toBeLessThanOrEqual(4);
    expect(after!.diffFromBottom).toBeGreaterThan(150);
});
