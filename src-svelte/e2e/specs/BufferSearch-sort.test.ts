import { test, expect, type Page } from '@playwright/test';
import { createConnectedPage } from '../fixtures/auth';
import { connectToWeechat, waitForAppReady } from '../helpers/connection';
import { setupEffectOrphanFilter } from '../helpers/pageerror';
import { switchToBuffer, waitForBuffer } from '../helpers/buffers';
import { irc } from '../helpers/irc-control';
import { waitForNoUnread, waitForUnreadAtLeast } from '../helpers/waits';
import { clearServerHotlist, relayInputOnBuffer } from '../helpers/relay-admin';

// Issue #14: the search dialog ranked every result by WeeChat buffer number, so a
// channel shouting at you could sit below a quiet one, while the hotlist strip
// beside it ranked by activity. The dialog now offers both orders.
//
// Serial: it sends channel messages and joins a channel in the shared gbtest relay.
test.describe.configure({ mode: 'serial' });

// #glowing-bear is the fixture's autojoined channel. #gbsortorder is joined by this
// spec, so its WeeChat buffer number is guaranteed to be the higher one — which is
// what makes the two orders disagree.
const READ_CHANNEL = '#glowing-bear';
const HOT_CHANNEL = '#gbsortorder';

let page: Page;


async function openSearch() {
    await page.getByTestId('search-button').click();
    await expect(page.getByTestId('buffer-search')).toBeVisible();
}

/**
 * Close with the dialog's own button, not Escape. `+page.svelte` treats two
 * Escapes inside 500 ms as the "leave" shortcut and disconnects the relay — a
 * spec that opens and closes the dialog twice in a row would otherwise drop the
 * session it is asserting on.
 */
async function closeSearch() {
    await page.getByTestId('buffer-search-close').click();
    await expect(page.getByTestId('buffer-search')).toBeHidden();
}

function searchRows(): Promise<string[]> {
    return page.$$eval('.buffer-search-item .buffer-search-shortname', (els) =>
        els.map((el) => (el.textContent ?? '').trim()),
    );
}

/**
 * Relative order only: gbtest's buffer set is not fixed (earlier specs leave buffers
 * behind), so absolute positions are not assertable. The dialog renders WeeChat's own
 * short name — `#glowing-bear`, sigil included — unlike the sidebar, which strips it,
 * so these names are compared exactly as the dialog prints them.
 */
async function expectRankedAbove(above: string, below: string) {
    const rows = await searchRows();
    const a = rows.indexOf(above);
    const b = rows.indexOf(below);
    expect(a, `${above} missing from search results ${JSON.stringify(rows)}`).toBeGreaterThanOrEqual(0);
    expect(b, `${below} missing from search results ${JSON.stringify(rows)}`).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(b);
}

async function sortModePressed(mode: 'number' | 'unread'): Promise<boolean> {
    const value = await page
        .getByTestId(`buffer-search-sort-${mode}`)
        .getAttribute('aria-pressed');
    return value === 'true';
}

test.beforeAll(async ({ browser }) => {
    page = await createConnectedPage(browser);
    setupEffectOrphanFilter(page);

    // A clean hotlist is the baseline both orders are read against.
    await clearServerHotlist();

    // A channel this spec joins is guaranteed a higher WeeChat buffer number than
    // #glowing-bear, which is what makes the two orders disagree. `/join` is only
    // valid on an irc buffer, and both the FIFO and the app's own command helper
    // execute in the core buffer, so it goes to the relay with #glowing-bear named
    // as the target buffer.
    await relayInputOnBuffer(`irc.gbtest.${READ_CHANNEL}`, `/join ${HOT_CHANNEL}`);
    await waitForBuffer(page, HOT_CHANNEL);
    await switchToBuffer(page, READ_CHANNEL);
    await waitForNoUnread(page, READ_CHANNEL);
});

test.afterAll(async () => {
    // Leave the shared relay as the other serial specs expect it. `/close` is only
    // valid on the channel's own buffer, so it is sent with that buffer named.
    await relayInputOnBuffer(`irc.gbtest.${HOT_CHANNEL}`, '/close').catch(() => {});
    await clearServerHotlist();
    await page.close();
});

test('search order: buffer order leaves an unread channel at its buffer number', async () => {
    const marker = `E2E-SORT-NUMBER-${Date.now()}`;
    await irc.sendMessage(HOT_CHANNEL, marker);
    await waitForUnreadAtLeast(page, HOT_CHANNEL, 1);

    await openSearch();
    await expectRankedAbove(READ_CHANNEL, HOT_CHANNEL);
    expect(await sortModePressed('number')).toBe(true);
    await closeSearch();
});

test('search order: unread first lifts that channel above the lower-numbered one', async () => {
    await openSearch();
    await page.getByTestId('buffer-search-sort-unread').click();

    await expectRankedAbove(HOT_CHANNEL, READ_CHANNEL);
    expect(await sortModePressed('unread')).toBe(true);
    expect(await sortModePressed('number')).toBe(false);
    await closeSearch();
});

test('search order: the chosen order survives a closed dialog and a reload', async () => {
    // Reopening the dialog is the ordinary path: the mode is not per-open state.
    await openSearch();
    await expectRankedAbove(HOT_CHANNEL, READ_CHANNEL);
    await closeSearch();

    // A reload is what a desktop window or a browser refresh produces: the mode has
    // to come back out of storage, not out of the component that chose it.
    await page.reload();
    await waitForAppReady(page);
    await connectToWeechat(page);

    await openSearch();
    await expectRankedAbove(HOT_CHANNEL, READ_CHANNEL);
    expect(await sortModePressed('unread')).toBe(true);

    // And the user can put it back.
    await page.getByTestId('buffer-search-sort-number').click();
    await expectRankedAbove(READ_CHANNEL, HOT_CHANNEL);
    await closeSearch();
});
