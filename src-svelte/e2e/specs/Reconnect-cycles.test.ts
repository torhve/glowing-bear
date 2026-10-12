import { test, expect } from '@playwright/test';
import { connectToWeechat, setSettings, waitForAppReady } from '../helpers/connection';
import { switchToBuffer, waitForBuffer } from '../helpers/buffers';
import { waitForChatSettled, waitForRow } from '../helpers/waits';
import { irc } from '../helpers/irc-control';
import { setupEffectOrphanFilter } from '../helpers/pageerror';

/**
 * Repeated drop/recover cycles.
 *
 * A reconnect is where leaks accumulate quietly: a new socket with a second set
 * of handlers, a retry loop that kept its earlier scheduled attempt, a toast per
 * loss, a snapshot that never got released. None of it shows up on the first
 * cycle, and each individual symptom is small enough to look like a rendering
 * quirk. This spec runs the cycle three times and checks the observable
 * consequences of accumulation.
 *
 * The duplicate-row assertion is the load-bearing one. If a reconnect attached
 * another message handler to the transport, every channel message after the
 * third cycle would render more than once — which is a data-integrity failure
 * wearing the costume of a cosmetic one.
 */
test.describe('Reconnect cycles', () => {
    test.describe.configure({ mode: 'serial' });

    test('three cycles leave no duplicate rows, no stale snapshot, and no toast pile', async ({ page }) => {
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

        for (let cycle = 1; cycle <= 3; cycle++) {
            const marker = `cycle-${cycle}-${Date.now()}`;
            await irc.sendMessage('#glowing-bear', marker);
            await waitForRow(page, marker);
            await waitForChatSettled(page);

            await page.evaluate((reason) => {
                const session = (window as any).__getSession?.();
                const socket = session?.getSocket?.();
                if (socket) socket.close(3000, reason);
            }, `cycle-${cycle}`);
            await expect(page.getByTestId('connection-banner')).toBeVisible({ timeout: 10000 });
            await waitForChatSettled(page);

            // The banner owns connection presentation while a retained view is up,
            // so a toast here means two surfaces are describing the same loss.
            await expect(page.getByTestId('toast'), `cycle ${cycle}: a toast piled up beside the banner`).toHaveCount(0);

            // The retained view must be this cycle's session. A snapshot that was
            // never released would still be showing cycle 1.
            await expect(page.getByText(marker), `cycle ${cycle}: the retained view is stale`).toHaveCount(1);

            await page.getByTestId('connection-banner-retry').click();
            await expect(page.getByTestId('connection-banner')).toHaveCount(0, { timeout: 30000 });
            await waitForChatSettled(page);

            // Exactly one row per message. A second message handler from a
            // reconnected socket would render this twice.
            await expect(page.getByText(marker), `cycle ${cycle}: a message handler accumulated`).toHaveCount(1);
        }

        // After three cycles the composer still targets one live conversation,
        // and what the user types reaches the channel once.
        const final = `final-${Date.now()}`;
        await page.getByTestId('message-input').fill(final);
        await page.getByTestId('send-button').click();
        await expect(page.getByText(final)).toHaveCount(1, { timeout: 15000 });
    });
});
