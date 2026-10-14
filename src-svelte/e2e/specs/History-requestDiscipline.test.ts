import { test, expect } from '@playwright/test';
import { connectToWeechat, setSettings, waitForAppReady } from '../helpers/connection';
import { switchToBuffer, waitForBuffer } from '../helpers/buffers';
import { waitForChatSettled, waitForRow } from '../helpers/waits';
import { sendSequence } from '../helpers/irc-control';
import { setupEffectOrphanFilter } from '../helpers/pageerror';

/**
 * A capped buffer must not hammer the relay with the same history request.
 *
 * The page's history gate used to ask "have we fetched enough?" with the buffer's
 * request cursor, and the display trim subtracted from that same cursor. At the
 * line cap the two cancelled every cycle, the gate stayed open forever, and one
 * ordinary test run was measured issuing 301 identical `lines=-100` requests.
 *
 * This asserts the observable shape of that failure — the same request repeated —
 * rather than a timing number, because the loop is invisible to the reader until
 * the relay is not.
 *
 * Note what this does NOT claim: upward paging past the display window is not a
 * supported behaviour on the API transport. No caller passes the `after` cursor, so
 * every history request asks for the newest N lines, and the trim keeps the newest
 * ones. A buffer already at its cap cannot reveal older lines by scrolling.
 */
test.describe('History request discipline', () => {
    test.describe.configure({ mode: 'serial' });

    test('a capped buffer at the top of the view does not repeat the same history fetch', async ({ page }) => {
        setupEffectOrphanFilter(page);

        // Registered before the app opens its socket: Playwright only reports
        // websockets created after the listener exists.
        const historyRequests: string[] = [];
        page.on('websocket', (ws) => {
            ws.on('framesent', (frame) => {
                const text = typeof frame.payload === 'string' ? frame.payload : '';
                // The lines parameter lives inside the request path string, not as a
                // JSON field: {"method":"GET","path":"/api/buffers/<id>/lines?lines=-100&…"}.
                // Keep only the path: every frame also carries a unique request_id,
                // which would make an identical request look distinct.
                const match = /\/api\/buffers\/\d+\/lines\?[^"]*/.exec(text);
                if (match) historyRequests.push(match[0]);
            });
        });

        await page.goto('http://localhost:8001/');
        await page.evaluate(() => localStorage.removeItem('gb-settings'));
        await page.reload();
        await waitForAppReady(page);
        await setSettings(page, { autoconnect: false });
        await connectToWeechat(page, '9010');
        await waitForBuffer(page, '#glowing-bear');
        await switchToBuffer(page, '#glowing-bear');

        const tag = `hammer-${Date.now()}`;
        // Push the buffer past its display cap so the trim is running continuously.
        const lines = Array.from({ length: 260 }, (_, i) => `${tag} ${String(i).padStart(3, '0')}`);
        await sendSequence('#glowing-bear', lines);
        await waitForRow(page, `${tag} 259`);
        await waitForChatSettled(page);

        const afterFlood = historyRequests.length;

        // Park at the top, which is where the history gate is re-checked on scroll.
        const chat = page.locator('[data-testid="chat-messages"]');
        for (let i = 0; i < 10; i++) {
            await chat.evaluate((el) => {
                el.scrollTop = 0;
                el.dispatchEvent(new Event('scroll', { bubbles: true }));
            });
            await waitForChatSettled(page);
        }

        const repeated = new Map<string, number>();
        for (const request of historyRequests) {
            repeated.set(request, (repeated.get(request) ?? 0) + 1);
        }
        const worst = repeated.size ? Math.max(...repeated.values()) : 0;

        expect(
            worst,
            `the same history window was requested ${worst} times (${historyRequests.length} total, ${afterFlood} during the flood)`,
        ).toBeLessThanOrEqual(3);
    });
});
