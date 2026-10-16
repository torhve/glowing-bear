import { test, expect, type Page } from '@playwright/test';
import { createConnectedPage } from '../fixtures/auth';
import { setupEffectOrphanFilter } from '../helpers/pageerror';
import { waitForBuffer, switchToBuffer } from '../helpers/buffers';
import { waitForChatSettled } from '../helpers/waits';
import { irc, sendSequence } from '../helpers/irc-control';

/**
 * Paging stops where WeeChat stops, and says so.
 *
 * The depth ceiling is 4096 because that is WeeChat's own default
 * history.max_buffer_lines_number: plant more than that into a channel and the
 * relay can still hand back 4096 and no more. So a reader who keeps going upward
 * reaches a wall that is not the relay running out of history but the client and
 * WeeChat agreeing on the depth — and the control has to report that rather than
 * offer a click that would re-request the window it already holds.
 *
 * The plant is deliberately deeper than the ceiling. With a shallower plant the
 * relay answers a wide request with fewer lines than were asked for, the app
 * correctly concludes the history is exhausted, and the wall under test never
 * appears at all.
 *
 * It pages in its own channel for the same reason ScrollbackDepth does: the shared
 * channel is cleared and refilled by other specs, which would make this spec's
 * premises depend on which specs ran before it.
 */

const CHANNEL = '#scrollback-ceiling';
/** Deeper than WeeChat's per-buffer default, so the wall reached is the ceiling. */
const SEED = 6000;
/** Fixed for the whole file so the planted rows are countable. */
const STAMP = `ceiling-${Date.now()}`;

let page: Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
    // The bot joins first so the channel exists, then the app joins it: the
    // planted lines have to arrive while WeeChat is in the channel, or they are
    // not in its history at all.
    await irc.botJoin(CHANNEL);
    page = await createConnectedPage(browser, { port: '9010' });
    setupEffectOrphanFilter(page);
    // `/join` is an IRC command: WeeChat refuses it on core, so it goes through
    // the composer while a channel buffer is active.
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
    await sendComposerLine(page, `/join ${CHANNEL}`);
    await waitForBuffer(page, CHANNEL, 15000);
    // Deliberately stays on #glowing-bear: WeeChat now holds the channel, but the
    // browser does not view it while the plant runs, so 6,000 lines arrive as a
    // history fetch later instead of a live flood the view has to render.
    await waitForChatSettled(page);
});

test.afterAll(async () => {
    // Close the channel this spec created, so its 6,000 planted lines do not stay
    // in WeeChat as a deep unread buffer that other specs then have to compete with
    // for global state. See the note in ScrollbackDepth.test.ts.
    if (!page) return;
    await switchToBuffer(page, CHANNEL).catch(() => undefined);
    await sendComposerLine(page, '/buffer close').catch(() => undefined);
});

/** Type a line into the composer and press Enter, so WeeChat runs it in the active buffer. */
async function sendComposerLine(target: Page, text: string): Promise<void> {
    const input = target.getByTestId('message-input');
    await input.fill(text);
    await input.press('Enter');
    await expect(input, `the composer kept "${text}" instead of sending it`).toHaveValue('', { timeout: 5000 });
}

function rowCount(target: Page = page): Promise<number> {
    return target.locator('[data-testid="bufferline-row"]').count();
}

/** Arrive at the channel from another buffer, which is what builds a history window. */
async function visitChannel(target: Page = page) {
    await switchToBuffer(target, CHANNEL);
    // The plant is 6,000 lines, and WeeChat streams them as live events into the
    // buffer even while another buffer is on screen. Arriving mid-drain needs more
    // than the default settle window on a loaded machine.
    await waitForChatSettled(target, 300, 30000);
}

test('a reader paged to the depth ceiling is told so instead of offered an empty page', async () => {
    await sendSequence(CHANNEL, Array.from({ length: SEED }, (_, i) => `${STAMP} ${i}`));
    // Arriving from another buffer is what builds a history window; a buffer the
    // reader never entered has no window yet.
    await visitChannel();

    const capped = page.getByTestId('history-capped');
    const button = page.getByTestId('fetch-more-lines');

    // Five doublings of a screen window is the whole ladder; allow slack so a
    // viewport that derives a smaller window still finishes.
    let pages = 0;
    while (pages < 10) {
        if (await capped.count() > 0) break;
        if (await button.count() === 0) break;
        await button.click();
        await waitForChatSettled(page);
        pages++;
    }

    expect(await capped.count(), `the control never reported the ceiling after ${pages} pages`).toBe(1);
    await expect(button, 'a page at the ceiling fetches nothing, so it must not stay offered').toHaveCount(0);

    // A deep window has to be behind the label, but not exactly 4,096 rows:
    // WeeChat's smart filter drops lines from the page, so a buffer at the ceiling
    // holds fewer lines than the cap allows (4,090 of 4,096 on the shared fixture).
    expect(await rowCount(page), 'the ceiling was reported without a deep window behind it')
        .toBeGreaterThanOrEqual(3000);
});
