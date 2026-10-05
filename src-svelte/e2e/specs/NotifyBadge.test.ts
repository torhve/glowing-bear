import { test, expect } from '@playwright/test';
import { connectToWeechat, disconnect, reconnect, waitForAppReady } from '../helpers/connection';
import { weechatFifoCommand } from '../helpers/weechat-fifo';
import { switchToBuffer } from '../helpers/buffers';
import { setupEffectOrphanFilter } from '../helpers/pageerror';

// Sidebar badge parity with WeeChat notify levels (pi-bridge scenario):
// notify_highlight lines in an inactive buffer must badge it, notify_none
// lines must not. Serial: sends channel messages via the gbtest FIFO.

test.describe.configure({ mode: 'serial' });

test.describe('Sidebar unread badge vs notify level', () => {
    test('notify_highlight line in an inactive buffer shows a badge', async ({ page }) => {
        setupEffectOrphanFilter(page);
        await page.goto('/');
        await waitForAppReady(page);
        await connectToWeechat(page);

        const gb = page.getByTestId('buffer-item').filter({ hasText: 'glowing-bear' });

        // Read #glowing-bear, then leave it inactive (it also becomes the
        // previous buffer — the hotlist poll must still count new lines).
        await switchToBuffer(page, 'glowing-bear');
        await switchToBuffer(page, 'weechat');
        await expect(gb.getByTestId('unread-badge')).toHaveCount(0);

        const marker = `E2E-NOTIFY-HL-${Date.now()}`;
        test.expect(weechatFifoCommand(`print -buffer #glowing-bear -tags notify_highlight ${marker}`)).toBe(true);

        // Tally is live (line event), not poll-delayed.
        await expect(gb.getByTestId('unread-badge')).toHaveText('1', { timeout: 8000 });

        // The line itself is displayed.
        await switchToBuffer(page, 'glowing-bear');
        await expect(page.getByText(marker)).toBeVisible();
    });

    test('notify_none line in an inactive buffer shows no badge', async ({ page }) => {
        setupEffectOrphanFilter(page);
        await page.goto('/');
        await waitForAppReady(page);
        await connectToWeechat(page);

        const gb = page.getByTestId('buffer-item').filter({ hasText: 'glowing-bear' });

        await switchToBuffer(page, 'glowing-bear');
        await switchToBuffer(page, 'weechat');
        await expect(gb.getByTestId('unread-badge')).toHaveCount(0);

        const marker = `E2E-NOTIFY-NONE-${Date.now()}`;
        test.expect(weechatFifoCommand(`print -buffer #glowing-bear -tags notify_none,no_highlight ${marker}`)).toBe(true);

        // Give the live line event time to land while the buffer is still
        // inactive, then confirm it never badges, then confirm it rendered.
        await page.waitForTimeout(1500);
        await expect(gb.getByTestId('unread-badge')).toHaveCount(0);
        await switchToBuffer(page, 'glowing-bear');
        await expect(page.getByText(marker)).toBeVisible({ timeout: 8000 });
    });

    test('a highlight that arrived while disconnected badges after reconnect', async ({ page }) => {
        setupEffectOrphanFilter(page);
        await page.goto('/');
        await waitForAppReady(page);
        await connectToWeechat(page);

        const gb = page.getByTestId('buffer-item').filter({ hasText: 'glowing-bear' });

        // Read #glowing-bear and leave it inactive.
        await switchToBuffer(page, 'glowing-bear');
        await switchToBuffer(page, 'weechat');
        await expect(gb.getByTestId('unread-badge')).toHaveCount(0);

        // The line lands while the client is disconnected — the reconnecting
        // hotlist baseline must carry its count onto the badge. Pin the
        // headless window buffer to core first: WeeChat's hotlist_add_conditions
        // skip the window buffer when no relay client is connected, and which
        // buffer is "current" drifts across a shared warm fixture.
        await disconnect(page);
        test.expect(weechatFifoCommand('buffer 1')).toBe(true);
        const marker = `E2E-NOTIFY-RECONNECT-${Date.now()}`;
        test.expect(weechatFifoCommand(`print -buffer #glowing-bear -tags notify_highlight ${marker}`)).toBe(true);
        await page.waitForTimeout(500); // let WeeChat process the print

        await reconnect(page);
        await expect(gb.getByTestId('unread-badge')).toHaveText('1', { timeout: 10000 });

        // Read it so the shared fixture leaves no hotlist residue for later specs.
        await switchToBuffer(page, 'glowing-bear');
        await expect(gb.getByTestId('unread-badge')).toHaveCount(0);
        await switchToBuffer(page, 'weechat');
    });
});
