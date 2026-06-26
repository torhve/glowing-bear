import { test, expect } from '@playwright/test';
import { connectToWeechat, waitForAppReady } from '../helpers/connection';

import { setupEffectOrphanFilter } from '../helpers/pageerror';

test.describe.configure({ mode: 'serial' });

test.describe('Autoconnect spam guard', () => {
    test.beforeEach(async ({ page }) => {
        setupEffectOrphanFilter(page)
    });

    test('should not retry autoconnect rapidly when connection fails', async ({ page }) => {
        // Instrument WebSocket before any page scripts run — persists across navigation/reload
        await page.addInitScript(() => {
            (window as any).__wsConnectionCount = 0;
            const origWebSocket = window.WebSocket;
            (window as any).WebSocket = function (
                this: WebSocket,
                url: string | URL,
                protocols?: string | string[]
            ) {
                (window as any).__wsConnectionCount++;
                return new origWebSocket(url, protocols);
            };
            const orig = window.WebSocket;
            (window as any).WebSocket.CONNECTING = orig.CONNECTING;
            (window as any).WebSocket.OPEN = orig.OPEN;
            (window as any).WebSocket.CLOSING = orig.CLOSING;
            (window as any).WebSocket.CLOSED = orig.CLOSED;
            (window as any).WebSocket.prototype = orig.prototype;
        });

        // Set up autoconnect with bad password
        await page.goto('http://localhost:8001/');
        await page.evaluate(() => localStorage.removeItem('gb-settings'));
        await page.evaluate(() => {
            localStorage.setItem('gb-settings', JSON.stringify({
                hostField: 'localhost',
                port: '9001',
                tls: false,
                password: 'wrongpassword',
                savepassword: true,
                autoconnect: true,
            }));
        });
        await page.reload();
        await waitForAppReady(page);

        // Wait for autoconnect to attempt and fail
        await expect(async () => {
            const count = await page.evaluate(() => (window as any).__wsConnectionCount ?? 0);
            expect(count).toBeGreaterThanOrEqual(1);
        }).toPass({ timeout: 5000, intervals: [200] });

        const wsCount = await page.evaluate(() => (window as any).__wsConnectionCount ?? 0);
        expect(wsCount).toBeLessThanOrEqual(2);

        // Verify no additional attempts after failure
        await expect(async () => {
            const count = await page.evaluate(() => (window as any).__wsConnectionCount ?? 0);
            expect(count).toBe(wsCount);
        }).toPass({ timeout: 3000, intervals: [500] });
    });
});
