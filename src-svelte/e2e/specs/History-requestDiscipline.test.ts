import { test, expect, type Page } from '@playwright/test';
import { connectToWeechat, setSettings, waitForAppReady } from '../helpers/connection';
import { switchToBuffer, waitForBuffer } from '../helpers/buffers';
import { waitForChatSettled, waitForRow } from '../helpers/waits';
import { irc, sendSequence } from '../helpers/irc-control';
import { setupEffectOrphanFilter } from '../helpers/pageerror';

/**
 * A capped buffer must not hammer the relay with the same history request.
 *
 * The page's history gate used to ask "have we fetched enough?" with the buffer's
 * request cursor, and the display trim subtracted from that same cursor. At the
 * line cap the two cancelled every cycle, the gate stayed open forever, and one
 * ordinary test run was measured issuing 301 identical `lines=-100` requests.
 *
 * What it guards now: a deliberate page asks for the buffer's whole retainable
 * window, so once a page leaves the top line where it was, asking again cannot
 * reach anything older. That is the one exhaustion signal the client has — neither
 * relay reports running out of older content — and without it a reader parked at
 * the top re-issues the identical request on every scroll event. It was measured
 * doing exactly that 11 times at the 4,096 ceiling, because a page whose lines
 * WeeChat smart-filters leaves the buffer holding fewer lines than its cap, which
 * a "did the window fill its cap?" test reads as room to grow.
 *
 * This asserts the observable shape of the failure — the same request repeated —
 * rather than a timing number, because the loop is invisible to the reader until
 * the relay is not.
 *
 * It pages its own channel. Paging the shared #glowing-bear left that channel
 * unread in WeeChat's hotlist, and the next spec's fresh session then correctly
 * counted those lines as unread — which is how this spec once broke
 * ReadMarker-fetchMoreLines.
 */

const CHANNEL = '#history-discipline';
// Deeper than the 4,096 lines WeeChat retains per buffer, so the reader genuinely
// reaches the client's ceiling instead of running out of history first.
const SEED = 6000;

/** Type a line into the composer and press Enter, so WeeChat runs it in the active buffer. */
async function sendComposerLine(target: Page, text: string): Promise<void> {
    const input = target.getByTestId('message-input');
    await input.fill(text);
    await input.press('Enter');
    await expect(input, `the composer kept "${text}" instead of sending it`).toHaveValue('', { timeout: 5000 });
}

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

        // The bot joins first so the channel exists, then the app joins it: the
        // planted lines have to arrive while WeeChat is in the channel, or they
        // are not in its history at all.
        await irc.botJoin(CHANNEL);

        await page.goto('http://localhost:8001/');
        await page.evaluate(() => localStorage.removeItem('gb-settings'));
        await page.reload();
        await waitForAppReady(page);
        await setSettings(page, { autoconnect: false });
        await connectToWeechat(page, '9010');

        // `/join` is an IRC command: WeeChat refuses it on core, so it goes
        // through the composer while a channel buffer is active.
        await waitForBuffer(page, '#glowing-bear', 15000);
        await switchToBuffer(page, '#glowing-bear');
        await sendComposerLine(page, `/join ${CHANNEL}`);
        await waitForBuffer(page, CHANNEL, 15000);

        // The view deliberately stays on #glowing-bear while the plant runs, so
        // the lines arrive later as a history fetch instead of as a live flood.
        const tag = `hammer-${Date.now()}`;
        const lines = Array.from({ length: SEED }, (_, i) => `${tag} ${String(i).padStart(4, '0')}`);
        await sendSequence(CHANNEL, lines);

        await switchToBuffer(page, CHANNEL);
        await waitForChatSettled(page, 300, 30000);
        await waitForRow(page, `${tag} ${String(SEED - 1).padStart(4, '0')}`);

        const afterFlood = historyRequests.length;

        const chat = page.locator('[data-testid="chat-messages"]');
        try {
            // Park at the top, which is where the history gate is re-checked on scroll.
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
        } finally {
            // Close the channel. `/part` leaves the buffer and its history behind
            // (measured against the live relay: /part keeps the buffer, /buffer
            // close removes it), and a leftover deep unread channel is what made
            // KeyboardShortcuts-altA land on this spec's channel instead of the
            // buffer that test was about.
            await switchToBuffer(page, CHANNEL).catch(() => undefined);
            await sendComposerLine(page, '/buffer close').catch(() => undefined);
        }
    });
});
