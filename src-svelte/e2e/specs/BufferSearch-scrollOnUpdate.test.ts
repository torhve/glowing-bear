import { test, expect } from '@playwright/test';
import { createConnectedPage } from '../fixtures/auth';
import { irc } from '../helpers/irc-control';
import { switchToBuffer } from '../helpers/buffers';
import { waitForChatSettled, waitForRowCountAtLeast } from '../helpers/waits';

/**
 * The buffer-search dialog is rendered unconditionally — a popover is hidden,
 * not unmounted — so its result rows are always in the DOM. Its
 * "keep the selection in view" effect used to read the buffer-derived result
 * list unconditionally, which made it re-run on every incoming message batch
 * and call scrollIntoView on a row inside a closed dialog.
 *
 * These tests lock the contract: nothing scrolls while the dialog is closed,
 * and the selected row still scrolls while it is open.
 */

const CHANNEL = '#glowing-bear';

let page: import('@playwright/test').Page;

test.describe.configure({ mode: 'serial' });

/** Installed before any app script runs; only observes, never drives the page. */
const COUNT_SCROLL = `
window.__siv = { calls: 0 };
(function () {
    const orig = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function () {
        window.__siv.calls++;
        return orig.apply(this, arguments);
    };
})();
`;

async function scrollCalls(): Promise<number> {
    return page.evaluate(() => {
        const w = window as unknown as { __siv?: { calls: number } };
        return w.__siv?.calls ?? -1;
    });
}

async function resetScrollCalls(): Promise<void> {
    await page.evaluate(() => {
        const w = window as unknown as { __siv?: { calls: number } };
        if (w.__siv) w.__siv.calls = 0;
    });
}

async function openBufferSearch(): Promise<void> {
    await page.evaluate(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', {
            altKey: true, code: 'KeyG', key: 'g', keyCode: 71, bubbles: true,
        }));
    });
    await expect(page.locator('#buffer-search')).toBeVisible({ timeout: 5000 });
}

async function closeBufferSearch(): Promise<void> {
    await page.locator('[data-testid="buffer-search-close"]').click();
    await expect(page.locator('#buffer-search')).not.toBeVisible({ timeout: 5000 });
}

test.beforeAll(async ({ browser }) => {
    page = await createConnectedPage(browser, { initScript: COUNT_SCROLL });
    await switchToBuffer(page, CHANNEL);
});

test.afterAll(async () => {
    await page.close();
});

test('incoming messages do not scroll while the buffer search dialog is closed', async () => {
    await expect(page.locator('#buffer-search')).not.toBeVisible();

    const rowsBefore = await page.locator('[data-testid="bufferline-row"]').count();
    await resetScrollCalls();

    for (let i = 0; i < 12; i++) {
        await irc.sendMessage(CHANNEL, `siv-closed-${i}`);
    }
    await waitForRowCountAtLeast(page, rowsBefore + 12);
    await waitForChatSettled(page);

    expect(await scrollCalls()).toBe(0);
});

test('the selected buffer-search row still scrolls into view while the dialog is open', async () => {
    await openBufferSearch();
    await page.locator('#buffer-search').fill('');
    await expect(page.locator('[data-search-index]').first()).toBeVisible({ timeout: 5000 });

    await resetScrollCalls();
    for (let i = 0; i < 10; i++) {
        await page.locator('#buffer-search').press('ArrowDown');
    }

    expect(await scrollCalls()).toBeGreaterThan(0);

    await closeBufferSearch();
});
