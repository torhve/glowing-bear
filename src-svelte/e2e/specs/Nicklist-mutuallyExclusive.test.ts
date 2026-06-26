import { test, expect } from '@playwright/test';
import { connectToWeechat, clearSettings, disconnect, reconnect, setSettings, waitForAppReady } from '../helpers/connection';
import { waitForBuffer, switchToBuffer, waitForBufferMobile } from '../helpers/buffers';

// Inject touch event dispatcher into the page for swipe simulation.
async function injectSwipeDispatcher(page: import('@playwright/test').Page) {
    await page.evaluate(() => {
        (window as any).__swipeOnTarget = (target: Element, sx: number, sy: number, ex: number, ey: number, steps = 10) => {
            const makeTouch = (x: number, y: number, id: number) => new Touch({ identifier: id, clientX: x, clientY: y, radiusX: 1, radiusY: 1, force: 0.5, target });
            target.dispatchEvent(new TouchEvent('touchstart', {
                bubbles: true, cancelable: false, composed: true,
                touches: [makeTouch(sx, sy, 1)],
            }));
            for (let i = 1; i <= steps; i++) {
                const t = i / steps;
                const mx = sx + (ex - sx) * t;
                const my = sy + (ey - sy) * t;
                target.dispatchEvent(new TouchEvent('touchmove', {
                    bubbles: true, cancelable: false, composed: true,
                    touches: [makeTouch(mx, my, 2)],
                }));
            }
            target.dispatchEvent(new TouchEvent('touchend', {
                bubbles: true, cancelable: false, composed: true,
                changedTouches: [makeTouch(ex, ey, 3)],
                touches: [],
            }));
        };
    });
}

// Helper to simulate a swipe gesture via touch events on document
async function swipeGesture(page: import('@playwright/test').Page, startX: number, startY: number, endX: number, endY: number) {
    await page.evaluate(({ sx, sy, ex, ey }) => {
        (window as any).__swipeOnTarget(document, sx, sy, ex, ey);
    }, { sx: startX, sy: startY, ex: endX, ey: endY });
}

let browserPage: import('@playwright/test').Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
    browserPage = await browser.newPage();
    await browserPage.route('**/cdnjs.cloudflare.com/**', (route) => route.abort());
    await browserPage.goto('http://localhost:8001/');
    await waitForAppReady(browserPage);
    await clearSettings(browserPage);
    await setSettings(browserPage, {
        savepassword: false,
        autoconnect: false,
        showNicklist: true,
        alwaysnicklist: true,
    });
    await injectSwipeDispatcher(browserPage);
    browserPage.on('pageerror', (error) => {
        if (error.message?.includes('effect_orphan')) return;
    });
});

test.afterAll(async () => {
    await browserPage.close();
});

test.beforeEach(async () => {
    browserPage.on('pageerror', (error) => {
        if (error.message?.includes('effect_orphan')) return;
    });
});

// Swiping to open buffer list should close nicklist overlay — overlays must be mutually exclusive.
test('swipe right to open buffer list closes nicklist', async () => {
    await connectToWeechat(browserPage);
    await browserPage.setViewportSize({ width: 375, height: 667 });
    await browserPage.evaluate(() => window.dispatchEvent(new Event('resize')));
    await waitForBufferMobile(browserPage, '#glowing-bear', 10000);
    await switchToBuffer(browserPage, '#glowing-bear');
    // Restore mobile viewport after desktop-based buffer switch
    await browserPage.setViewportSize({ width: 375, height: 667 });
    await browserPage.evaluate(() => window.dispatchEvent(new Event('resize')));

    const width = 375;
    const height = 667;

    // Ensure mobile nicklist overlay is in DOM
    await browserPage.locator('.mobile-nicklist-overlay').waitFor({ state: 'attached', timeout: 5000 });

    // Step 1: Open nicklist via swipe from right edge
    await swipeGesture(browserPage, width - 10, height / 2, 50, height / 2);
    await expect(browserPage.locator('.mobile-nicklist-overlay')).toHaveClass(/translate-x-0/);
    // Buffer list should not be visible
    await expect(browserPage.getByTestId('buffer-list')).not.toBeAttached();

    // Step 2: Swipe right from left edge to open buffer list
    await swipeGesture(browserPage, 10, height / 2, width - 50, height / 2);
    // Buffer list should now be visible
    await expect(browserPage.getByTestId('buffer-list')).toBeVisible({ timeout: 5000 });
    // Nicklist should have been closed — overlays are mutually exclusive
    await expect(browserPage.locator('.mobile-nicklist-overlay')).toHaveClass(/translate-x-full/);
});

