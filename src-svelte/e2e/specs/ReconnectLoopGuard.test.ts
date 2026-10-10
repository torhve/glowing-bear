import { test, expect } from '@playwright/test';
import { setSettings, reconnect } from '../helpers/connection';
import { createConnectedPage } from '../fixtures/auth';
import { setupEffectOrphanFilter } from '../helpers/pageerror';

test.describe.configure({ mode: 'serial' });

/** Read the banner's countdown as a number of seconds. */
async function countdownSeconds(page: import('@playwright/test').Page): Promise<number> {
    const text = await page.getByTestId('connection-banner-countdown').textContent();
    return parseInt(text?.match(/in (\d+)s/)?.[1] ?? '0', 10);
}

// The countdown used to live in a sticky toast. The connection banner owns that
// presentation now (see ConnectionBanner.test.ts for the shell itself), so these
// specs read the banner: same intent — the user is told a retry is scheduled, can
// see when, and can cut the countdown short — through the element that replaced it.
test.describe('Auto reconnect with countdown banner', () => {
    let page: import('@playwright/test').Page;

    test.beforeEach(async ({ browser }) => {
        page = await createConnectedPage(browser);
        setupEffectOrphanFilter(page);
    });

    test('disconnect shows the countdown banner when autoconnect is enabled', async () => {
        await expect(page.getByTestId('chat-view')).toBeVisible();

        // Enable autoconnect so the loss schedules a retry
        await setSettings(page, { autoconnect: true });

        // Simulate unexpected WebSocket close
        await page.evaluate(() => {
            const ws = (window as any).__getSession?.()?.getSocket?.();
            if (ws) ws.close(3000, 'test disconnect');
        });

        // The banner carries the state, and it carries it once: the toast that
        // used to repeat it would sit on top of the banner's own buttons.
        await expect(page.getByTestId('connection-banner')).toBeVisible({ timeout: 10000 });
        await expect(page.getByTestId('connection-banner-countdown')).toBeVisible({ timeout: 5000 });
        await expect(page.getByTestId('connection-banner-retry')).toBeVisible();
        await expect(page.getByTestId('toast')).not.toBeVisible();

        // The chat is still on screen while the retry is pending.
        await expect(page.getByTestId('chat-view')).toBeVisible();

        // Verify nextReconnectAt is set
        const state = await page.evaluate(() => {
            const store = (window as any).__connectionState;
            return store?.get?.() ?? store;
        });
        expect(state?.nextReconnectAt).toBeGreaterThan(0);
    });

    test('banner Retry now triggers an immediate retry', async () => {
        await expect(page.getByTestId('chat-view')).toBeVisible();
        await setSettings(page, { autoconnect: true });

        // Simulate disconnect to schedule a countdown
        await page.evaluate(() => {
            const ws = (window as any).__getSession?.()?.getSocket?.();
            if (ws) ws.close(3000, 'test disconnect');
        });

        // Wait for the countdown to appear
        await expect(page.getByTestId('connection-banner-countdown')).toBeVisible({ timeout: 10000 });

        // Retry now — should try immediately, not wait for the countdown
        await page.getByTestId('connection-banner-retry').click();

        // Should reconnect successfully
        await expect(page.getByTestId('chat-view')).toBeVisible({ timeout: 45000 });

        // The banner is gone once the connection is live again, and nothing was
        // left behind in the toast stack.
        await expect(page.getByTestId('connection-banner')).not.toBeVisible({ timeout: 10000 });
        await expect(page.getByTestId('toast')).not.toBeVisible({ timeout: 10000 });

        // Verify counter was reset and nextReconnectAt cleared
        const state = await page.evaluate(() => {
            const store = (window as any).__connectionState;
            return store?.get?.() ?? store;
        });
        expect(state?.reconnectAttempts).toBe(0);
        expect(state?.nextReconnectAt).toBeUndefined();
    });

    test('TOTP connections do not auto-reconnect', async () => {
        await expect(page.getByTestId('chat-view')).toBeVisible();

        // Enable TOTP mode — should disable auto-reconnect
        await setSettings(page, { autoconnect: true, useTotp: true });

        // Simulate unexpected WebSocket close
        await page.evaluate(() => {
            const ws = (window as any).__getSession?.()?.getSocket?.();
            if (ws) ws.close(3000, 'test disconnect');
        });

        // The banner appears, and it names the credential as the thing missing
        // rather than pretending a retry will fix it.
        await expect(page.getByTestId('connection-banner')).toBeVisible({ timeout: 10000 });
        await expect(page.getByTestId('connection-banner')).toContainText(/verification code/i);

        // No countdown: a scheduled retry would be a lie, the token is spent.
        await expect(page.getByTestId('connection-banner-countdown')).not.toBeVisible();

        // The action is still there, labelled as what it actually does.
        await expect(page.getByTestId('connection-banner-retry')).toBeVisible();
        await expect(page.getByTestId('connection-banner-retry')).toContainText(/verification code/i);

        // Verify nextReconnectAt is NOT set (no auto-reconnect scheduled)
        const state = await page.evaluate(() => {
            const store = (window as any).__connectionState;
            return store?.get?.() ?? store;
        });
        expect(state?.nextReconnectAt).toBeUndefined();
    });

    test('backoff delay increases after failed attempt', async () => {
        await expect(page.getByTestId('chat-view')).toBeVisible();
        await setSettings(page, { autoconnect: true });

        // First disconnect — should schedule reconnect at 30s
        await page.evaluate(() => {
            const ws = (window as any).__getSession?.()?.getSocket?.();
            if (ws) ws.close(3000, 'test disconnect');
        });

        // Read the first countdown off the banner. The window ticks down from the
        // scheduled instant, so assert the initial backoff as a range rather than
        // pinning a number the render can legitimately be a second into.
        await expect(page.getByTestId('connection-banner-countdown')).toBeVisible({ timeout: 10000 });
        const firstSeconds = await countdownSeconds(page);
        expect(firstSeconds).toBeGreaterThan(20);
        expect(firstSeconds).toBeLessThanOrEqual(30);

        // Intercept WebSocket so the manual reconnect attempt fails immediately
        await page.evaluate(() => {
            const OriginalWebSocket = window.WebSocket;
             
            const wrapper: any = function (this: WebSocket, url: string | URL, protocols?: string | string[]) {
                const ws = new OriginalWebSocket(url, protocols);
                ws.addEventListener('open', () => {
                    ws.close(3000, 'intercepted');
                });
                return ws;
            };
            wrapper.prototype = OriginalWebSocket.prototype;
            (window as any).WebSocket = wrapper;
        });

        // Retry now — triggers an immediate attempt, which the interceptor fails
        await page.getByTestId('connection-banner-retry').click();

        // Wait for the failed attempt to schedule a longer backoff
        await expect(async () => {
            expect(await countdownSeconds(page)).toBeGreaterThan(firstSeconds);
        }).toPass({ timeout: 15000, intervals: [500] });

        // Verify reconnectAttempts increased
        const state = await page.evaluate(() => {
            const store = (window as any).__connectionState;
            return store?.get?.() ?? store;
        });
        expect(state?.reconnectAttempts).toBeGreaterThanOrEqual(2);
    });
});
