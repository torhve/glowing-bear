// Regression guard for issue #8: relay.list must never show up as unread.
// WeeChat hotlists relay.list itself whenever a relay client connects or
// disconnects (relay_buffer_refresh), so a client that connects and stays quiet
// leaves it in the hotlist long enough for Glowing Bear's next poll to catch it.
import { test, expect } from '@playwright/test';
import { setupEffectOrphanFilter } from '../helpers/pageerror';
import { connectToWeechat, waitForAppReady } from '../helpers/connection';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test.describe('relay.list unread (issue #8)', () => {
    test.describe.configure({ mode: 'serial' });
    test.setTimeout(60000);

    test('a connecting relay client does not mark relay.list unread', async ({ page }) => {
        setupEffectOrphanFilter(page);
        await page.goto('/');
        await waitForAppReady(page);
        // Shorten the periodic hotlist sync poll so we don't sit through the
        // production 15 s cycle to observe the poll's effect.
        await page.evaluate(() => (window as any).__setHotlistPollInterval?.(1000));
        await connectToWeechat(page);
        await wait(2000);

        const relayItem = page.getByTestId('buffer-item').filter({ hasText: 'relay.list' }).first();
        await expect(relayItem).toBeVisible();
        await expect(relayItem.getByTestId('unread-badge')).toHaveCount(0);

        // An API client that connects and stays quiet keeps relay.list in
        // WeeChat's hotlist: nothing arrives to clear it again. Open a second
        // authenticated API WebSocket from the page and never send on it.
        const opened = await page.evaluate(async () => {
            const enc = new TextEncoder();
            const ts = Math.floor(Date.now() / 1000);
            const iterations = 100000;
            const key = await crypto.subtle.importKey('raw', enc.encode('testpassword123'), 'PBKDF2', false, ['deriveBits']);
            const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: enc.encode(String(ts)), iterations, hash: 'SHA-256' }, key, 256);
            const hash = Array.from(new Uint8Array(bits)).map((b) => b.toString(16).padStart(2, '0')).join('');
            const cred = `hash:pbkdf2+sha256:${ts}:${iterations}:${hash}`;
            const b64 = btoa(String.fromCharCode(...enc.encode(cred))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
            const ws = new WebSocket('ws://localhost:9010/api', ['api.weechat', `base64url.bearer.authorization.weechat.${b64}`]);
            await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error('stalled client failed')); });
            (window as any).__stalledApiClient = ws;
            return true;
        });
        expect(opened).toBe(true);

        // Wait for Glowing Bear's periodic hotlistsync poll (1 s in this test). Switching
        // buffers would fetch lines, and any inbound request makes WeeChat clear the
        // transient entry again before the poll is answered — so stay idle here.
        await wait(3000);

        await expect(relayItem.getByTestId('unread-badge')).toHaveCount(0);

        await page.evaluate(() => (window as any).__stalledApiClient?.close());
        await wait(2000);
        await expect(relayItem.getByTestId('unread-badge')).toHaveCount(0);
    });
});
