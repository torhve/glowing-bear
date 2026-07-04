import { test, expect } from '@playwright/test';
import { setSettings, reconnect } from '../helpers/connection';
import { createConnectedPage } from '../fixtures/auth';
import { setupEffectOrphanFilter } from '../helpers/pageerror';

test.describe.configure({ mode: 'serial' });

test.describe('Auto reconnect with countdown toast', () => {
    let page: import('@playwright/test').Page;

    test.beforeEach(async ({ browser }) => {
        page = await createConnectedPage(browser);
        setupEffectOrphanFilter(page);
    });

    test('disconnect shows countdown toast when autoconnect enabled', async () => {
        await expect(page.getByTestId('chat-view')).toBeVisible();

        // Enable autoconnect so disconnect triggers countdown toast
        await setSettings(page, { autoconnect: true });

        // Simulate unexpected WebSocket close
        await page.evaluate(() => {
            const ws = (window as any).__getWs?.();
            if (ws) ws.close(3000, 'test disconnect');
        });

        // Warning toast should appear with countdown
        await expect(page.getByTestId('toast').first()).toBeVisible({ timeout: 10000 });
        await expect(page.getByText(/Disconnected from/)).toBeVisible({ timeout: 5000 });
        await expect(page.getByText(/Reconnecting in \d+s/)).toBeVisible({ timeout: 5000 });

        // Verify Reconnect button is present
        await expect(page.getByTestId('toast-reconnect-button')).toBeVisible();

        // Verify nextReconnectAt is set
        const state = await page.evaluate(() => {
            const store = (window as any).__connectionState;
            return store?.get?.() ?? store;
        });
        expect(state?.nextReconnectAt).toBeGreaterThan(0);
    });

    test('manual reconnect button triggers immediate retry', async () => {
        await expect(page.getByTestId('chat-view')).toBeVisible();
        await setSettings(page, { autoconnect: true });

        // Simulate disconnect to trigger countdown toast
        await page.evaluate(() => {
            const ws = (window as any).__getWs?.();
            if (ws) ws.close(3000, 'test disconnect');
        });

        // Wait for countdown toast to appear
        await expect(page.getByTestId('toast').first()).toBeVisible({ timeout: 10000 });
        await expect(page.getByText(/Reconnecting in \d+s/)).toBeVisible({ timeout: 5000 });

        // Click Reconnect button — should try immediately, not wait for countdown
        await page.getByTestId('toast-reconnect-button').click();

        // Should reconnect successfully
        await expect(page.getByTestId('chat-view')).toBeVisible({ timeout: 45000 });

        // Toast should be cleared after successful connection
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
            const ws = (window as any).__getWs?.();
            if (ws) ws.close(3000, 'test disconnect');
        });

        // Disconnect toast should appear but WITHOUT countdown
        await expect(page.getByTestId('toast').first()).toBeVisible({ timeout: 10000 });
        await expect(page.getByText(/Disconnected from/)).toBeVisible({ timeout: 5000 });

        // Countdown should NOT be present for TOTP connections
        await expect(page.getByText(/Reconnecting in \d+s/)).not.toBeVisible({ timeout: 2000 });

        // Reconnect button should still be present for manual retry
        await expect(page.getByTestId('toast-reconnect-button')).toBeVisible();

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
            const ws = (window as any).__getWs?.();
            if (ws) ws.close(3000, 'test disconnect');
        });

        // Wait for toast to appear and extract countdown
        await expect(page.getByTestId('toast').first()).toBeVisible({ timeout: 10000 });
        let countdownText = await page.getByText(/Reconnecting in (\d+s)/).first().textContent();
        let firstSeconds = parseInt(countdownText?.match(/in (\d+)/)?.[1] || '0', 10);
        expect(firstSeconds).toBeCloseTo(30, 0);

        // Set nextReconnectAt to past so the timer fires immediately (simulates time passing)
        await page.evaluate(() => {
            (window as any).__setNextReconnectAt?.(Date.now() - 1000);
        });

        // The reconnect timer should fire, attempt will fail (no server), 
        // triggering another disconnect with increased backoff.
        // Wait for the reconnect cycle to complete
        await new Promise(r => setTimeout(r, 5000));

        // New countdown should show increased delay (45s for attempt 2)
        await expect(async () => {
            const newCountdown = await page.getByText(/Reconnecting in \d+s/).first().textContent();
            const newSeconds = parseInt(newCountdown?.match(/in (\d+)/)?.[1] || '0', 10);
            expect(newSeconds).toBeGreaterThan(firstSeconds);
        }).toPass({ timeout: 10000, intervals: [1000] });
    });
});
