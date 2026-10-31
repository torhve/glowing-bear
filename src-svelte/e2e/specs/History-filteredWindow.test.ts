import { test, expect, type Page } from '@playwright/test';
import { pbkdf2Sync } from 'node:crypto';
import { connectLegacyToWeechat, connectToWeechat, setSettings, waitForAppReady, clearSettingsBeforeLoad } from '../helpers/connection';
import { switchToBuffer } from '../helpers/buffers';
import { irc, sendSequence } from '../helpers/irc-control';
import { fixtureCommand } from '../helpers/relay-admin';
import { openSpecChatChannel, closeSpecChatChannel } from '../helpers/spec-chat-channel';
import { waitForChatSettled } from '../helpers/waits';
import { setupEffectOrphanFilter } from '../helpers/pageerror';

/**
 * A channel whose newest history window is entirely hidden must be paged deeper,
 * not re-asked.
 *
 * WeeChat counts a line request over RAW lines — `lines=-N` on the API relay,
 * `last_line(-N)` on the legacy one — and answers with a page whose filtered
 * entries carry `displayed: false`. Those lines are never stored, so the buffer
 * stays empty while the relay keeps saying "here are the N lines you asked for".
 * The page's history gate asks "does this buffer render anything?", and an empty
 * one re-fires.
 *
 * Measured on main with this spec's arrangement (4 visible lines behind 250
 * filtered ones, on a channel the spec owns): the legacy transport issued 2 844
 * history requests, 2 825 of them the identical `last_line(-100)`, and painted 0
 * rows. That is the CPU the report this behaviour changed came from, and it is
 * invisible in the app until the relay is not.
 *
 * Both transports are covered because they answer a filtered window differently —
 * the API relay marks the hidden lines, the legacy one has been measured never
 * sending `displayed: false` at all (SmartFilter.test.ts) — and the gate must
 * terminate on both. gbtest runs the API relay on 9010 and the legacy relay on
 * 9001; a spec connects one or the other, never both.
 *
 * The channel and the filter belong to this spec. A filter is fixture state that
 * survives a run, and the shared #glowing-bear channel carries join/part lines
 * other specs count on.
 */

const HIDDEN = `gbhidden${Date.now().toString(36)}`;
const HIDDEN_LINES = 250;
const VISIBLE_LINES = 4;

function authHeader(): string {
    const ts = Math.floor(Date.now() / 1000);
    const hash = pbkdf2Sync('testpassword123', String(ts), 100000, 32, 'sha256').toString('hex');
    return 'Basic ' + Buffer.from(`hash:pbkdf2+sha256:${ts}:100000:${hash}`).toString('base64');
}

/**
 * What the relay itself says about this channel's newest window. Asserted before
 * anything client-side, because "0 rows" only means something when the relay is
 * known to hold lines worth showing.
 */
async function readRelayWindow(needle: string): Promise<{ raw: number; hidden: number; visible: number }> {
    const headers = { Authorization: authHeader() };
    const buffers = (await (await fetch('http://127.0.0.1:9010/api/buffers', { headers })).json()) as Array<{
        id: number;
        name: string;
    }>;
    const buffer = buffers.find((b) => (b.name ?? '').includes(needle));
    if (!buffer) return { raw: -1, hidden: -1, visible: -1 };
    const lines = (await (
        await fetch(`http://127.0.0.1:9010/api/buffers/${buffer.id}/lines?lines=-400&keys=id,displayed`, { headers })
    ).json()) as Array<{ displayed: boolean }>;
    const hidden = lines.filter((l) => l.displayed === false).length;
    return { raw: lines.length, hidden, visible: lines.length - hidden };
}

/** History windows the app put on the wire, per window. */
function watchHistoryRequests(page: Page): Map<string, number> {
    const windows = new Map<string, number>();
    // Registered before the app opens its socket: Playwright only reports websockets
    // created after the listener exists.
    page.on('websocket', (ws) => {
        ws.on('framesent', (frame) => {
            const text = typeof frame.payload === 'string' ? frame.payload : '';
            for (const window of text.match(/last_line\(-\d+\)/g) ?? []) {
                windows.set(window, (windows.get(window) ?? 0) + 1);
            }
            for (const window of text.match(/lines\?lines=-\d+/g) ?? []) {
                windows.set(window, (windows.get(window) ?? 0) + 1);
            }
        });
    });
    return windows;
}

function shape(windows: Map<string, number>): string {
    const total = [...windows.values()].reduce((sum, count) => sum + count, 0);
    return `${total} history requests (${[...windows.entries()].map(([w, c]) => `${w}×${c}`).join(', ')})`;
}

