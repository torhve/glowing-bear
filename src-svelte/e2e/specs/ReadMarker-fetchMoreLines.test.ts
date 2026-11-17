import { test, expect } from '@playwright/test';
import { createConnectedPage } from '../fixtures/auth';
import { waitForBuffer, switchToBuffer } from '../helpers/buffers';
import { disconnect, reconnect } from '../helpers/connection';
import { irc } from '../helpers/irc-control';
import { setupEffectOrphanFilter } from '../helpers/pageerror';
import { waitForChatSettled } from '../helpers/waits';
import { closeSpecChatChannel, openSpecChatChannel } from '../helpers/spec-chat-channel';

let page: import('@playwright/test').Page;


test.describe.configure({ mode: 'serial' });

// The app asks each relay for `maxBufferLines` lines: two screenfuls plus ten, clamped to
// [200, 1000] (src-svelte/src/lib/stores/models.ts:871-876). A buffer offers a page upward only
// when it holds more than that window, and #glowing-bear holds only what the fixture's last run
// left there — measured as 4 rows on a fresh fixture, and more on a long-lived one. Both halves
// of that are a lie to assert against, so this file fills its own channels and pages in those.
//
// Each test that pages gets its own channel. Paging widens the app's retained window for that
// buffer only, so a shared channel would leave the second and third test looking at a buffer the
// earlier tests had already widened past its depth: no page to fetch, and an assertion about
// paging that never paged.
const SEND_BATCH = 60;
// The fill bound is tied to the app's floor rather than chosen on its own: `maxBufferLines`
// clamps to at least 200 lines (models.ts:871-876), so 400 planted lines is the least depth that
// offers a page for any viewport. If that floor rises, FILL_LIMIT has to rise with it — the
// failure below says which bound was reached.
const RETAINED_WINDOW_FLOOR = 200;
const FILL_LIMIT = RETAINED_WINDOW_FLOOR * 2;
const channels: string[] = [];

test.beforeAll(async ({ browser }) => {
    page = await createConnectedPage(browser);
    setupEffectOrphanFilter(page);
});

test.afterAll(async () => {
    // Leave a stable buffer first: closing the buffer the app is showing moves it somewhere the
    // next spec did not choose.
    await switchToBuffer(page, '#glowing-bear').catch(() => {});
    for (const channel of channels) closeSpecChatChannel(channel);
    await page.close();
});

/**
 * Join a channel for this test, fill it past the app's retained window, and return it.
 *
 * The fill is proved by the fetch-more control. Without that control the test's precondition is
 * absent and a paging assertion checks nothing: `clickFetchMore` would report "the app stopped
 * offering a page" and a test that only counts pages would fail on the arrangement, not on the
 * product.
 */
async function openPagedChannel(label: string): Promise<string> {
    const channel = await openSpecChatChannel(page, label);
    channels.push(channel);

    // State which buffer this is filling. `/join` answers in the buffer the command was typed in:
    // measured, the sidebar row then read 361 unread while the chat was still showing
    // #glowing-bear, so the control below was polled in a buffer that held none of these lines.
    await switchToBuffer(page, channel);

    const fetchMore = page.getByTestId('fetch-more-lines');
    for (let sent = 0; sent < FILL_LIMIT; sent += SEND_BATCH) {
        for (let i = 0; i < SEND_BATCH; i++) {
            await irc.sendMessage(channel, `${label}-depth-${sent + i}`);
        }
        if (await fetchMore.waitFor({ state: 'visible', timeout: 4000 }).then(() => true, () => false)) return channel;
    }
    await expect(
        fetchMore,
        `planting ${FILL_LIMIT} lines into ${channel} left no page to fetch: the app's retained window is not smaller than that fill`,
    ).toBeVisible({ timeout: 15000 });
    return channel;
}

/**
 * Snapshot of the rendered read-marker state. `needle` (when given) identifies
 * the first line the test knows to be unread, which is what the separator has
 * to sit directly above.
 */
function chatState(needle?: string) {
    return page.evaluate((needle) => {
        const container = document.querySelector('[data-testid="chat-messages"]');
        if (!container) return { lines: 0, hasReadmarker: false };
        const marker = container.querySelector('.readmarker');
        const ordered = Array.from(container.querySelectorAll('[data-testid="bufferline-row"], .readmarker'));
        const rows = Array.from(container.querySelectorAll('[data-testid="bufferline-row"]'));
        const firstUnread = needle ? rows.findIndex((row) => row.textContent?.includes(needle)) : -1;
        // A buffer with no separator has no position in the order. indexOf(marker) would already
        // answer -1 for a null marker, and every use of this index below is guarded on the marker
        // existing, so the -1 is written where the type can see it.
        const markerIndex = marker ? ordered.indexOf(marker) : -1;
        const badge = marker?.querySelector('.readmarker-badge')?.textContent?.trim() ?? null;
        return {
            lines: rows.length,
            hasReadmarker: !!marker,
            // A fully read buffer keeps the separator at the end of the list.
            markerAtEnd: !!marker && markerIndex === ordered.length - 1,
            // A separator above every loaded line means the whole buffer is
            // being treated as unread — the reported bug.
            markerAboveAllLines: !!marker && markerIndex === 0,
            markerImmediatelyBeforeFirstUnread:
                !!marker && firstUnread >= 0 && ordered[markerIndex + 1] === rows[firstUnread],
            badge,
            badgeCount: Number(badge?.replace(/\D/g, '') ?? 0),
        };
    }, needle);
}

