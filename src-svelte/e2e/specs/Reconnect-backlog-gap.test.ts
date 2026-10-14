import { test, expect } from '@playwright/test';
import {
    connectToWeechat,
    connectLegacyToWeechat,
    setSettings,
    waitForAppReady,
    waitForTransport,
} from '../helpers/connection';
import { switchToBuffer, waitForBuffer } from '../helpers/buffers';
import { waitForChatSettled, waitForRow } from '../helpers/waits';
import { sendSequence } from '../helpers/irc-control';
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
 *
 * Run for both transports. The freshness gate that decides whether to fetch is
 * shared by them, but only the API transport used to answer it, so the legacy
 * case is exactly where a shared gate and a transport-local counter drift apart.
 */

type Transport = 'api' | 'legacy';

async function prime(page: import('@playwright/test').Page, transport: Transport) {
    setupEffectOrphanFilter(page);
    await page.goto('http://localhost:8001/');
    await page.evaluate(() => localStorage.removeItem('gb-settings'));
    await page.reload();
    await waitForAppReady(page);
    await setSettings(page, { autoconnect: false });
    if (transport === 'api') {
        await connectToWeechat(page, '9010');
        await waitForTransport(page, 'api');
    } else {
        await connectLegacyToWeechat(page);
        await waitForTransport(page, 'legacy');
    }
    await expect(page.getByTestId('chat-view')).toBeVisible({ timeout: 45000 });
    await waitForBuffer(page, '#glowing-bear');
    await switchToBuffer(page, '#glowing-bear');
}

/** Drop the live socket for the transport actually in use. */
async function dropSocket(page: import('@playwright/test').Page, transport: Transport, reason: string) {
    await page.evaluate(({ which, why }: { which: string; why: string }) => {
        const socket = which === 'api'
            ? (window as any).__getSession?.()?.getSocket?.()
            : (window as any).__getWs?.();
        if (socket) socket.close(3000, why);
    }, { which: transport, why: reason });
    await expect(page.getByTestId('connection-banner')).toBeVisible({ timeout: 10000 });
    await waitForChatSettled(page);
}

async function retry(page: import('@playwright/test').Page) {
    await page.getByTestId('connection-banner-retry').click();
    await expect(page.getByTestId('connection-banner')).toHaveCount(0, { timeout: 30000 });
    await waitForChatSettled(page);
}

function runBacklogGap(transport: Transport) {
    test.describe(`Reconnect backlog gap (${transport} transport)`, () => {
        test.describe.configure({ mode: 'serial' });

        test.beforeEach(async ({ page }) => {
            await prime(page, transport);
        });

        test('the messages received while disconnected appear after reconnecting', async ({ page }) => {
            const tag = `gap-${transport}-${Date.now()}`;

            // "Last night": enough lines to fill the retained window to its cap, so
            // the buffer comes back holding a full transcript rather than an empty
            // one. That is what makes the retained window look like enough history.
            const lastNight = Array.from({ length: 240 }, (_, i) =>
                `${tag} old ${String(i).padStart(3, '0')}`);
            await sendSequence('#glowing-bear', lastNight);
            await waitForRow(page, `${tag} old 239`);
            await waitForChatSettled(page);

            await dropSocket(page, transport, 'gap-outage');

            // The AFK window. The app is not subscribed, so these never arrive live.
            const today = Array.from({ length: 40 }, (_, i) =>
                `${tag} new ${String(i).padStart(3, '0')}`);
            await sendSequence('#glowing-bear', today);

            await retry(page);

            // The retained window is still there — that part always worked.
            await expect(page.getByText(`${tag} old 239`), 'the outage keeps what was on screen')
                .toBeVisible();

            // The gap: the newest line the server has.
            await expect(
                page.getByText(`${tag} new 039`),
                `a ${transport} reconnect must fetch the lines that landed while the app was away`,
            ).toBeVisible({ timeout: 20000 });
        });

        test('the recovered window is not also duplicated onto the screen', async ({ page }) => {
            const tag = `dup-${transport}-${Date.now()}`;

            const lastNight = Array.from({ length: 240 }, (_, i) =>
                `${tag} old ${String(i).padStart(3, '0')}`);
            await sendSequence('#glowing-bear', lastNight);
            await waitForRow(page, `${tag} old 239`);
            await waitForChatSettled(page);

            await dropSocket(page, transport, 'dup-outage');

            const today = Array.from({ length: 40 }, (_, i) =>
                `${tag} new ${String(i).padStart(3, '0')}`);
            await sendSequence('#glowing-bear', today);

            await retry(page);

            await expect(page.getByText(`${tag} new 039`)).toBeVisible({ timeout: 20000 });

            // A fetch that re-delivers lines the retained window already holds would
            // put the same message on screen twice. Counting rows rather than reading
            // a scroll number is what catches a merge that appends instead of joining.
            for (const marker of [`${tag} old 239`, `${tag} new 000`, `${tag} new 039`]) {
                await expect(
                    page.getByText(marker, { exact: true }),
                    `${marker} should appear once`,
                ).toHaveCount(1);
            }
        });
    });
}

for (const transport of ['api', 'legacy'] as Transport[]) {
    runBacklogGap(transport);
}
