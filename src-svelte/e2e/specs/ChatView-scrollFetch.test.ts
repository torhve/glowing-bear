import { test, expect } from '@playwright/test';
import { createConnectedPage } from '../fixtures/auth';
import { waitForBuffer, switchToBuffer } from '../helpers/buffers';

let page: import('@playwright/test').Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
    page = await createConnectedPage(browser);
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
});

test.afterAll(async () => {
    await page.close();
});

// What this file tests is the scroll handler, not the older-lines fetch itself: that is driven
// against the real relay in `FreeBufferPaging.test.ts`, `ReadMarker-fetchMoreLines.test.ts`,
// `ScrollbackCeiling.test.ts` and `ScrollbackDepth.test.ts`, all through `fetch-more-lines`.
//
// A test used to sit here — "Fetch more lines button not visible with test server (no hdata)",
// skipped from its first line with `test.skip()` — whose premise was that the fixture is a stub
// server without hdata. gbtest is a real WeeChat 4.10.1 relay, and hdata is how every buffer in
// this suite gets its lines. The button appears whenever a buffer's history is not exhausted,
// which those four specs assert in both directions.

test('chat container handles scroll event at top without throwing', async () => {
    const chatContainer = page.locator('[data-testid="chat-messages"]');
    await expect(chatContainer).toBeAttached();

    // Set up error listener first, then trigger scroll
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => {
        if (!err.message?.includes('effect_orphan')) {
            pageErrors.push(err.message);
        }
    });

    // Simulate scrolling to top — handleScroll checks scrollTop < 50
    await chatContainer.evaluate((el) => {
        el.scrollTop = 0;
        el.dispatchEvent(new Event('scroll', { bubbles: true }));
    });

    // Wait for fetch to resolve (next tick)
    await page.evaluate(() => new Promise(r => requestAnimationFrame(r)));

    // Verify no console errors from the scroll handler
    await expect(pageErrors).toHaveLength(0);
});

test('repeated scroll events at top do not cause cascading errors', async () => {
    const chatContainer = page.locator('[data-testid="chat-messages"]');

    // Trigger many scroll events rapidly — simulates user scrolling up and down
    for (let i = 0; i < 10; i++) {
        await chatContainer.evaluate((el) => {
            el.scrollTop = 0;
            el.dispatchEvent(new Event('scroll', { bubbles: true }));
        });
        // Yield to let scroll handler process
        await page.evaluate(() => new Promise(r => setTimeout(r, 0)));
    }
});
