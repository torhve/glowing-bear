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
async function followState(p: import('@playwright/test').Page) {
    return p.evaluate(() => {
        const hook = (window as typeof window & {
            __chatFollowState?: () => {
                pinning: boolean;
                pendingFrames: number;
                mode: string;
                pinActivations: number;
                lastNavigationSource: string | null;
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
async function rowPlacement(p: import('@playwright/test').Page, text: string | null) {
    return p.evaluate((needle) => {
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
async function wheelChat(p: import('@playwright/test').Page, deltaY: number) {
    const box = await p.locator('[data-testid="chat-messages"]').boundingBox();
    expect(box).not.toBeNull();
    await p.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await p.mouse.wheel(0, deltaY);
    await waitForChatSettled(p);
}

async function parkAtBottom(p: import('@playwright/test').Page) {
    // Being at the tail is a geometric fact, not a claim about who moved the view,
    // so this write is honest. A single wheel is not: an engine clamps a large
    // delta and a wheel aimed at "the bottom" lands wherever it lands.
    //
    // It is also a loop. Reaching the retention cap trims rows off the front, the
    // browser answers by pulling scrollTop back to keep content on screen, and a
    // single write measured after that lands a little above the tail. Retrying until
    // the geometry agrees is the harness establishing its own precondition; the
    // assertions that follow are the actual claims.
    for (let attempt = 0; attempt < 6; attempt++) {
        await p.evaluate(() => {
            const el = document.querySelector('[data-testid="chat-messages"]') as HTMLElement;
            el.scrollTop = el.scrollHeight;
        });
        await waitForChatSettled(p);
        const at = await rowPlacement(p, null);
        expect(at).not.toBeNull();
        if (at!.diffFromBottom <= 4) return;
    }
    const at = await rowPlacement(p, null);
    expect(at).not.toBeNull();
    expect(at!.diffFromBottom).toBeLessThanOrEqual(4);
}

/**
 * Park `offset` px above the bottom and confirm the view actually stayed there.
 *
 * Repeated gestures, not one big one: an engine clamps a single wheel delta, so a
 * wheel aimed 700px up sometimes lands 500px up. That is the harness lying about the
 * state it created, not the view failing to follow, and it showed up as an
 * intermittent failure. Each step is still a real gesture, which is what the view
 * reads as the reader's intent.
 */
async function parkAbove(p: import('@playwright/test').Page, offset: number) {
    const step = 240;
    for (let moved = 0; moved < offset + step; moved += step) {
        const at = await rowPlacement(p, null);
        if (at && at.diffFromBottom >= offset - 40) return;
        await wheelChat(p, -step);
    }
    const at = await rowPlacement(p, null);
    expect(at).not.toBeNull();
    expect(at!.diffFromBottom).toBeGreaterThanOrEqual(offset - 40);
}
/**
 * The rendered row directly above the row containing `exclude`.
 *
 * The reader has to be above the content that will grow. Anchoring on a row below
 * it would measure the growth itself and read it as the reader having moved.
 */
async function pickRowAbove(p: import('@playwright/test').Page, exclude: string) {
    return p.evaluate((needle) => {
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

/**
 * Count writes the application makes to the chat container's scroll position.
 *
 * The claim these specs make is that the viewport owner never moves a parked reader.
 * Asserting that through pixel positions measures the browser's own scroll anchoring
 * as much as the app's, and anchoring is only approximate. Counting the writes says
 * the ownership claim directly, and the pixel assertions stay as a looser check that
 * the reader is still looking at the same row.
 */
async function resetScrollWrites(p: import('@playwright/test').Page) {
    await p.evaluate(() => {
        const w = window as unknown as { __gbScrollWrites?: number };
        if (w.__gbScrollWrites !== undefined) {
            w.__gbScrollWrites = 0;
            return;
        }
        w.__gbScrollWrites = 0;
        const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
        if (!desc?.set) return;
        Object.defineProperty(Element.prototype, 'scrollTop', {
            get: desc.get,
            set(value: number) {
                if ((this as HTMLElement).matches?.('[data-testid="chat-messages"]')) {
                    w.__gbScrollWrites!++;
                }
                desc.set!.call(this, value);
            },
            configurable: true,
        });
    });
}

async function scrollWrites(p: import('@playwright/test').Page) {
    return p.evaluate(() => (window as unknown as { __gbScrollWrites?: number }).__gbScrollWrites ?? -1);
}

/** Pad the channel until the view is genuinely scrollable. */
async function padChannel(p: import('@playwright/test').Page, count: number, stamp = Date.now()) {
    await sendSequence(
        '#glowing-bear',
        Array.from({ length: count }, (_, i) => `own-pad-${stamp}-${i}`),
    );
    await waitForRowCountAtLeast(p, 40);
    return stamp;
}

test('a reader keeps the row they were reading at the same place in the viewport while content above is trimmed', async () => {
    await switchToBuffer(page, '#glowing-bear');
    await padChannel(page, 160);
    await parkAtBottom(page);

    // Park well above the bottom, then pick the row nearest the top of the window.
    await parkAbove(page, 700);
    const anchorText = await page.evaluate(() => {
        const container = document.querySelector('[data-testid="chat-messages"]') as HTMLElement;
        const box = container.getBoundingClientRect();
        const rows = Array.from(document.querySelectorAll('[data-testid="bufferline-row"]'));
        // The first row that is still on screen is the one the reader is looking at.
        const row = rows.find((r) => r.getBoundingClientRect().bottom > box.top + 4);
        return row?.textContent ?? '';
    });
    expect(anchorText).not.toBe('');

    const parked = await rowPlacement(page, anchorText);
    expect(parked).not.toBeNull();
    expect(parked!.visible).toBe(true);
    expect(parked!.diffFromBottom).toBeGreaterThan(200);

    // New lines arrive below the reader, and the retained-row cap trims rows off
    // the front — the content above the anchor changes on both sides.
    await resetScrollWrites(page);
    await irc.sendMessage('#glowing-bear', `own-after-anchor-${runStamp}`);
    await waitForRow(page, `own-after-anchor-${runStamp}`);
    await waitForChatSettled(page);

    const after = await rowPlacement(page, anchorText);
    expect(after).not.toBeNull();
    // Same row, same place in the window.
    // A couple of pixels is row-height rounding, not movement: the row the reader
    // was looking at is still the row they are looking at.
    // The viewport owner never touched the scroll position while content changed
    // around the reader.
    expect(await scrollWrites(page)).toBe(0);
    expect(after!.visible).toBe(true);
    // Still the same row, still in the window. The slack is the browser's own
    // anchoring, which adjusts scrollTop to keep content on screen and is not exact.
    expect(Math.abs(after!.offsetInViewport - parked!.offsetInViewport)).toBeLessThanOrEqual(24);
    // The row found above is located by its unique message text, so "same row" is
    // identity, not proximity.
    // The reader was not dragged: the newest line is still out of view below them.
    expect(after!.diffFromBottom).toBeGreaterThan(200);
    // The row they were reading is no longer the same row from the top of the DOM,
    // which is what proves the offset was held through a change above it.
    expect(after!.rowIndex).not.toBe(parked!.rowIndex);
});

test('a reader who scrolls away during an active follow pin keeps their position', async () => {
    await switchToBuffer(page, '#glowing-bear');
    await parkAtBottom(page);
    const pinsBefore = (await followState(page))?.pinActivations ?? 0;

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
    expect((await followState(page))?.pinActivations).toBeGreaterThan(pinsBefore);
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
    const state = await followState(page);
    expect(state?.pendingFrames).toBe(0);
    expect(state?.pinning).toBe(false);
    // Nothing to place, so nothing was placed: the view reached idle without starting
    // a single follow pin. Counted from here rather than from zero because the
    // controller outlives the buffer it is placed on.
    const pinsAtIdle = state?.pinActivations ?? 0;
    await waitForChatSettled(page);
    expect((await followState(page))?.pinActivations).toBe(pinsAtIdle);

    // The first new line still has to become visible.
    await irc.sendMessage(channel, `first-line-in-short-${runStamp}`);
    await waitForRow(page, `first-line-in-short-${runStamp}`);
    await waitForChatSettled(page);
    const placed = await rowPlacement(page, `first-line-in-short-${runStamp}`);
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
        await parkAtBottom(page);

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
    await padChannel(page, 60, stamp);
    await parkAtBottom(page);

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
    await parkAbove(page, 250);
    const anchorText = await pickRowAbove(page, `slow-media-${stamp}`);
    expect(anchorText).not.toBe('');
    const parked = await rowPlacement(page, anchorText);
    expect(parked?.visible).toBe(true);
    await expect(mediaRow.locator('[data-testid="show-embed"]')).toBeInViewport();
    const heightBefore = await mediaRow.evaluate((el) => (el as HTMLElement).getBoundingClientRect().height);

    // The picture is revealed: the row grows by hundreds of pixels and nothing
    // about the message list changed.
    await resetScrollWrites(page);
    await mediaRow.locator('[data-testid="show-embed"]').click();
    const img = mediaRow.locator('img.embed');
    await expect(img).toBeVisible({ timeout: 10000 });
    await expect
        .poll(async () => img.evaluate((el) => (el as HTMLImageElement).naturalWidth), { timeout: 10000 })
        .toBeGreaterThan(0);
    const heightAfter = await mediaRow.evaluate((el) => (el as HTMLElement).getBoundingClientRect().height);
    expect(heightAfter - heightBefore).toBeGreaterThan(100);

    await waitForChatSettled(page);

    const after = await rowPlacement(page, anchorText);
    expect(after).not.toBeNull();
    // The reader is still looking at the same row, at the same height in the
    // window. The row that grew below them did not take them with it.
    expect(after!.visible).toBe(true);
    expect(Math.abs(after!.offsetInViewport - parked!.offsetInViewport)).toBeLessThanOrEqual(4);
    // Assert the growth, not an absolute distance from the tail: how far the reader
    // happened to park varies with how the channel was left by earlier specs in this
    // file, and a fixed threshold turns that fixture drift into a failure.
    expect(after!.diffFromBottom - parked!.diffFromBottom).toBeGreaterThan(100);
});

// The rest of this file runs on the API relay, which is what the app connects to by
// default. Owning the viewport is a claim about both transports: the legacy relay
// delivers lines in a different order and with different identity fields, and an
// API-only pass is not evidence that the legacy path still follows.
test('the legacy relay follows the tail and leaves a parked reader alone', async ({ browser }) => {
    const legacy = await createConnectedPage(browser, { settings: { protocol: 'legacy' }, port: '9001' });
    setupEffectOrphanFilter(legacy);
    const stamp = Date.now();

    try {
        await switchToBuffer(legacy, '#glowing-bear');
        await padChannel(legacy, 40, stamp);
        await parkAtBottom(legacy);

        await sendSequence(
            '#glowing-bear',
            Array.from({ length: 12 }, (_, i) => `legacy-follow-${stamp}-${i}`),
        );
        await waitForChatSettled(legacy);
        const newest = await rowPlacement(legacy, `legacy-follow-${stamp}-11`);
        expect(newest?.visible).toBe(true);
        expect(newest!.diffFromBottom).toBeLessThanOrEqual(5);

        // Park with a real gesture, then flood: the reader must stay put on the
        // same row they were looking at.
        await parkAbove(legacy, 500);
        const anchorText = await legacy.evaluate(() => {
            const container = document.querySelector('[data-testid="chat-messages"]') as HTMLElement;
            const box = container.getBoundingClientRect();
            const rows = Array.from(document.querySelectorAll('[data-testid="bufferline-row"]'));
            const row = rows.find((r) => r.getBoundingClientRect().bottom > box.top + 4);
            return row?.textContent ?? '';
        });
        expect(anchorText).not.toBe('');
        const parked = await rowPlacement(legacy, anchorText);
        expect(parked?.visible).toBe(true);

        await sendSequence(
            '#glowing-bear',
            Array.from({ length: 40 }, (_, i) => `legacy-parked-${stamp}-${i}`),
        );
        await waitForChatSettled(legacy);
        const after = await rowPlacement(legacy, anchorText);
        expect(after).not.toBeNull();
        expect(after!.visible).toBe(true);
        expect(Math.abs(after!.offsetInViewport - parked!.offsetInViewport)).toBeLessThanOrEqual(2);
        expect(after!.diffFromBottom).toBeGreaterThan(150);
    } finally {
        await legacy.close();
    }
});
