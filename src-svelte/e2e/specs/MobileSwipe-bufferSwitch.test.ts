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
    return (name ?? '').trim();
}

/** The sidebar rows in the order they are drawn, which is the order a swipe walks. */
async function sidebarRows(): Promise<string[]> {
    const rows = page.getByTestId('buffer-item').locator('.buffer-name');
    return (await rows.allTextContents()).map((text) => text.trim());
}

/** A vertical swipe on the top bar: outside the chat scroll area, so it may switch buffers. */
async function swipeDownTopBar(fromY: number, distance: number): Promise<void> {
    await swipeOnElement(page, '[data-testid="top-bar"]', 180, fromY, 180, fromY + distance);
}

async function swipeUpTopBar(fromY: number, distance: number): Promise<void> {
    await swipeOnElement(page, '[data-testid="top-bar"]', 180, fromY, 180, fromY - distance);
}

test.describe('vertical swipe switches buffers along the sidebar order', () => {
    test('a swipe up moves to the row above, a swipe down back to the row below', async () => {
        const rows = await sidebarRows();
        expect(rows.length).toBeGreaterThan(2);

        // Start somewhere in the middle so both neighbours exist.
        const start = Math.min(2, rows.length - 2);
        await switchToBufferMobile(page, rows[start]);
        expect(await activeBufferName()).toBe(rows[start]);

        await swipeUpTopBar(300, 120);
        await expect
            .poll(async () => activeBufferName(), { timeout: 5000 })
            .toBe(rows[start - 1]);

        await swipeDownTopBar(200, 120);
        await expect
            .poll(async () => activeBufferName(), { timeout: 5000 })
            .toBe(rows[start]);
    });

    test('a vertical drag short of the threshold is a scroll, not a buffer switch', async () => {
        const rows = await sidebarRows();
        const start = Math.min(2, rows.length - 2);
        await switchToBufferMobile(page, rows[start]);
        const before = await activeBufferName();

        // Well under the vertical threshold, over the horizontal drag threshold.
        await swipeDownTopBar(300, 40);
        await expect.poll(async () => activeBufferName(), { timeout: 1500 }).toBe(before);
    });

    test('the first row has no row above it, so a swipe up there stays put', async () => {
        const rows = await sidebarRows();
        await switchToBufferMobile(page, rows[0]);
        const first = await activeBufferName();

        await swipeUpTopBar(300, 200);
        await expect.poll(async () => activeBufferName(), { timeout: 1500 }).toBe(first);
    });
});
