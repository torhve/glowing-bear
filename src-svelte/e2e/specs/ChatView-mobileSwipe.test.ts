import { test, expect } from '@playwright/test';
import { connectToWeechat, clearSettings, disconnect, setSettings, waitForAppReady, sendWeechatCommand } from '../helpers/connection';
import { irc } from '../helpers/irc-control';
import { switchToBuffer, waitForBuffer } from '../helpers/buffers';

// Simulate a swipe gesture by dispatching touch events on a specific DOM element.
// This ensures e.target is set correctly, matching real browser behavior where
// touch events bubble from the target element rather than originating on document.
async function swipeOnElement(
    page: import('@playwright/test').Page,
    selector: string,
    startX: number,
    startY: number,
    endX: number,
    endY: number,
) {
    // touchstart dispatched on the target element
    await page.evaluate(({ sel, sx, sy }) => {
        const target = document.querySelector(sel);
        if (!target) return;
        const makeTouch = (x: number, y: number) =>
            ({ identifier: Date.now() + x, clientX: x, clientY: y } as unknown as Touch);
        const ts = new TouchEvent('touchstart', {
            bubbles: true,
            cancelable: false,
            composed: true,
            touches: [makeTouch(sx, sy)],
        });
        (target as HTMLElement).dispatchEvent(ts);
    }, { sel: selector, sx: startX, sy: startY });

    await page.waitForTimeout(50);

    // touchmove with intermediate steps
    const steps = 10;
    for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const mx = startX + (endX - startX) * t;
        const my = startY + (endY - startY) * t;
        await page.evaluate(({ sel, x, y }) => {
            const target = document.querySelector(sel);
            if (!target) return;
            const makeTouch = (px: number, py: number) =>
                ({ identifier: 42, clientX: px, clientY: py } as unknown as Touch);
            const te = new TouchEvent('touchmove', {
                bubbles: true,
                cancelable: false,
                composed: true,
                touches: [makeTouch(x, y)],
            });
            (target as HTMLElement).dispatchEvent(te);
        }, { sel: selector, x: mx, y: my });
        await page.waitForTimeout(5);
    }

    // touchend dispatched on the target element
    await page.evaluate(({ sel, ex, ey }) => {
        const target = document.querySelector(sel);
        if (!target) return;
        const makeTouch = (x: number, y: number) =>
            ({ identifier: 42, clientX: x, clientY: y } as unknown as Touch);
        const te = new TouchEvent('touchend', {
            bubbles: true,
            cancelable: false,
            composed: true,
            changedTouches: [makeTouch(ex, ey)],
            touches: [],
        });
        (target as HTMLElement).dispatchEvent(te);
    }, { sel: selector, ex: endX, ey: endY });
}

