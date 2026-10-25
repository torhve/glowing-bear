import { test, expect } from '@playwright/test';
import { createConnectedPage } from '../fixtures/auth';
import { bufferItemForName, waitForBuffer, switchToBuffer } from '../helpers/buffers';
import { irc, sendSequence } from '../helpers/irc-control';
import { fixtureCommand } from '../helpers/relay-admin';
import { setupEffectOrphanFilter } from '../helpers/pageerror';
import { waitForChatSettled } from '../helpers/waits';

/**
 * A buffer trimmed to its line cap still accounts for every unread line.
 *
 * This exists because a unit-level measurement found `localUnread` freezing on a
 * capped buffer: the trim's overlap term is `min(linesToRemove, unreadStartIndex)`,
 * which subtracts exactly when the removed prefix and the unread tail are
 * disjoint, so on a buffer at its cap every arrival adds an unread line and
 * immediately cancels it. That much is true. Whether it reaches anyone is a
 * different question, because the badge is
 *
 *     max(localUnread, unread + notification)
 *
 * and WeeChat's hotlist counts are the other half. They turned out to be enough:
 * a buffer seeded past its cap and a buffer left shallow reported the same badge
 * for the same unread traffic. The local tally is redundant here, not broken
 * visible — which is the reason the inverted formula is recorded rather than
 * fixed.
 *
 * Both channels get their own channel, so neither measurement disturbs the shared
 * fixture, and the only thing allowed to differ between them is whether the
 * buffer had been trimmed.
 */

let page: import('@playwright/test').Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
    page = await createConnectedPage(browser);
    setupEffectOrphanFilter(page);
    await waitForBuffer(page, '#glowing-bear', 15000);
});

test.afterAll(async () => {
    // Both channels this spec joined outlive it: `/part` leaves the buffer behind on
    // this relay, and the fixture outlives the run, so a leftover is a sidebar row and
    // a hotlist entry the next run inherits. Closing by exact name is the only form
    // that worked (a `#gbm*` mask closed nothing).
    for (const label of ['capped', 'shallow']) {
        fixtureCommand(`buffer close irc.gbtest.#gbm${label}${STAMP}`);
    }
    await page.close();
});

const STAMP = Date.now();
const INCOMING = 25;

/**
 * Joined through the app's own input box, which is how the other specs that need
 * a second channel do it. A FIFO `irc join` was tried first: the write was
 * accepted, but no buffer appeared in the relay's own buffer list, so nothing
 * further was concluded from it.
 */
async function openChannel(name: string) {
    await irc.botJoin(name);

    const input = page.getByTestId('message-input');
    await switchToBuffer(page, '#glowing-bear');
    await input.click();
    await input.fill(`/join ${name}`);
    await input.press('Enter');
    await waitForBuffer(page, name, 20000);
}

async function badge(name: string): Promise<number> {
    // bufferItemForName, not a raw hasText: the list renders the trimmed name
    // (`gbmcapped…`), so filtering on `#gbmcapped…` matches nothing and every
    // read silently reports zero.
    const badge = bufferItemForName(page, name).getByTestId('unread-badge');
    if (await badge.count() === 0) return 0;
    return Number((await badge.first().textContent())?.trim() ?? '0');
}

async function renderedRows(): Promise<number> {
    return page.locator('[data-testid="bufferline-row"]').count();
}

/**
 * WeeChat splits a channel into `#name [1/3]` buffers when lines arrive faster
 * than its per-second limit. That would move unread counts onto buffers this spec
 * is not looking at, so a split is a broken measurement rather than a finding.
 */
async function assertNoSplitBuffers(name: string) {
    const split = await page.getByTestId('buffer-item').filter({ hasText: /\[\d+\/\d+\]/ }).count();
    expect(split, `seeding ${name} made WeeChat split channels; the reading is invalid`)
        .toBe(0);
}

async function measure(label: 'shallow' | 'capped', seedCount: number) {
    const channel = `#gbm${label}${STAMP}`;
    await openChannel(channel);

    // Seed while the channel is on screen. Active-buffer rows are never tallied
    // as unread, so seeding changes depth and nothing else.
    await switchToBuffer(page, channel);
    await sendSequence(channel, Array.from({ length: seedCount }, (_, i) => `${channel}-seed-${i}`));
    await waitForChatSettled(page);
    await assertNoSplitBuffers(channel);
    const rowsAfterSeed = await renderedRows();

    // Leave the channel: from here on, every line is unread.
    await switchToBuffer(page, 'gbtest');
    expect(await badge(channel), 'a freshly left channel starts with nothing unread').toBe(0);

    await sendSequence(channel, Array.from({ length: INCOMING }, (_, i) => `${channel}-in-${i}`));

    // Hotlist counts are polled rather than pushed, so this waits for the count
    // to arrive rather than for a fixed interval.
    await expect
        .poll(() => badge(channel), {
            timeout: 30000,
            message: `${label}: the badge never accounted for all ${INCOMING} unread lines`,
        })
        .toBe(INCOMING);

    // And it stays there: the seeded lines were read, so nothing else belongs in
    // the count.
    await waitForChatSettled(page);
    expect(await badge(channel), `${label}: the badge drifted past the unread traffic`)
        .toBe(INCOMING);

    return rowsAfterSeed;
}

test('a buffer trimmed to its line cap accounts for every unread line', async () => {
    const rows = await measure('capped', 400);
    // Without this the "capped" case is just the shallow case again: the seed has
    // to have been trimmed for the comparison to mean anything. 200 is the
    // screen-derived cap (max(200, 2 * linesPerScreen + 10)) at this viewport.
    expect(rows, 'the seed has to leave the buffer trimmed to its cap').toBeLessThan(400);
    expect(rows, 'a trimmed buffer sits at its cap, not below it').toBeGreaterThanOrEqual(200);
});

test('a buffer that was never trimmed accounts for the same unread traffic', async () => {
    const rows = await measure('shallow', 20);
    // The control: 20 seeded lines plus the IRC join and topic lines the server
    // adds on join, none of them trimmed away.
    expect(rows, 'the shallow case must not have been trimmed').toBeGreaterThanOrEqual(20);
});
