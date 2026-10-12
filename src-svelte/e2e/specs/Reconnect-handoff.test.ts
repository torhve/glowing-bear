import { test, expect } from '@playwright/test';
import { connectToWeechat, setSettings, waitForAppReady } from '../helpers/connection';
import { switchToBuffer, waitForBuffer } from '../helpers/buffers';
import { waitForChatSettled, waitForRow } from '../helpers/waits';
import { resetInputState } from '../helpers/input';
import { irc } from '../helpers/irc-control';
import { setupEffectOrphanFilter } from '../helpers/pageerror';

/**
 * Task 6 — the handoff from a retained view back to a live session.
 *
 * These specs exist because the defect was invisible on the reconnect that
 * caused it. A snapshot was never released on a successful reconnect, and a
 * second capture is refused while one exists, so the bug only appeared on the
 * NEXT outage: the app re-displayed the FIRST outage's transcript and the
 * messages read in between vanished. A spec that only checks "the chat is still
 * there after reconnecting" passes with or without the fix.
 */
test.describe('Reconnect handoff', () => {
    test.describe.configure({ mode: 'serial' });

    test.beforeEach(async ({ page }) => {
        setupEffectOrphanFilter(page);
        await page.goto('http://localhost:8001/');
        await page.evaluate(() => localStorage.removeItem('gb-settings'));
        await page.reload();
        await waitForAppReady(page);
        // Autoconnect off: the reconnect is driven by the banner's Retry, so the
        // spec controls when the new session starts instead of racing a backoff.
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

    test('the conversation continues instead of restarting', async ({ page }) => {
        const marker = `handoff-${Date.now()}`;
        await irc.sendMessage('#glowing-bear', marker);
        await waitForRow(page, marker);
        await waitForChatSettled(page);

        await dropSocket(page, 'handoff-1');
        await expect(page.getByText(marker), 'the outage keeps what was on screen').toBeVisible();

        await retry(page);

        await expect(page.getByText(marker), 'a reconnect must not replace the transcript with the new session alone').toBeVisible();
        await expect(page.getByTestId('message-input')).toHaveAttribute('placeholder', /^Message #glowing-bear$/, 'the composer is live again');

        // Remote controls are absent from a retained view, so their presence is
        // the cheapest proof that the handoff finished and the view is a live
        // session rather than a snapshot that outlived its connection.
        await expect(page.getByTestId('pin-buffer')).toBeVisible();
        await expect(page.getByTestId('close-buffer')).toBeVisible();
    });

    test('a second outage shows the current conversation, not the first outage', async ({ page }) => {
        const first = `first-${Date.now()}`;
        await irc.sendMessage('#glowing-bear', first);
        await waitForRow(page, first);
        await waitForChatSettled(page);

        await dropSocket(page, 'handoff-2');
        await retry(page);

        // Read something new after reconnecting. This is the whole point of the
        // spec: with a snapshot left in place, the next loss replays the old one.
        const second = `second-${Date.now()}`;
        await irc.sendMessage('#glowing-bear', second);
        await waitForRow(page, second);
        await waitForChatSettled(page);

        await dropSocket(page, 'handoff-3');

        await expect(page.getByTestId('connection-banner')).toBeVisible();
        await expect(page.getByText(second), 'the retained view must be this session, not an older one').toBeVisible();
        await expect(page.getByText(first)).toBeVisible();
    });

    test('a draft typed during the outage survives the handoff', async ({ page }) => {
        const marker = `draft-${Date.now()}`;
        await irc.sendMessage('#glowing-bear', marker);
        await waitForRow(page, marker);
        await waitForChatSettled(page);

        await dropSocket(page, 'handoff-4');
        const draft = `half a sentence ${Date.now()}`;
        await page.getByTestId('message-input').fill(draft);

        await retry(page);

        // The text is the user's, the conversation is the one it belongs to, and
        // neither changed because the socket did.
        await expect(page.getByTestId('message-input')).toHaveValue(draft);
        await expect(page.getByTestId('message-input')).toHaveAttribute('placeholder', /^Message #glowing-bear$/);
    });

    test('sending works again once the handoff completes', async ({ page }) => {
        const marker = `resume-${Date.now()}`;
        await irc.sendMessage('#glowing-bear', marker);
        await waitForRow(page, marker);
        await waitForChatSettled(page);

        await dropSocket(page, 'handoff-5');
        const sent = `after-handoff-${Date.now()}`;
        await page.getByTestId('message-input').fill(sent);
        await expect(page.getByTestId('send-button')).toBeDisabled();

        await retry(page);
        await expect(page.getByTestId('send-button')).toBeEnabled();
        await page.getByTestId('send-button').click();

        await expect(page.getByText(sent), 'the composer target and the transport agree on one live session').toBeVisible({ timeout: 15000 });
        await resetInputState(page);
    });
});