// Simulate a swipe gesture dispatched directly on document (for non-element-targeted tests).
async function swipeOnDocument(
    page: import('@playwright/test').Page,
    startX: number,
    startY: number,
    endX: number,
    endY: number,
) {
    await page.evaluate(({ sx, sy }) => {
        const makeTouch = (x: number, y: number) =>
            ({ identifier: Date.now() + x, clientX: x, clientY: y } as unknown as Touch);
        const ts = new TouchEvent('touchstart', {
            bubbles: true,
            cancelable: false,
            composed: true,
            touches: [makeTouch(sx, sy)],
        });
        document.dispatchEvent(ts);
    }, { sx: startX, sy: startY });

    await page.waitForTimeout(50);

    const steps = 10;
    for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const mx = startX + (endX - startX) * t;
        const my = startY + (endY - startY) * t;
        await page.evaluate(({ x, y }) => {
            const makeTouch = (px: number, py: number) =>
                ({ identifier: 42, clientX: px, clientY: py } as unknown as Touch);
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

    await page.evaluate(({ ex, ey }) => {
        const makeTouch = (x: number, y: number) =>
            ({ identifier: 42, clientX: x, clientY: y } as unknown as Touch);
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

let page: import('@playwright/test').Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await page.goto('http://localhost:8001/');
    await waitForAppReady(page);
    await clearSettings(page);
    page.on('pageerror', (error) => {
        if (error.message?.includes('effect_orphan')) return;
    });
});

test.afterAll(async () => {
    await page.close();
});

test.beforeEach(async () => {
    page.on('pageerror', (error) => {
        if (error.message?.includes('effect_orphan') || error.message?.includes('Effect orphaned')) return;
    });
});

// Get the current active buffer's short name from the topic bar
async function getCurrentBufferName(p: import('@playwright/test').Page): Promise<string> {
    // The topic bar shows: <icon> <shortName> - <topic text>
    const topicBarText = await page.getByTestId('topic-bar').textContent();
    if (!topicBarText) return '';
    const parts = topicBarText.trim().split('-');
    return (parts[0] || '').trim();
}

test('vertical swipe on chat area does not switch buffers', async () => {
    await setSettings(page, { showNicklist: false });
    await page.setViewportSize({ width: 375, height: 667 });
    await connectToWeechat(page);

    // Join a test channel to have multiple buffers for switching context
    await sendWeechatCommand(page, '/join #swipe-test-channel');
    await waitForBuffer(page, 'swipe-test-channel', 10000);
    await switchToBuffer(page, 'swipe-test-channel');
    await page.waitForTimeout(500);

    const beforeBuffer = await getCurrentBufferName(page);
    expect(beforeBuffer).toBe('swipe-test-channel');

    const width = 375;
    const height = 667;

    // Vertical swipe inside chat-messages area (scrolling up then down)
    // startY is near middle of viewport, endY scrolls significantly downward
    await swipeOnElement(
        page,
        '[data-testid="chat-messages"]',
        width / 2,
        height * 0.3,
        width / 2,
        height * 0.8,
    );
    await page.waitForTimeout(300);

    // Buffer should NOT have changed
    const afterBuffer = await getCurrentBufferName(page);
    expect(afterBuffer).toBe(beforeBuffer);
});

test('horizontal swipe right from left edge shows buffer list on mobile', async () => {
    await disconnect(page);
    await page.setViewportSize({ width: 375, height: 667 });
    await connectToWeechat(page);

    // Buffer list should not be visible on mobile by default
    await expect(page.getByTestId('buffer-list')).not.toBeVisible({ timeout: 5000 });

    const width = 375;
    const height = 667;

    // Swipe right from left edge on document-level (not element-targeted)
    await swipeOnDocument(page, 10, height / 2, width - 50, height / 2);
    await page.waitForTimeout(300);

    // Buffer list should now be visible
    await expect(page.getByTestId('buffer-list')).toBeVisible({ timeout: 5000 });
});

test('horizontal swipe left from right edge opens nicklist on mobile', async () => {
    await setSettings(page, { showNicklist: false });
    await page.setViewportSize({ width: 375, height: 667 });

    // Ensure buffer list is shown so we start from a clean state
    await swipeOnDocument(page, 10, 334, 325, 334);
    await page.waitForTimeout(300);

    const width = 375;
    const height = 667;

    // Nicklist should not be visible
    await expect(page.getByTestId('nicklist')).not.toBeVisible({ timeout: 5000 });

    // Swipe left from right edge
    await swipeOnDocument(page, width - 10, height / 2, 50, height / 2);
    await page.waitForTimeout(300);

    // Nicklist should now be visible
    await expect(page.getByTestId('nicklist')).toBeVisible({ timeout: 5000 });
});

test('vertical swipe outside chat area switches buffers', async () => {
    await disconnect(page);
    await setSettings(page, { showNicklist: false });
    await page.setViewportSize({ width: 375, height: 667 });
    await connectToWeechat(page);

    // Join test channels to have multiple buffers
    await sendWeechatCommand(page, '/join #swipe-vert-1');
    await waitForBuffer(page, 'swipe-vert-1', 10000);
    await sendWeechatCommand(page, '/join #swipe-vert-2');
    await waitForBuffer(page, 'swipe-vert-2', 10000);

    // Switch to the middle buffer (#swipe-vert-1)
    await switchToBuffer(page, 'swipe-vert-1');
    await page.waitForTimeout(500);

    const beforeBuffer = await getCurrentBufferName(page);
    expect(beforeBuffer).toBe('swipe-vert-1');

    const width = 375;
    const height = 667;

    // Vertical swipe on buffer-list area (not chat area) should switch buffers
    await swipeOnElement(
        page,
        '[data-testid="buffer-list"]',
        width * 0.15,
        height * 0.3,
        width * 0.15,
        height * 0.8,
    );
    await page.waitForTimeout(500);

    // Buffer should have changed
    const afterBuffer = await getCurrentBufferName(page);
    expect(afterBuffer).not.toBe(beforeBuffer);
});