async function arrangeHiddenWindow(page: Page, label: string): Promise<{ channel: string; filter: string }> {
    const channel = await openSpecChatChannel(page, label);
    const filter = `gbhide${Date.now().toString(36)}`;

    // Scoped to this spec's channel so the shared fixture keeps showing join/part
    // lines to every other spec. The core-buffer echo is the proof WeeChat applied
    // the command: a FIFO write alone proves only submission.
    fixtureCommand(`filter add ${filter} *${channel.slice(1)}* * ^${HIDDEN}`);
    await switchToBuffer(page, 'weechat');
    await expect(page.getByText(`Filter "${filter}" added`, { exact: false })).toBeVisible({ timeout: 10000 });

    // Visible lines first, then a filtered window deeper than the newest window the
    // app opens a buffer with, so the newest window the relay answers is entirely
    // hidden and the visible lines sit behind it.
    for (let i = 0; i < VISIBLE_LINES; i++) {
        await irc.sendMessage(channel, `visible line ${i}`);
    }
    await sendSequence(
        channel,
        Array.from({ length: HIDDEN_LINES }, (_, i) => `${HIDDEN} ${String(i).padStart(3, '0')}`),
    );

    return { channel, filter };
}

async function assertHuntTerminates(page: Page, channel: string, windows: Map<string, number>): Promise<void> {
    await switchToBuffer(page, channel);
    await waitForChatSettled(page, 300, 30000);

    const relay = await readRelayWindow(channel.slice(1));
    expect(relay.hidden, `the arrangement is not what this spec planted: relay window ${relay.raw} raw / ${relay.hidden} hidden / ${relay.visible} visible`).toBeGreaterThanOrEqual(
        HIDDEN_LINES,
    );

    // Re-trigger the gate the way the app does: switching buffers is the route that
    // re-checks whether a buffer renders anything. A loop shows up here as the same
    // window repeated on every switch, so this stands in for waiting a fixed number
    // of seconds and hoping a loop appears.
    for (let round = 0; round < 6; round++) {
        await switchToBuffer(page, 'weechat');
        await switchToBuffer(page, channel);
        await waitForChatSettled(page, 300, 30000);
    }

    const counts = [...windows.values()];
    const worst = counts.length ? Math.max(...counts) : 0;
    const total = counts.reduce((sum, count) => sum + count, 0);
    const rows = await page.locator('[data-testid="bufferline-row"]').count();

    expect(
        worst,
        `the same history window was requested ${worst} times — ${shape(windows)}; relay window ${relay.raw} raw / ${relay.hidden} hidden / ${relay.visible} visible`,
    ).toBeLessThanOrEqual(2);

    expect(
        total,
        `a hunt that cannot reach a visible line must still bound itself — ${shape(windows)}`,
    ).toBeLessThan(30);

    expect(
        rows,
        `the channel rendered ${rows} rows while the relay holds ${relay.visible} visible lines behind ${relay.hidden} hidden ones — ${shape(windows)}`,
    ).toBeGreaterThanOrEqual(VISIBLE_LINES);
}

test.describe('Filtered-window history paging', () => {
    test.describe.configure({ mode: 'serial' });
    test.setTimeout(180000);

    const open: Array<{ channel: string; filter: string }> = [];

    test('the API relay hunt reaches the hidden window without re-asking it', async ({ page }) => {
        setupEffectOrphanFilter(page);
        const windows = watchHistoryRequests(page);

        await clearSettingsBeforeLoad(page);
        await page.goto('/');
        await waitForAppReady(page);
        await setSettings(page, { autoconnect: false });
        await connectToWeechat(page, '9010');

        const arranged = await arrangeHiddenWindow(page, 'fwindow-api');
        open.push(arranged);
        await assertHuntTerminates(page, arranged.channel, windows);
    });

    test('the legacy transport hunt reaches the hidden window without re-asking it', async ({ page }) => {
        setupEffectOrphanFilter(page);
        const windows = watchHistoryRequests(page);

        await clearSettingsBeforeLoad(page);
        await page.goto('/');
        await waitForAppReady(page);
        await setSettings(page, { autoconnect: false });
        await connectLegacyToWeechat(page);

        const arranged = await arrangeHiddenWindow(page, 'fwindow-legacy');
        open.push(arranged);
        await assertHuntTerminates(page, arranged.channel, windows);
    });

    test.afterAll(async () => {
        // The filter is fixture state that survives the run, and `/part` leaves a
        // joined buffer behind on this relay: both are closed by exact name.
        for (const { channel, filter } of open) {
            try {
                fixtureCommand(`filter del ${filter}`);
            } catch {
                /* fixture already gone */
            }
            try {
                await irc.botPart(channel);
            } catch {
                /* fixture already gone */
            }
            closeSpecChatChannel(channel);
        }
    });
});
