import { test, expect } from '@playwright/test';
import { createConnectedPage } from '../fixtures/auth';
import { setSettings } from '../helpers/connection';

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

async function swipeGesture(page: import('@playwright/test').Page, startX: number, startY: number, endX: number, endY: number) {
    await page.evaluate(({ sx, sy, ex, ey }) => {
        (window as any).__swipeOnTarget(document, sx, sy, ex, ey);
    }, { sx: startX, sy: startY, ex: endX, ey: endY });
}

let page: import('@playwright/test').Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
    page = await createConnectedPage(browser);
    await page.setViewportSize({ width: 375, height: 667 });
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await injectSwipeDispatcher(page);
    page.on('pageerror', (error) => {
        if (error.message?.includes('effect_orphan')) return;
    });
});

test.afterAll(async () => {
    await page.close();
});

test.beforeEach(async () => {
    page.on('pageerror', (error) => {
        if (error.message?.includes('effect_orphan')) return;
    });
});

// Swipe right to open buffer list should close an open nicklist (overlays are mutually exclusive).
test('swipe right to open buffer list closes nicklist', async () => {
    await setSettings(page, { showNicklist: true, alwaysnicklist: true });
    const width = 375;
    const height = 667;

    // Ensure mobile nicklist overlay is in DOM
    await page.locator('.mobile-nicklist-overlay').waitFor({ state: 'attached', timeout: 5000 });

    // Hide buffer list first so swipe-left-from-right-edge can open nicklist
    await page.evaluate(() => (window as any).__hideBufferListOnMobile?.());

    // Open nicklist via swipe from right edge
    await swipeGesture(page, width - 10, height / 2, 50, height / 2);
    await expect(page.locator('.mobile-nicklist-overlay')).toHaveClass(/translate-x-0/);
    // Buffer list should not be visible
    await expect(page.getByTestId('buffer-list')).not.toBeAttached();

    // Show buffer list via swipe right from left edge — should close nicklist
    await swipeGesture(page, 10, height / 2, width - 50, height / 2);
    await expect(page.getByTestId('buffer-list')).toBeVisible({ timeout: 5000 });

    // Nicklist should have been closed — overlays are mutually exclusive
    await expect(page.locator('.mobile-nicklist-overlay')).toHaveClass(/translate-x-full/);
});

// Swipe left from non-right-edge should close buffer list without opening nicklist.
test('swipe left from chat closes buffer list without opening nicklist', async () => {
    // Reset state
    const overlayClass = await page.locator('.mobile-nicklist-overlay').getAttribute('class');
    if (overlayClass?.includes('translate-x-0')) {
        await page.getByTestId('nicklist-close-button').click();
    }
    await page.evaluate(() => (window as any).__hideBufferListOnMobile?.());

    await setSettings(page, { showNicklist: true, alwaysnicklist: true });
    await page.locator('.mobile-nicklist-overlay').waitFor({ state: 'attached', timeout: 5000 });

    const width = 375;
    const height = 667;

    // Show buffer list via swipe right
    await swipeGesture(page, 10, height / 2, width - 50, height / 2);
    await page.getByTestId('buffer-list').waitFor({ state: 'attached', timeout: 5000 });

    // Nicklist should be hidden
    await expect(page.locator('.mobile-nicklist-overlay')).toHaveClass(/translate-x-full/);

    // Swipe left from CENTER of screen (not right edge) — should only close buffer list
    await swipeGesture(page, width / 2, height / 2, 10, height / 2);

    // Buffer list should be closed
    await expect(page.getByTestId('buffer-list')).not.toBeAttached();
    // Nicklist should still be hidden (swipe from center didn't trigger nicklist)
    await expect(page.locator('.mobile-nicklist-overlay')).toHaveClass(/translate-x-full/);
});

// After closing both overlays, swipes work normally again.
test('swipes work normally after both overlays are closed', async () => {
    // Reset state
    const overlayClass = await page.locator('.mobile-nicklist-overlay').getAttribute('class');
    if (overlayClass?.includes('translate-x-0')) {
        await page.getByTestId('nicklist-close-button').click();
    }
    await page.evaluate(() => (window as any).__hideBufferListOnMobile?.());

    await setSettings(page, { showNicklist: true, alwaysnicklist: true });
    await page.locator('.mobile-nicklist-overlay').waitFor({ state: 'attached', timeout: 5000 });

    const width = 375;
    const height = 667;

    // Show buffer list
    await swipeGesture(page, 10, height / 2, width - 50, height / 2);
    await page.getByTestId('buffer-list').waitFor({ state: 'attached', timeout: 5000 });

    // Close buffer list via swipe left from center
    await swipeGesture(page, width / 2, height / 2, 10, height / 2);
    await expect(page.getByTestId('buffer-list')).not.toBeAttached();

    // Open nicklist via swipe from right edge
    await swipeGesture(page, width - 10, height / 2, 50, height / 2);
    await expect(page.locator('.mobile-nicklist-overlay')).toHaveClass(/translate-x-0/);

    // Close nicklist via its close button
    await page.getByTestId('nicklist-close-button').click();
    await expect(page.locator('.mobile-nicklist-overlay')).toHaveClass(/translate-x-full/);
});
