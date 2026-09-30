// Regression guard for issue #8: relay.list must never show up as unread.
// WeeChat hotlists relay.list itself whenever a relay client connects or
// disconnects (relay_buffer_refresh), so a client that connects and stays quiet
// leaves it in the hotlist long enough for Glowing Bear's next poll to catch it.
import { test, expect } from '@playwright/test';
import net from 'node:net';
import { setupEffectOrphanFilter } from '../helpers/pageerror';
import { connectToWeechat, waitForAppReady } from '../helpers/connection';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test.describe('relay.list unread (issue #8)', () => {
    test.describe.configure({ mode: 'serial' });
    test.setTimeout(180000);

    test('a connecting relay client does not mark relay.list unread', async ({ page }) => {
        setupEffectOrphanFilter(page);
        await page.goto('/');
        await waitForAppReady(page);
        await connectToWeechat(page);
        await wait(4000);

        const relayItem = page.getByTestId('buffer-item').filter({ hasText: 'relay.list' }).first();
        await expect(relayItem).toBeVisible();
        await expect(relayItem.getByTestId('unread-badge')).toHaveCount(0);

        // A relay client that is accepted but never sends keeps relay.list in
        // WeeChat's hotlist: nothing arrives to clear it again.
        const stalled = net.connect(9001, '127.0.0.1');
        await new Promise<void>((resolve) => stalled.on('connect', () => resolve()));

        // Wait for Glowing Bear's periodic hotlistsync poll (every 15 s). Switching
        // buffers would fetch lines, and any inbound request makes WeeChat clear the
        // transient entry again before the poll is answered — so stay idle here.
        await wait(20000);

        await expect(relayItem.getByTestId('unread-badge')).toHaveCount(0);

        stalled.destroy();
        await wait(3000);
        await expect(relayItem.getByTestId('unread-badge')).toHaveCount(0);
    });
});