// Commit a clean reading state: view the channel at the bottom, then leave it.
async function markBufferRead(channel: string) {
    await switchToBuffer(page, channel);
    await page.locator('[data-testid="chat-messages"]').evaluate((el) => {
        el.scrollTop = el.scrollHeight;
    });
    await waitForChatSettled(page);
    await switchToBuffer(page, '#glowing-bear');
}

/**
 * Page upward once. Returns false when the app has stopped offering a page: the
 * buffer's history is exhausted, or it reached the depth ceiling and the control
 * became a label. On a long-lived channel either is legitimate, and a click can
 * land exactly on that swap, so a vanished control is verified rather than assumed.
 */
async function clickFetchMore(): Promise<boolean> {
    // The control sits at the TOP of the message list. While the view is still
    // pinning or still has frames queued, that row keeps moving, and Playwright
    // times out clicking an element that was on screen the entire time — which is
    // how this spec failed once the channel was warmed: "the fetch-more control
    // vanished", with no `history-capped` anywhere. Settling first is the spec's
    // own no-sleep rule applied honestly: wait for the condition the click needs.
    await waitForChatSettled(page);
    const capped = page.getByTestId('history-capped');
    if (await capped.count() > 0) return false;
    const fetchButton = page.getByTestId('fetch-more-lines');
    if (!(await fetchButton.isVisible().catch(() => false))) return false;
    try {
        await fetchButton.click({ timeout: 10000 });
    } catch {
        if (await capped.count() > 0) return false;
        throw new Error('the fetch-more control vanished without reporting the history ceiling');
    }
    return true;
}

// Loading older history only widens the retained window. It must not turn the
// lines it loads into unread ones: the separator and its "N new" badge stay
// exactly where they were.
test('first visit in a fresh session does not mark the whole buffer unread', async () => {
    const channel = await openPagedChannel('fresh');
    await disconnect(page);
    await reconnect(page, { preserveLastBuffer: true });
    await waitForBuffer(page, channel, 15000);
    await switchToBuffer(page, channel);
    await expect.poll(async () => (await chatState()).lines, { timeout: 15000 }).toBeGreaterThan(5);

    const first = await chatState();
    expect(first.markerAboveAllLines).toBe(false);

    await clickFetchMore();
    await expect.poll(async () => (await chatState()).lines, { timeout: 15000 }).toBeGreaterThan(first.lines);

    const after = await chatState();
    expect(after.markerAboveAllLines).toBe(false);
    expect(after.badgeCount).toBe(first.badgeCount);
});

test('fetching older history does not create a read marker on a read buffer', async () => {
    const channel = await openPagedChannel('read');
    await markBufferRead(channel);
    await switchToBuffer(page, channel);

    const before = await chatState();
    expect(before.markerAtEnd).toBe(true);
    expect(before.badge).toBeNull();

    // A capped buffer re-trims what it prepends, so the row count is not a
    // reliable signal here (growth is asserted in the previous test). What must
    // not change is the separator: still the last thing in the list, nothing
    // counted as new.
    await clickFetchMore();
    await expect.poll(chatState).toMatchObject({ markerAtEnd: true, badge: null });
    await clickFetchMore();
    await expect.poll(chatState).toMatchObject({ markerAtEnd: true, badge: null });
});

test('fetching older history keeps an existing marker and its badge fixed', async () => {
    const channel = await openPagedChannel('marker');
    await markBufferRead(channel);
    // Create unread lines while viewing another buffer.
    const runId = Date.now();
    const unread = Array.from({ length: 3 }, (_, i) => `fetchmore-unread-${runId}-${i}`);
    for (const text of unread) await irc.sendMessage(channel, text);

    await switchToBuffer(page, channel);
    await expect.poll(() => chatState(unread[0]), { timeout: 15000 }).toMatchObject({
        hasReadmarker: true,
        markerImmediatelyBeforeFirstUnread: true,
    });

    const before = await chatState(unread[0]);
    expect(before.badgeCount).toBeGreaterThanOrEqual(unread.length);

    // Page upward until the app stops offering more. Every page must leave the
    // separator and its badge exactly where they were.
    let pages = 0;
    for (let step = 0; step < 6; step++) {
        if (!(await clickFetchMore())) break;
        pages++;
        await expect.poll(() => chatState(unread[0]), { timeout: 15000 }).toMatchObject({
            hasReadmarker: true,
            badge: before.badge,
            markerImmediatelyBeforeFirstUnread: true,
        });
    }
    expect(pages, `${channel} was filled past the app's window, so it should offer at least one page`).toBeGreaterThanOrEqual(1);
});
