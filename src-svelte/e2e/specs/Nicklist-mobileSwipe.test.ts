import { test, expect } from '@playwright/test';
import { connectToWeechat, clearSettings, disconnect, setSettings, waitForAppReady } from '../helpers/connection';
import { waitForBuffer, switchToBuffer } from '../helpers/buffers';

// Inject touch event dispatcher into the page for swipe simulation.
async function injectSwipeDispatcher(page: import('@playwright/test').Page) {
    await page.evaluate(() => {
        (window as any).__swipeOnTarget = (target: Element, sx: number, sy: number, ex: number, ey: number, steps = 10) => {
            const makeTouch = (x: number, y: number, id: number) => new Touch({ identifier: id, clientX: x, clientY: y, radiusX: 1, radiusY: 1, force: 0.5, target });
            // touchstart
            target.dispatchEvent(new TouchEvent('touchstart', {
                bubbles: true, cancelable: false, composed: true,
                touches: [makeTouch(sx, sy, 1)],
            }));
            // touchmove with intermediate steps
            for (let i = 1; i <= steps; i++) {
                const t = i / steps;
                const mx = sx + (ex - sx) * t;
                const my = sy + (ey - sy) * t;
                target.dispatchEvent(new TouchEvent('touchmove', {
                    bubbles: true, cancelable: false, composed: true,
                    touches: [makeTouch(mx, my, 2)],
                }));
            }
            // touchend
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
    await page.waitForTimeout(100);
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

test('nicklist is visible on desktop', async () => {
    await setSettings(browserPage, { showNicklist: true });
    await connectToWeechat(browserPage);
    // Switch to #glowing-bear which has nick data (required for nicklist to render)
    await waitForBuffer(browserPage, '#glowing-bear', 10000);
    await switchToBuffer(browserPage, '#glowing-bear');
    await expect(browserPage.getByTestId('nicklist')).toBeVisible({ timeout: 10000 });
});

test('swipe from right edge opens nicklist on mobile', async () => {
    await disconnect(browserPage);
    await setSettings(browserPage, { showNicklist: false, alwaysnicklist: true });
    await browserPage.setViewportSize({ width: 375, height: 667 });
    await connectToWeechat(browserPage);
    await waitForBuffer(browserPage, '#glowing-bear', 10000);
    await switchToBuffer(browserPage, '#glowing-bear');

    // Nicklist overlay should be hidden initially (nicklistOpenOnMobile = false)
    await expect(browserPage.locator('.mobile-nicklist-overlay')).toHaveClass(/translate-x-full/);

    const width = 375;
    const height = 667;
    const startX = width - 10; // near right edge
    const startY = height / 2;
    const endX = 50;
    const endY = height / 2;

    // Perform swipe left from right edge to open nicklist
    await swipeGesture(browserPage, startX, startY, endX, endY);

    // Check nicklist overlay is now open
    await expect(browserPage.locator('.mobile-nicklist-overlay')).toHaveClass(/translate-x-0/);
});

test('swipe right closes nicklist on mobile', async () => {
    // Close any open overlay from previous test before disconnecting
    const overlayClass = await browserPage.locator('.mobile-nicklist-overlay').getAttribute('class');
    if (overlayClass?.includes('translate-x-0')) {
        await swipeGesture(browserPage, 50, 333, 365, 333);
    }
    await disconnect(browserPage);
    await setSettings(browserPage, { showNicklist: true });
    await browserPage.setViewportSize({ width: 375, height: 667 });
    await connectToWeechat(browserPage);
    await waitForBuffer(browserPage, '#glowing-bear', 10000);
    await switchToBuffer(browserPage, '#glowing-bear');

    // Open nicklist first via swipe
    const width = 375;
    const height = 667;
    const startX = width - 10;
    const startY = height / 2;
    const endX = 50;
    const endY = height / 2;

    await swipeGesture(browserPage, startX, startY, endX, endY);

    // Verify nicklist is open (translate-x-0 means visible)
    await expect(browserPage.locator('.mobile-nicklist-overlay')).toHaveClass(/translate-x-0/);

    // Swipe right to close
    const closeStartX = 50;
    const closeStartY = height / 2;
    const closeEndX = width - 10;
    const closeEndY = height / 2;

    await swipeGesture(browserPage, closeStartX, closeStartY, closeEndX, closeEndY);

    // Nicklist should be closed (translate-x-full means hidden)
    await expect(browserPage.locator('.mobile-nicklist-overlay')).toHaveClass(/translate-x-full/);
});

test('close button in nicklist header works on mobile', async () => {
    // Close any open overlay from previous test before disconnecting
    const overlayClass = await browserPage.locator('.mobile-nicklist-overlay').getAttribute('class');
    if (overlayClass?.includes('translate-x-0')) {
        await swipeGesture(browserPage, 50, 333, 365, 333);
    }
    await disconnect(browserPage);
    await setSettings(browserPage, { showNicklist: true });
    await browserPage.setViewportSize({ width: 375, height: 667 });
    await connectToWeechat(browserPage);
    await waitForBuffer(browserPage, '#glowing-bear', 10000);
    await switchToBuffer(browserPage, '#glowing-bear');

    // Open nicklist via swipe
    const width = 375;
    const height = 667;
    const startX = width - 10;
    const startY = height / 2;
    const endX = 50;
    const endY = height / 2;

    await swipeGesture(browserPage, startX, startY, endX, endY);

    // Verify nicklist is open
    await expect(browserPage.locator('.mobile-nicklist-overlay')).toHaveClass(/translate-x-0/);

    // Click the close button inside the nicklist header
    await browserPage.getByTestId('mobile-nicklist-close').click();

    // Nicklist should be closed
    await expect(browserPage.locator('.mobile-nicklist-overlay')).toHaveClass(/translate-x-full/);
});

test('swipe right from left shows buffer list on mobile', async () => {
    // Close any open overlay from previous test before disconnecting
    const overlayClass = await browserPage.locator('.mobile-nicklist-overlay').getAttribute('class');
    if (overlayClass?.includes('translate-x-0')) {
        await swipeGesture(browserPage, 50, 333, 365, 333);
    }
    await disconnect(browserPage);
    await browserPage.setViewportSize({ width: 375, height: 667 });
    await connectToWeechat(browserPage);

    // Buffer list should not be visible on mobile by default
    await expect(browserPage.getByTestId('buffer-list')).not.toBeVisible({ timeout: 5000 });

    const width = 375;
    const height = 667;
    const startX = 10;
    const startY = height / 2;
    const endX = width - 50;
    const endY = height / 2;

    // Perform swipe right from left edge
    await swipeGesture(browserPage, startX, startY, endX, endY);

    // Buffer list should now be visible
    await expect(browserPage.getByTestId('buffer-list')).toBeVisible({ timeout: 5000 });
});
