import { test, expect } from '@playwright/test';
import { createConnectedPage } from '../fixtures/auth';

// The Angular app opened the mobile buffer list by tapping the brand
// (src-angular/index.html `ng-click="toggleSidebar()"`). The Svelte top bar must
// keep that affordance: the logo is a toggle button on mobile and plain
// decoration on desktop, where the buffer list is never hidden.
//
// UI-only: it toggles chrome visibility only — it sends no channel messages and
// asserts no channel-derived content, so it is safe in the parallel pass.

const MOBILE = { width: 375, height: 667 };
const DESKTOP = { width: 1280, height: 720 };

test.describe.configure({ mode: 'serial' });

// A context whose viewport is already mobile: the app decides its initial
// buffer-list state from the viewport at mount time, so resizing *after* load
// would take the desktop→mobile path and open the list for the wrong reason.
async function openAtViewport(browser: import('@playwright/test').Browser, viewport: { width: number; height: number }) {
    const ctx = await browser.newContext({ viewport });
    return createConnectedPage(ctx);
}

test('mobile: the logo is a buffer-list toggle', async ({ browser }) => {
    const page = await openAtViewport(browser, MOBILE);

    // Hidden by default on mobile: the only affordance is the logo button.
    await expect(page.getByTestId('buffer-list')).toHaveCount(0);
    const toggle = page.getByTestId('buffer-list-toggle');
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await toggle.click();
    await expect(page.getByTestId('buffer-list')).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');

    // Same control closes it again — one button, two directions.
    await toggle.click();
    await expect(page.getByTestId('buffer-list')).toHaveCount(0);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await page.close();
});

test('mobile: opening the list swaps the hotlist strip for the title', async ({ browser }) => {
    const page = await openAtViewport(browser, MOBILE);

    // With the list closed the top bar carries the hotlist strip; with it open
    // the strip has nothing to live next to and the title takes its place.
    // Counted, not visibility-checked: with no unread buffers the strip renders an
    // empty box, which Playwright reports as hidden.
    await expect(page.getByTestId('buffer-hotlist')).toHaveCount(1);
    await expect(page.getByTestId('app-title')).toHaveCount(0);

    await page.getByTestId('buffer-list-toggle').click();
    await expect(page.getByTestId('buffer-list')).toBeVisible();
    await expect(page.getByTestId('app-title')).toBeVisible();
    await expect(page.getByTestId('buffer-hotlist')).toHaveCount(0);

    await page.close();
});

test('desktop: the logo stays decoration and the list is always open', async ({ browser }) => {
    const page = await openAtViewport(browser, DESKTOP);

    await expect(page.getByTestId('buffer-list')).toBeVisible();
    // No toggle control on desktop: there is no hidden list to reveal.
    await expect(page.getByTestId('buffer-list-toggle')).toHaveCount(0);

    await page.close();
});
