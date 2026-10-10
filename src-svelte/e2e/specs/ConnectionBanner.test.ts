import { test, expect } from '@playwright/test';
import { connectToWeechat, setSettings, waitForAppReady, waitForTransport } from '../helpers/connection';
import { switchToBuffer, waitForBuffer } from '../helpers/buffers';
import { waitForChatSettled, waitForRow } from '../helpers/waits';
import { expectInputFocused } from '../helpers/input';
import { irc } from '../helpers/irc-control';
import { setupEffectOrphanFilter } from '../helpers/pageerror';

/**
 * The retained shell.
 *
 * The gate this file exists for: a transient interruption must not replace
 * readable chat with the connection form. Every spec here drops the live socket
 * with autoconnect OFF, which is deliberate — it freezes the session in a
 * retained state instead of racing a 30 s backoff, so the assertions are about
 * presentation rather than about how fast the relay answers.
 */
test.describe('Connection banner', () => {
    test.describe.configure({ mode: 'serial' });

    test.beforeEach(async ({ page }) => {
        setupEffectOrphanFilter(page);
        await page.goto('http://localhost:8001/');
        await page.evaluate(() => localStorage.removeItem('gb-settings'));
        await page.reload();
        await waitForAppReady(page);
    });

    /** Connect, land in the channel, then kill the socket with no auto-reconnect. */
    async function loseTheSession(page: import('@playwright/test').Page) {
        await setSettings(page, { autoconnect: false });
        await connectToWeechat(page, '9010');
        await expect(page.getByTestId('chat-view')).toBeVisible({ timeout: 45000 });
        await waitForBuffer(page, '#glowing-bear');
        await switchToBuffer(page, '#glowing-bear');

        const marker = `retained-${Date.now()}`;
        await irc.sendMessage('#glowing-bear', marker);
        await waitForRow(page, marker);
        await waitForChatSettled(page);

        await page.evaluate(() => {
            const socket = (window as any).__getSession?.()?.getSocket?.();
            if (socket) socket.close(3000, 'test drop');
        });
        await expect(page.getByTestId('connection-banner')).toBeVisible({ timeout: 10000 });
        return marker;
    }

    test('an outage keeps the chat shell and shows a banner instead of the form', async ({ page }) => {
        const marker = await loseTheSession(page);

        // The gate, stated as the two things a user would notice.
        await expect(page.getByTestId('chat-view')).toBeVisible();
        await expect(page.getByTestId('host-input')).not.toBeVisible();

        // The chat that was on screen is still on screen.
        await expect(page.getByText(marker).first()).toBeVisible();

        // Stale state is legible as text, not only as a coloured dot. The API
        // transport classifies a dropped socket as an unreachable relay, so the
        // sentence is the one the user actually sees.
        await expect(page.getByTestId('connection-banner-readonly')).toBeVisible();
        await expect(page.getByTestId('connection-banner')).toContainText(/could not be reached/i);
    });

    test('the banner keeps a way out: Leave releases the retained view', async ({ page }) => {
        await loseTheSession(page);

        await page.getByTestId('connection-banner-leave').click();

        await expect(page.getByTestId('host-input')).toBeVisible({ timeout: 10000 });
        await expect(page.getByTestId('chat-view')).not.toBeVisible();
        await expect(page.getByTestId('connection-banner')).not.toBeVisible();
    });

    test('Edit connection reveals the form and Back to chat restores the same view', async ({ page }) => {
        const marker = await loseTheSession(page);

        await page.getByTestId('connection-banner-edit').click();
        await expect(page.getByTestId('host-input')).toBeVisible();
        await expect(page.getByTestId('connection-back-to-chat')).toBeVisible();

        // Back out without touching the fields: the retained session is untouched,
        // so the same conversation is still readable.
        await page.getByTestId('connection-back-to-chat').click();
        await expect(page.getByTestId('chat-view')).toBeVisible();
        await expect(page.getByText(marker).first()).toBeVisible();
        await expect(page.getByTestId('connection-banner')).toBeVisible();
    });

    test('Reconnect on the banner restores live chat on the same transport', async ({ page }) => {
        await loseTheSession(page);

        // autoconnect is off, so no loop is running: the banner's primary action
        // is "Reconnect", and it must reuse the captured profile rather than
        // re-probe the relay.
        await expect(page.getByTestId('connection-banner-retry')).toBeEnabled();
        await page.getByTestId('connection-banner-retry').click();

        await expect(page.getByTestId('connection-banner')).not.toBeVisible({ timeout: 45000 });
        await waitForTransport(page, 'api', 30000);

        // Live again: traffic from the relay reaches the same view.
        const text = `after-reconnect-${Date.now()}`;
        await irc.sendMessage('#glowing-bear', text);
        await expect(page.getByText(text).first()).toBeVisible({ timeout: 25000 });
    });

    // The bug this pins: Edit connection reveals the form, Connect succeeds, and
    // the form must get out of the way of the chat it just restored.
    test('connecting from Edit connection puts the chat back', async ({ page }) => {
        await loseTheSession(page);

        await page.getByTestId('connection-banner-edit').click();
        await expect(page.getByTestId('host-input')).toBeVisible();
        // The password is not persisted in this fixture, so re-entering it is
        // part of the flow rather than a test convenience.
        await page.getByTestId('password-input').fill('testpassword123');
        await page.getByTestId('connect-button').click();

        await expect(page.getByTestId('chat-view')).toBeVisible({ timeout: 45000 });
        await expect(page.getByTestId('host-input')).not.toBeVisible();
        await expect(page.getByTestId('connection-banner')).not.toBeVisible({ timeout: 10000 });
    });

    test('the banner does not steal composer focus', async ({ page }) => {
        await connectToWeechat(page);
        await expect(page.getByTestId('chat-view')).toBeVisible({ timeout: 45000 });
        await waitForBuffer(page, '#glowing-bear');
        await switchToBuffer(page, '#glowing-bear');
        // Focus is established through the user's own action, so what is being
        // measured is whether the banner takes it away, not whether the app gave
        // it in the first place.
        await page.getByTestId('message-input').click();
        await expectInputFocused(page);

        await setSettings(page, { autoconnect: false });
        await page.evaluate(() => {
            const socket = (window as any).__getSession?.()?.getSocket?.();
            if (socket) socket.close(3000, 'test drop');
        });
        await expect(page.getByTestId('connection-banner')).toBeVisible({ timeout: 10000 });

        // The composer is still the focused element: a status strip that appeared
        // on its own has no business taking the caret from a person mid-sentence.
        await expectInputFocused(page);
    });

    // The measured fact: the banner shrinks the chat container, so the container's
    // own top edge moves down by the banner's height while `scrollTop` does not
    // change at all. Reading position is therefore about which row sits at the
    // top of the viewport, not about a row's absolute coordinates — asserting the
    // latter would demand the impossible and assert the wrong thing.
    test('the banner does not move the chat scroll position', async ({ page }) => {
        await connectToWeechat(page);
        await expect(page.getByTestId('chat-view')).toBeVisible({ timeout: 45000 });
        await waitForBuffer(page, '#glowing-bear');
        await switchToBuffer(page, '#glowing-bear');
        await waitForChatSettled(page);

        const probe = () => page.evaluate(() => {
            const el = document.querySelector('[data-testid="chat-messages"]') as HTMLElement;
            const edge = el.getBoundingClientRect().top;
            const rows = Array.from(el.querySelectorAll('[data-testid="bufferline-row"]'));
            const firstVisible = rows.find((r) => r.getBoundingClientRect().bottom > edge + 1);
            return {
                scrollTop: el.scrollTop,
                atTop: firstVisible?.textContent?.slice(0, 40) ?? '<none>',
            };
        });

        await page.evaluate(() => {
            const el = document.querySelector('[data-testid="chat-messages"]') as HTMLElement;
            el.scrollTop = Math.max(0, el.scrollTop - 400);
        });
        await waitForChatSettled(page);
        const before = await probe();
        expect(before.atTop, 'the fixture needs a scrolled chat to test anything').not.toBe('<none>');

        await setSettings(page, { autoconnect: false });
        await page.evaluate(() => {
            const socket = (window as any).__getSession?.()?.getSocket?.();
            if (socket) socket.close(3000, 'test drop');
        });
        await expect(page.getByTestId('connection-banner')).toBeVisible({ timeout: 10000 });
        await waitForChatSettled(page);
        const after = await probe();

        expect(after.atTop, 'the banner changed which line the reader was looking at').toBe(before.atTop);
        // Nothing wrote scrollTop: the retained re-render kept the offset it was
        // given, which is the scroll-ownership contract holding.
        expect(after.scrollTop).toBe(before.scrollTop);
    });

    test('a retained view offers no remote controls', async ({ page }) => {
        await loseTheSession(page);

        // Pin and close are WeeChat commands. A frozen buffer has no transport to
        // act on, so the controls are absent rather than inert.
        await expect(page.getByTestId('pin-buffer')).not.toBeVisible();
        await expect(page.getByTestId('close-buffer')).not.toBeVisible();
    });
});
