import { test, expect } from '@playwright/test';
import { setSettings } from '../helpers/connection';
import { createConnectedPage } from '../fixtures/auth';

test.describe.configure({ mode: 'serial' });

test.describe('Reconnect loop guard', () => {
    let page: import('@playwright/test').Page;

    test.beforeEach(async ({ browser }) => {
        page = await createConnectedPage(browser);
    });

    test('should stop auto-reconnecting after max attempts and show error toast', async () => {
        await expect(page.getByTestId('chat-view')).toBeVisible();

        // Enable autoconnect so disconnect triggers scheduleReconnect instead of toast
        await setSettings(page, { autoconnect: true });

        // Set reconnectAttempts to 8 — next increment will reach 9, exceeding maxReconnectAttempts (8)
        await page.evaluate(() => {
            (window as any).__setReconnectAttempts?.(8);
        });

        // Simulate unexpected WebSocket close (code 3000 → triggers scheduleReconnect)
        await page.evaluate(() => {
            const ws = (window as any).__getWs?.();
            if (ws) ws.close(3000, 'test disconnect');
        });

        // Error toast should appear (no reconnect scheduled since limit exceeded)
        await expect(page.getByTestId('toast').first()).toBeVisible({ timeout: 10000 });
        await expect(page.getByText(/Connection lost after 8 failed reconnect attempts/)).toBeVisible({ timeout: 5000 });

        // Verify chat-view is NOT visible (no auto-reconnect happened)
        await expect(page.getByTestId('chat-view')).not.toBeVisible();

        // Verify reconnect state shows max attempts
        const state = await page.evaluate(() => {
            const store = (window as any).__connectionState;
            if (!store) return null;
            if (typeof store.get === 'function') return store.get();
            return store;
        });
        expect(state?.reconnectAttempts).toBe(9);
    });

    test('retry button resets counter and reconnects', async () => {
        await expect(page.getByTestId('chat-view')).toBeVisible();

        // Enable autoconnect
        await setSettings(page, { autoconnect: true });

        // Set reconnectAttempts to 8 — triggers exhausted toast on next disconnect
        await page.evaluate(() => {
            (window as any).__setReconnectAttempts?.(8);
        });

        // Simulate disconnect to trigger exhausted toast
        await page.evaluate(() => {
            const ws = (window as any).__getWs?.();
            if (ws) ws.close(3000, 'test disconnect');
        });

        // Wait for error toast
        await expect(page.getByTestId('toast').first()).toBeVisible({ timeout: 10000 });
        await expect(page.getByText(/Connection lost after 8 failed reconnect attempts/)).toBeVisible();

        // Click Retry button
        await page.getByTestId('toast-retry-button').click();

        // Should reconnect successfully
        await expect(page.getByTestId('chat-view')).toBeVisible({ timeout: 45000 });

        // Verify counter was reset
        const state = await page.evaluate(() => {
            const store = (window as any).__connectionState;
            if (!store) return null;
            if (typeof store.get === 'function') return store.get();
            return store;
        });
        expect(state?.reconnectAttempts).toBe(0);
    });

    test('should not show exhausted toast before max attempts reached', async () => {
        await expect(page.getByTestId('chat-view')).toBeVisible();

        // Enable autoconnect
        await setSettings(page, { autoconnect: true });

        // Set reconnectAttempts to 7 — next increment is 8, which equals maxReconnectAttempts, not exceeds it
        await page.evaluate(() => {
            (window as any).__setReconnectAttempts?.(7);
        });

        // Simulate disconnect — should schedule a reconnect, NOT show exhausted toast
        await page.evaluate(() => {
            const ws = (window as any).__getWs?.();
            if (ws) ws.close(3000, 'test disconnect');
        });

        // Wait for onclose handler to process
        await expect(async () => {
            const state = await page.evaluate(() => {
                const store = (window as any).__connectionState;
                if (!store) return null;
                if (typeof store.get === 'function') return store.get();
                return store;
            });
            expect(state?.reconnectAttempts).toBe(8);
        }).toPass({ timeout: 5000, intervals: [200] });

        // Error toast about exhausted attempts should NOT appear
        await expect(page.getByText(/Connection lost after.*failed reconnect attempts/)).not.toBeVisible({ timeout: 2000 });
    });
});
