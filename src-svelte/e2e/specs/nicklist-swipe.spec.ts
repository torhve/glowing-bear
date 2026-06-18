import { test, expect } from '@playwright/test';
import { connectToWeechat, clearSettings, setSettings, waitForAppReady } from '../helpers/connection';

// Helper to simulate a swipe gesture via touch events
async function swipeGesture(page: import('@playwright/test').Page, startX: number, startY: number, endX: number, endY: number) {
    await page.evaluate(({ sx, sy, ex, ey }) => {
        // Create a simple touch point object (cast as any since Touch constructor is protected in browsers)
        const makeTouch = (x: number, y: number) => ({ identifier: Date.now() + x, clientX: x, clientY: y } as unknown as Touch);

        // touchstart
        const ts = new TouchEvent('touchstart', {
            bubbles: true,
            cancelable: false,
            composed: true,
            touches: [makeTouch(sx, sy)],
        });
        document.dispatchEvent(ts);
    }, { sx: startX, sy: startY, ex: endX, ey: endY });

    await page.waitForTimeout(50);

    // touchmove (multiple steps for realistic swipe)
    const steps = 10;
    for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const mx = startX + (endX - startX) * t;
        const my = startY + (endY - startY) * t;
        await page.evaluate(({ x, y }: { x: number; y: number }) => {
            const makeTouch = (px: number, py: number) => ({ identifier: 42, clientX: px, clientY: py } as unknown as Touch);
            const te = new TouchEvent('touchmove', {
                bubbles: true,
                cancelable: false,
                composed: true,
                touches: [makeTouch(x, y)],
            });
            document.dispatchEvent(te);
        }, { x: mx, y: my });
        await page.waitForTimeout(5);
    }

    // touchend
    await page.evaluate(({ ex, ey }: { ex: number; ey: number }) => {
        const makeTouch = (x: number, y: number) => ({ identifier: 42, clientX: x, clientY: y } as unknown as Touch);
        const te = new TouchEvent('touchend', {
            bubbles: true,
            cancelable: false,
            composed: true,
            changedTouches: [makeTouch(ex, ey)],
            touches: [],
        });
        document.dispatchEvent(te);
    }, { ex: endX, ey: endY });
}

let browserPage: import('@playwright/test').Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
    browserPage = await browser.newPage();
    await browserPage.goto('http://localhost:8001/');
    await waitForAppReady(browserPage);
    await clearSettings(browserPage);
    await setSettings(browserPage, {
        savepassword: false,
        autoconnect: false,
        showNicklist: true,
    });
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
    await expect(browserPage.getByTestId('nicklist')).toBeVisible({ timeout: 10000 });
});

test('swipe from right edge opens nicklist on mobile', async () => {
    await browserPage.setViewportSize({ width: 375, height: 667 });
    await connectToWeechat(browserPage);

    // Nicklist should not be visible on mobile by default
    await expect(browserPage.getByTestId('nicklist')).not.toBeVisible({ timeout: 5000 });

    const width = 375;
    const height = 667;
    const startX = width - 10; // near right edge
    const startY = height / 2;
    const endX = 50;
    const endY = height / 2;

    // Perform swipe left from right edge
    await swipeGesture(browserPage, startX, startY, endX, endY);
    await browserPage.waitForTimeout(300);

    // Nicklist should now be visible
    await expect(browserPage.getByTestId('nicklist')).toBeVisible({ timeout: 5000 });
});

test('swipe right closes nicklist on mobile', async () => {
    await browserPage.setViewportSize({ width: 375, height: 667 });
    await connectToWeechat(browserPage);

    // Open nicklist first
    const width = 375;
    const height = 667;
    const startX = width - 10;
    const startY = height / 2;
    const endX = 50;
    const endY = height / 2;

    await swipeGesture(browserPage, startX, startY, endX, endY);
    await browserPage.waitForTimeout(300);

    await expect(browserPage.getByTestId('nicklist')).toBeVisible({ timeout: 5000 });

    // Swipe right to close
    const closeStartX = 50;
    const closeStartY = height / 2;
    const closeEndX = width - 10;
    const closeEndY = height / 2;

    await swipeGesture(browserPage, closeStartX, closeStartY, closeEndX, closeEndY);
    await browserPage.waitForTimeout(300);

    // Nicklist should be closed
    await expect(browserPage.getByTestId('nicklist')).not.toBeVisible({ timeout: 5000 });
});

test('close button in nicklist header works on mobile', async () => {
    await browserPage.setViewportSize({ width: 375, height: 667 });
    await connectToWeechat(browserPage);

    // Open nicklist
    const width = 375;
    const height = 667;
    const startX = width - 10;
    const startY = height / 2;
    const endX = 50;
    const endY = height / 2;

    await swipeGesture(browserPage, startX, startY, endX, endY);
    await browserPage.waitForTimeout(300);

    await expect(browserPage.getByTestId('nicklist')).toBeVisible({ timeout: 5000 });

    // Click the close button inside the nicklist header
    await browserPage.getByTestId('mobile-nicklist-close').click();
    await browserPage.waitForTimeout(300);

    // Nicklist should be closed
    await expect(browserPage.getByTestId('nicklist')).not.toBeVisible({ timeout: 5000 });
});

test('swipe right from left shows buffer list on mobile', async () => {
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
    await browserPage.waitForTimeout(300);

    // Buffer list should now be visible
    await expect(browserPage.getByTestId('buffer-list')).toBeVisible({ timeout: 5000 });
});