// Swiping to open nicklist should close buffer list — overlays must be mutually exclusive.
test('swipe left to open nicklist closes buffer list', async () => {
    // Close any open overlays before reconnecting
    const overlayClass = await browserPage.locator('.mobile-nicklist-overlay').getAttribute('class');
    if (overlayClass?.includes('translate-x-0')) {
        await browserPage.getByTestId('nicklist-close-button').click();
    }
    await reconnect(browserPage, { extraSettings: { showNicklist: true, alwaysnicklist: true } });
    await browserPage.setViewportSize({ width: 375, height: 667 });
    await browserPage.evaluate(() => window.dispatchEvent(new Event('resize')));
    await waitForBufferMobile(browserPage, '#glowing-bear', 10000);
    await switchToBuffer(browserPage, '#glowing-bear');
    // Restore mobile viewport after desktop-based buffer switch
    await browserPage.setViewportSize({ width: 375, height: 667 });
    await browserPage.evaluate(() => window.dispatchEvent(new Event('resize')));

    const width = 375;
    const height = 667;

    // Ensure mobile nicklist overlay is in DOM
    await browserPage.locator('.mobile-nicklist-overlay').waitFor({ state: 'attached', timeout: 5000 });

    // Step 1: Open buffer list via swipe right from left edge
    await swipeGesture(browserPage, 10, height / 2, width - 50, height / 2);
    await expect(browserPage.getByTestId('buffer-list')).toBeVisible({ timeout: 5000 });
    // Nicklist should be hidden
    await expect(browserPage.locator('.mobile-nicklist-overlay')).toHaveClass(/translate-x-full/);

    // Step 2: Swipe left from right edge to open nicklist
    await swipeGesture(browserPage, width - 10, height / 2, 50, height / 2);
    // Nicklist should now be visible
    await expect(browserPage.locator('.mobile-nicklist-overlay')).toHaveClass(/translate-x-0/);
    // Buffer list should have been closed — overlays are mutually exclusive
    await expect(browserPage.getByTestId('buffer-list')).not.toBeAttached();
});

// Full cycle: bufferlist -> nicklist -> bufferlist, verifying mutual exclusivity at each step.
test('alternating swipes toggle between buffer list and nicklist', async () => {
    // Close any open overlays before disconnecting
    const overlayClass = await browserPage.locator('.mobile-nicklist-overlay').getAttribute('class');
    if (overlayClass?.includes('translate-x-0')) {
        await browserPage.getByTestId('nicklist-close-button').click();
    }
    await disconnect(browserPage);
    await clearSettings(browserPage);
    await setSettings(browserPage, { savepassword: false, autoconnect: false, showNicklist: true, alwaysnicklist: true });
    await connectToWeechat(browserPage);
    await browserPage.setViewportSize({ width: 375, height: 667 });
    await browserPage.evaluate(() => window.dispatchEvent(new Event('resize')));
    await waitForBufferMobile(browserPage, '#glowing-bear', 10000);
    await switchToBuffer(browserPage, '#glowing-bear');
    // Restore mobile viewport after desktop-based buffer switch
    await browserPage.setViewportSize({ width: 375, height: 667 });
    await browserPage.evaluate(() => window.dispatchEvent(new Event('resize')));

    const width = 375;
    const height = 667;

    // Ensure mobile nicklist overlay is in DOM
    await browserPage.locator('.mobile-nicklist-overlay').waitFor({ state: 'attached', timeout: 5000 });

    // Step 1: Open buffer list (swipe right from left)
    await swipeGesture(browserPage, 10, height / 2, width - 50, height / 2);
    await expect(browserPage.getByTestId('buffer-list')).toBeVisible();
    await expect(browserPage.locator('.mobile-nicklist-overlay')).toHaveClass(/translate-x-full/);

    // Step 2: Open nicklist (swipe left from right) — should close buffer list
    await swipeGesture(browserPage, width - 10, height / 2, 50, height / 2);
    await expect(browserPage.locator('.mobile-nicklist-overlay')).toHaveClass(/translate-x-0/);
    await expect(browserPage.getByTestId('buffer-list')).not.toBeAttached();

    // Step 3: Open buffer list again (swipe right from left) — should close nicklist
    await swipeGesture(browserPage, 10, height / 2, width - 50, height / 2);
    await expect(browserPage.getByTestId('buffer-list')).toBeVisible();
    await expect(browserPage.locator('.mobile-nicklist-overlay')).toHaveClass(/translate-x-full/);
});
