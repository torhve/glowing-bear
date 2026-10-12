import { test, expect } from '@playwright/test';
import { connectToWeechat, setSettings, waitForAppReady } from '../helpers/connection';
import { switchToBuffer, waitForBuffer } from '../helpers/buffers';
import { waitForChatSettled, waitForRow } from '../helpers/waits';
import { irc } from '../helpers/irc-control';
import { setupEffectOrphanFilter } from '../helpers/pageerror';

/**
 * The composer and the other call sites during a retained view.
 *
 * Task 4 put the chat on screen during an outage; this file is about what may
 * NOT happen while it is there. The interesting cases are the ones that do not
 * go through a disabled button: Enter on the composer, and a keyboard shortcut
 * that fires a relay command without ever consulting the composer's state. A
 * gate that only lives in the button is a gate with a door beside it.
 *
 * Every spec drops the socket with autoconnect OFF, which freezes the session in
 * a retained view instead of racing a 30 s backoff.
 */
test.describe('Offline composer', () => {
    test.describe.configure({ mode: 'serial' });

    test.beforeEach(async ({ page }) => {
        setupEffectOrphanFilter(page);
        await page.goto('http://localhost:8001/');
        await page.evaluate(() => localStorage.removeItem('gb-settings'));
        await page.reload();
        await waitForAppReady(page);
    });

    /** Connect, land in the channel with a known line, then kill the socket. */
    async function loseTheSession(page: import('@playwright/test').Page) {
        await setSettings(page, { autoconnect: false });
        await connectToWeechat(page, '9010');
        await expect(page.getByTestId('chat-view')).toBeVisible({ timeout: 45000 });
        await waitForBuffer(page, '#glowing-bear');
        await switchToBuffer(page, '#glowing-bear');
        const marker = `offline-${Date.now()}`;
        await irc.sendMessage('#glowing-bear', marker);
        await waitForRow(page, marker);
        await waitForChatSettled(page);
        await page.evaluate(() => {
            const socket = (window as any).__getSession?.()?.getSocket?.();
            if (socket) socket.close(3000, 'test drop');
        });
        await expect(page.getByTestId('connection-banner')).toBeVisible({ timeout: 10000 });
        await waitForChatSettled(page);
        return marker;
    }

    test('the composer names the conversation it is holding text for', async ({ page }) => {
        await loseTheSession(page);

        // Before this was fixed the composer read the live buffer, which a
        // retained view does not have, so it denied the screen above it.
        await expect(page.getByTestId('message-input')).toHaveAttribute(
            'placeholder',
            /#glowing-bear.*kept/i,
        );
        await expect(page.getByText('Select a buffer')).not.toBeVisible();
    });

    test('Enter offline keeps the text and says why nothing happened', async ({ page }) => {
        await loseTheSession(page);
        const text = `half a sentence ${Date.now()}`;
        await page.getByTestId('message-input').fill(text);

        await page.getByTestId('message-input').press('Enter');

        await expect(page.getByTestId('message-input')).toHaveValue(text);
        await expect(page.getByTestId('composer-notice')).toBeVisible();
        await expect(page.getByTestId('composer-notice')).toContainText(/kept/i);
        // The explanation belongs to the composer. A toast elsewhere would be a
        // second channel for the same fact, and the toast stack has already
        // proved it can cover the controls it is meant to point at.
        await expect(page.getByTestId('toast')).toHaveCount(0);
        // Nothing reached the channel: the retained transcript is still the one
        // that was there when the socket died.
        await expect(page.getByText(text)).not.toBeVisible();
    });

    test('Send is unavailable while the view is retained', async ({ page }) => {
        await loseTheSession(page);
        await page.getByTestId('message-input').fill('text with nowhere to go');
        await expect(page.getByTestId('send-button')).toBeDisabled();
    });

    test('the sidebar keeps the conversations, and selecting one moves the view', async ({ page }) => {
        const marker = await loseTheSession(page);

        // The live projection is empty during a retained view, so without a
        // retained list the sidebar goes blank beside a readable chat.
        const rows = page.getByTestId('buffer-item');
        await expect(rows.first()).toBeVisible();
        await expect(rows.filter({ hasText: 'weechat' }).first()).toBeVisible();

        const target = rows.filter({ hasText: 'weechat' }).first();
        await target.click();

        // A different conversation is on screen, and the composer followed it.
        await expect(page.getByTestId('message-input')).toHaveAttribute('placeholder', /weechat/i);
        await expect(page.getByText(marker)).not.toBeVisible();

        // And back to the conversation the reader was in.
        await rows.filter({ hasText: 'glowing-bear' }).first().click();
        await expect(page.getByText(marker).first()).toBeVisible();
    });

    test('a half-typed message survives browsing away and back', async ({ page }) => {
        await loseTheSession(page);
        const text = `draft across buffers ${Date.now()}`;
        await page.getByTestId('message-input').fill(text);

        const rows = page.getByTestId('buffer-item');
        await rows.filter({ hasText: 'weechat' }).first().click();
        await expect(page.getByTestId('message-input')).not.toHaveValue(text);

        await rows.filter({ hasText: 'glowing-bear' }).first().click();
        await expect(page.getByTestId('message-input')).toHaveValue(text);
    });

    test('the member list stays visible and says it is cached', async ({ page }) => {
        await loseTheSession(page);

        // The nicks are the ones WeeChat had when the session died. Hiding them
        // would throw away the one thing the snapshot knows that the chat does
        // not show; showing them unlabelled would claim they are here now.
        await expect(page.getByTestId('nicklist-items')).toBeVisible();
        await expect(page.getByTestId('nicklist-stale')).toBeVisible();
        await expect(page.getByTestId('nick-item').first()).toBeVisible();
    });

    test('a nick is not a conversation you can start offline', async ({ page }) => {
        await loseTheSession(page);
        const nick = page.getByTestId('nick-item').first();
        const name = (await nick.textContent())?.trim() ?? '';

        await nick.click();

        // A /query needs a session. The click must not pretend otherwise: no
        // pending switch is queued and no new conversation appears in the list.
        await expect(page.getByTestId('connection-banner')).toBeVisible();
        await expect(page.getByTestId('buffer-item').filter({ hasText: name })).toHaveCount(0);
    });

    test('an image cannot be staged for a session that is not there', async ({ page }) => {
        await loseTheSession(page);

        // Paste, drop, the file picker and the clipboard-string fallback all funnel
        // through one collector, so the refusal has one home. A preview that looks
        // ready and can never be sent is the silent queue this plan rules out.
        const png = Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
            'base64',
        );
        await page.setInputFiles('#upload-image-file', {
            name: 'offline.png',
            mimeType: 'image/png',
            buffer: png,
        });

        await expect(page.getByTestId('composer-notice')).toBeVisible();
        await expect(page.getByTestId('composer-notice')).toContainText(/images are kept/i);
        await expect(page.getByTestId('preview-item')).toHaveCount(0);
    });

    test('content search offline says it needs the relay', async ({ page }) => {
        await loseTheSession(page);

        // The call site that never asks: this shortcut fires a relay command
        // without consulting the composer, and it used to spend three seconds
        // waiting for a result buffer before reporting "No results found" for a
        // session that was not connected at all.
        await page.keyboard.press('Control+f');
        const input = page.locator('#content-search-input');
        await expect(input).toBeVisible();
        await input.fill(`anything ${Date.now()}`);
        await input.press('Enter');

        await expect(page.getByText(/content search needs the relay/i).first()).toBeVisible();
        await expect(page.getByText('No results found')).toHaveCount(0);
    });
});
