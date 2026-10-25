import { test, expect } from '@playwright/test';
import { createConnectedPage } from '../fixtures/auth';
import { switchToBufferMobile, waitForBuffer } from '../helpers/buffers';
import { swipeOnElement } from '../helpers/touch';

declare global {
    interface Window {
        __showBufferListOnMobile?: () => void;
    }
}

let page: import('@playwright/test').Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
    page = await createConnectedPage(browser);
    await page.setViewportSize({ width: 375, height: 667 });
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await waitForBuffer(page, '#glowing-bear', 15000);
});

test.afterAll(async () => {
    await page.close();
});

test.beforeEach(async () => {
    await page.evaluate(() => window.__showBufferListOnMobile?.());
});

/** The buffer the chat is showing, as the topic bar names it. */
async function activeBufferName(): Promise<string> {
    const name = await page.locator('.topic-channel-name').textContent();
    // The topic bar keeps a channel's `#`; the sidebar row drops it. Every
    // comparison here is against a sidebar row, so both sides lose the sigil.
    return (name ?? '').trim().replace(/^#/, '');
}

/** The sidebar rows in the order they are drawn, which is the order a swipe walks. */
async function sidebarRows(): Promise<string[]> {
    // Reading the sidebar means opening it: on mobile the buffer list is an overlay, and
    // a hidden overlay renders no rows, so a measurement taken while it is closed sees
    // an empty list and reports "the swipe moved nowhere".
    await page.evaluate(() => window.__showBufferListOnMobile?.());
    const rows = page.getByTestId('buffer-item').locator('.buffer-name');
    return (await rows.allTextContents()).map((text) => text.trim());
}

/**
 * The rows that survive a second read.
 *
 * The serial specs share one gbtest fixture, so a channel another spec is
 * assembling — or has just closed — appears and disappears in the sidebar
 * mid-test. Indexing into a list read once is how this spec used to expect a
 * buffer named `exec.gbtest-deep` that no longer existed by the time it
 * swiped. A buffer that is present twice, a moment apart, is the fixture's
 * own; those are the only rows whose neighbours are safe to assert on.
 */
async function stableRows(): Promise<string[]> {
    let rows: string[] = [];
    await expect
        .poll(
            async () => {
                const now = await sidebarRows();
                const quiet =
                    rows.length === now.length && rows.every((name, i) => name === now[i]);
                rows = now;
                return quiet;
            },
            { timeout: 4000, intervals: [400] },
        )
        .toBe(true);
    return rows;
}

/**
 * How many rows the active buffer sits from `reference`, both read at once.
 *
 * The claim is "the swipe moved exactly one row", so the measurement compares
 * positions rather than expecting a neighbour's name from an earlier read: the
 * fixture's buffer list is shared with the other serial specs, and a channel
 * they close between the two reads used to make this spec expect a buffer that
 * was already gone.
 */
async function offsetFrom(reference: string): Promise<number> {
    const rows = await sidebarRows();
    return rows.indexOf(await activeBufferName()) - rows.indexOf(reference);
}

/** A vertical swipe on the top bar: outside the chat scroll area, so it may switch buffers. */
async function swipeDownTopBar(fromY: number, distance: number): Promise<void> {
    await swipeOnElement(page, '[data-testid="top-bar"]', 180, fromY, 180, fromY + distance);
}

async function swipeUpTopBar(fromY: number, distance: number): Promise<void> {
    await swipeOnElement(page, '[data-testid="top-bar"]', 180, fromY, 180, fromY - distance);
}

/**
 * One row out of a list the spec just measured. `stableRows` is what proves the list is long
 * enough for the index being asked for; the index type has not read that proof, and a row missing
 * at that index means the list no longer matches the arrangement the swipe is asserted against —
 * which is a failure worth naming instead of handing `undefined` to a buffer switch.
 */
function rowAt(rows: string[], index: number, what: string): string {
    const name = rows[index];
    if (name === undefined) {
        throw new Error(`stableRows returned ${rows.length} rows and no row at index ${index} (${what})`);
    }
    return name;
}

test.describe('vertical swipe switches buffers along the sidebar order', () => {
    test('a swipe up moves to the row above, a swipe down back to the row below', async () => {
        const rows = await stableRows();
        expect(rows.length).toBeGreaterThan(2);

        // Second to last, so both neighbours exist in a list that just held still.
        const start = rows.length - 2;
        const startName = rowAt(rows, start, 'the row above the last');
        await switchToBufferMobile(page, startName);
        expect(await activeBufferName()).toBe(startName);

        await swipeUpTopBar(300, 120);
        await expect.poll(() => offsetFrom(startName), { timeout: 5000 }).toBe(-1);

        // Measured from the row the swipe landed on, so this assertion also says
        // "exactly one row", in the direction the finger moved.
        const landed = await activeBufferName();
        await swipeDownTopBar(200, 120);
        await expect.poll(() => offsetFrom(landed), { timeout: 5000 }).toBe(1);
    });

    test('a vertical drag short of the threshold is a scroll, not a buffer switch', async () => {
        const rows = await stableRows();
        await switchToBufferMobile(page, rowAt(rows, rows.length - 2, 'the row above the last'));
        const before = await activeBufferName();

        // Well under the vertical threshold, over the horizontal drag threshold.
        await swipeDownTopBar(300, 40);
        await expect.poll(() => activeBufferName(), { timeout: 1500 }).toBe(before);
    });

    test('the first row has no row above it, so a swipe up there stays put', async () => {
        const rows = await stableRows();
        await switchToBufferMobile(page, rowAt(rows, 0, 'the first row'));
        const first = await activeBufferName();

        await swipeUpTopBar(300, 200);
        await expect.poll(() => activeBufferName(), { timeout: 1500 }).toBe(first);
    });
});
