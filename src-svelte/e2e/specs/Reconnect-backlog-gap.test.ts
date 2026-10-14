import { test, expect } from '@playwright/test';
import { connectToWeechat, setSettings, waitForAppReady } from '../helpers/connection';
import { switchToBuffer, waitForBuffer } from '../helpers/buffers';
import { waitForChatSettled, waitForRow } from '../helpers/waits';
import { irc, sendSequence } from '../helpers/irc-control';
import { setupEffectOrphanFilter } from '../helpers/pageerror';

/**
 * Lines that landed on the server *during* an outage must be there when the app
 * comes back.
 *
 * Every other reconnect spec sends its messages before the outage or after the
 * reconnect. None sends them during it — which is the ordinary case for a client
 * that was left open overnight: the channel keeps talking while the app is not
 * subscribed, and the app returns to a transcript that stops at the moment it
 * lost the socket.
 */
test.describe('Reconnect backlog gap', () => {
    test.describe.configure({ mode: 'serial' });

    test.beforeEach(async ({ page }) => {
        setupEffectOrphanFilter(page);
        await page.goto('http://localhost:8001/');
        await page.evaluate(() => localStorage.removeItem('gb-settings'));
        await page.reload();
        await waitForAppReady(page);
        await setSettings(page, { autoconnect: false });
        await connectToWeechat(page, '9010');
        await expect(page.getByTestId('chat-view')).toBeVisible({ timeout: 45000 });
        await waitForBuffer(page, '#glowing-bear');
        await switchToBuffer(page, '#glowing-bear');
    });

    async function dropSocket(page: import('@playwright/test').Page, tag: string) {
        await page.evaluate((reason) => {
            const session = (window as any).__getSession?.();
            const socket = session?.getSocket?.();
            if (socket) socket.close(3000, reason);
        }, tag);
        await expect(page.getByTestId('connection-banner')).toBeVisible({ timeout: 10000 });
        await waitForChatSettled(page);
    }

    async function retry(page: import('@playwright/test').Page) {
        await page.getByTestId('connection-banner-retry').click();
        await expect(page.getByTestId('connection-banner')).toHaveCount(0, { timeout: 30000 });
        await waitForChatSettled(page);
    }

    test('the messages received while disconnected appear after reconnecting', async ({ page }) => {
        const tag = `gap-${Date.now()}`;

        // "Last night": enough lines to fill the retained window to its cap, so the
        // buffer comes back holding a full transcript rather than an empty one.
        const lastNight = Array.from({ length: 240 }, (_, i) =>
            `${tag} old ${String(i).padStart(3, '0')}`);
        await sendSequence('#glowing-bear', lastNight);
        await waitForRow(page, `${tag} old 239`);
        await waitForChatSettled(page);

        await dropSocket(page, 'gap-outage');

        // The AFK window. The app is not subscribed, so these never arrive live.
        const today = Array.from({ length: 40 }, (_, i) =>
            `${tag} new ${String(i).padStart(3, '0')}`);
        await sendSequence('#glowing-bear', today);

        await retry(page);

        // The retained window is still there — that part works.
        await expect(page.getByText(`${tag} old 239`), 'the outage keeps what was on screen')
            .toBeVisible();

        // The gap: the newest line the server has.
        await expect(
            page.getByText(`${tag} new 039`),
            'a reconnect must fetch the lines that landed while the app was away',
        ).toBeVisible({ timeout: 20000 });
    });
});
