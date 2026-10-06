import { test, expect } from '@playwright/test';
import { createConnectedPage } from '../fixtures/auth';
import { waitForBuffer, switchToBuffer } from '../helpers/buffers';
import { disconnect, reconnect } from '../helpers/connection';
import { irc } from '../helpers/irc-control';
import { setupEffectOrphanFilter } from '../helpers/pageerror';

let page: import('@playwright/test').Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
    page = await createConnectedPage(browser);
    setupEffectOrphanFilter(page);
    await waitForBuffer(page, '#glowing-bear', 15000);
});

test.afterAll(async () => {
    await page.close();
});

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
        const markerIndex = ordered.indexOf(marker);
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

// Commit a clean reading state: view #glowing-bear at the bottom, then leave.
// gbtest persists across specs, so the channel may already carry unread.
async function markBufferRead() {
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
    await page.locator('[data-testid="chat-messages"]').evaluate((el) => {
        el.scrollTop = el.scrollHeight;
    });
    await waitForBuffer(page, 'gbtest', 10000);
    await switchToBuffer(page, 'gbtest');
}

async function clickFetchMore() {
    const fetchButton = page.getByTestId('fetch-more-lines');
    await expect(fetchButton).toBeVisible({ timeout: 10000 });
    await fetchButton.click();
}

// Loading older history only widens the retained window. It must not turn the
// lines it loads into unread ones: the separator and its "N new" badge stay
// exactly where they were.
test('first visit in a fresh session does not mark the whole buffer unread', async () => {
    await disconnect(page);
    await reconnect(page, { preserveLastBuffer: true });
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
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
    await markBufferRead();
    await switchToBuffer(page, '#glowing-bear');

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
    await markBufferRead();
    // Create unread lines while viewing another buffer.
    await switchToBuffer(page, 'gbtest');
    const runId = Date.now();
    const unread = Array.from({ length: 3 }, (_, i) => `fetchmore-unread-${runId}-${i}`);
    for (const text of unread) await irc.sendMessage('#glowing-bear', text);

    await switchToBuffer(page, '#glowing-bear');
    await expect.poll(() => chatState(unread[0]), { timeout: 15000 }).toMatchObject({
        hasReadmarker: true,
        markerImmediatelyBeforeFirstUnread: true,
    });

    const before = await chatState(unread[0]);
    expect(before.badgeCount).toBeGreaterThanOrEqual(unread.length);

    await clickFetchMore();
    await expect.poll(() => chatState(unread[0]), { timeout: 15000 }).toMatchObject({
        hasReadmarker: true,
        badge: before.badge,
        markerImmediatelyBeforeFirstUnread: true,
    });
    await clickFetchMore();
    await expect.poll(() => chatState(unread[0]), { timeout: 15000 }).toMatchObject({
        hasReadmarker: true,
        badge: before.badge,
        markerImmediatelyBeforeFirstUnread: true,
    });
});
