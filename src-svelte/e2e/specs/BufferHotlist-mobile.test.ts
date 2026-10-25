import { test, expect } from '@playwright/test';
import { createConnectedPage } from '../fixtures/auth';
import { botSay, botPm } from '../helpers/messages';
import { switchToBuffer, switchToBufferMobile, waitForBufferMobile } from '../helpers/buffers';
import { irc } from '../helpers/irc-control';
import { fixtureCommand } from '../helpers/relay-admin';
import { setupEffectOrphanFilter } from '../helpers/pageerror';

declare global {
    interface Window {
        __showBufferListOnMobile?: () => void;
        __hideBufferListOnMobile?: () => void;
    }
}

let page: import('@playwright/test').Page;

// A channel name long enough to pass the trim point the hotlist strip states for itself
// (BufferHotlist.svelte, truncateName: past 18 characters, cut to 15 plus an ellipsis). The stamp
// is inside the first 15 characters, so a leftover from an aborted run cannot be mistaken for this
// run's buffer, and the `#gb` prefix puts it inside the mask globalTeardown already cleans.
const LONG_CHANNEL = `#gblong${Date.now()}`;
test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
    page = await createConnectedPage(browser);
    await page.setViewportSize({ width: 375, height: 667 });
    setupEffectOrphanFilter(page);
});

test.afterAll(async () => {
    // The channel this spec joins has to leave the fixture the way it was found. `/part` leaves
    // the buffer behind on this relay, and a leftover row is unread the next run inherits, so the
    // only cleanup that has ever worked here is closing by exact name.
    fixtureCommand(`buffer close irc.gbtest.${LONG_CHANNEL}`);
    await page.close();
});

// Clear leftover unread from previous serial tests so each test starts with
// an empty hotlist. Pressing Alt+A repeatedly jumps to each unread buffer,
// which clears its counts via setActiveBuffer — natural user action.
async function clearAllUnread(p: typeof page) {
    const orig = (await p.viewportSize()) || { width: 375, height: 667 };
    await p.setViewportSize({ width: 1280, height: 720 });
    await p.evaluate(() => window.dispatchEvent(new Event('resize')));
    // Alt+A jumps to the next unread buffer, which clears its count. Keep jumping while
    // a badge is still drawn, instead of pressing a fixed number of times and hoping.
    let presses = 0;
    await expect
        .poll(
            async () => {
                const remaining = await p.getByTestId('unread-badge').count();
                if (remaining > 0 && presses < 15) {
                    presses++;
                    await p.keyboard.press('Alt+A');
                }
                return remaining;
            },
            { timeout: 15000 },
        )
        .toBe(0);
    await p.setViewportSize(orig);
    await p.evaluate(() => window.dispatchEvent(new Event('resize')));
}

test.beforeEach(async () => {
    setupEffectOrphanFilter(page);
    await clearAllUnread(page);
});

// Hotlist is not rendered on desktop viewport; title is visible.
test('hotlist hidden on desktop', async () => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await page
        .getByTestId('app-title')
        .waitFor({ state: 'visible', timeout: 5000 });
    // On desktop bufferListVisible is always true, so BufferHotlist is not in DOM
    await expect(page.getByTestId('buffer-hotlist')).not.toBeAttached();
    await expect(page.getByTestId('app-title')).toBeVisible();
});

// On mobile after buffer selection, hotlist renders in place of title.
test('hotlist visible on mobile after buffer selection', async () => {
    await page.setViewportSize({ width: 375, height: 667 });
    // Dispatch resize so Svelte's reactive isMobileState updates.
    // Playwright's setViewportSize doesn't fire DOM events, so we need this.
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    // Buffer list is hidden by default on mobile — show it via dev helper
    await page.evaluate(() => window.__showBufferListOnMobile?.());
    await page.waitForFunction(
        () => document.querySelector('[data-testid="buffer-item"]') !== null,
        { timeout: 10000 },
    );
    // Click a buffer from the list
    await switchToBuffer(page, 'glowing-bear');
    await botSay('hotlist test message 2');
    // Buffer list hidden on mobile after selection
    await expect(page.getByTestId('buffer-list')).not.toBeVisible();
    // Title hidden, hotlist rendered in its place
    await expect(page.getByTestId('app-title')).not.toBeVisible();
    await expect(page.getByTestId('buffer-hotlist')).toBeAttached();
});

// Bot sends PM to testuser creating a query buffer with unread.
// On mobile, the hotlist only renders after a buffer is selected (buffer list hides).
// Click #glowing-bear from buffer list so hotlist appears, then send PM to create unread.
test('hotlist shows buffers with unread messages', async () => {
    // Ensure viewport is mobile
    await page.setViewportSize({ width: 375, height: 667 });
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));

    // Show buffer list so we can click a buffer
    await page.evaluate(() => window.__showBufferListOnMobile?.());
    await page.waitForFunction(
        () => document.querySelector('[data-testid="buffer-item"]') !== null,
        { timeout: 10000 },
    );

    // Click #glowing-bear to trigger buffer selection → hotlist renders
    await switchToBuffer(page, 'glowing-bear');

    // Now hotlist should be visible on mobile. Send a PM to create an
    // inactive query buffer with unread messages that appears in hotlist.
    await botPm('hotlist test message!');

    // Wait for hotlist to populate (sync interval fires every ~5s)
    await expect(async () => {
        const n = await page.getByTestId('hotlist-buffer-item').count();
        expect(n).toBeGreaterThanOrEqual(1);
    }).toPass({ timeout: 30000 });

    const items = page.getByTestId('hotlist-buffer-item');
    // Pick the PM buffer by name: other specs leave unread in #glowing-bear, so
    // the hotlist order is not something this test can rely on.
    const pmItem = items.filter({ hasText: /g?gbbot\d*/ }).first();
    await expect(pmItem).toContainText(/g?gbbot\d*/);
    const countBadge = pmItem.getByTestId('hotlist-count');
    await expect(countBadge).toContainText(/\(\d+\)/);
});

// Clicking a hotlist item switches to that buffer.
test('clicking hotlist item switches buffer', async () => {
    // Ensure viewport is mobile
    await page.setViewportSize({ width: 375, height: 667 });
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));

    // Show buffer list so we can click #glowing-bear
    await page.evaluate(() => window.__showBufferListOnMobile?.());
    await page.waitForFunction(
        () => document.querySelector('[data-testid="buffer-item"]') !== null,
        { timeout: 10000 },
    );

    // Click #glowing-bear to trigger buffer selection → hotlist renders
    await switchToBuffer(page, 'glowing-bear');

    // Send a PM to create an inactive query buffer with unread
    await botPm('hotlist switch test!');

    // Wait for hotlist to populate (sync interval fires every ~5s)
    await expect(async () => {
        const n = await page.getByTestId('hotlist-buffer-item').count();
        expect(n).toBeGreaterThanOrEqual(1);
    }).toPass({ timeout: 30000 });

    const items = page.getByTestId('hotlist-buffer-item');
    // Click the PM buffer specifically — hotlist order depends on what other
    // specs left unread.
    const pmItem = items.filter({ hasText: /g?gbbot\d*/ }).first();
    await pmItem.click();

    // Switching buffers is a relay round-trip: assert the outcome with a polling
    // assertion instead of reading the topic bar once right after the click.
    await botPm('switch confirm');
    await expect(page.getByTestId('topic-bar')).toBeVisible({ timeout: 10000 });
    await expect(
        page.getByTestId('topic-bar').locator('.topic-channel-name'),
    ).toContainText(/g?gbbot\d*/, { timeout: 10000 });
});

// This one sat skipped behind "fix buffer creation via relay — sendWeechatCommand doesn't reliably
// create buffers". No spec that needs a second channel has ever created one through the relay: the
// bot joins the channel and the app's own composer types /join, which is what the capped-badge,
// scrollback and history specs do. So the trim point the hotlist strip states for itself
// (truncateName, 18 characters down to 15 plus an ellipsis) is testable, and now is.
test('a hotlist label is trimmed where the strip says, and still opens its buffer', async () => {
    // The strip only renders while the buffer list is closed, which on mobile is the state after
    // a buffer has been chosen. switchToBufferMobile leaves the page exactly there.
    await switchToBufferMobile(page, 'glowing-bear');

    await irc.botJoin(LONG_CHANNEL);

    // Typed into #glowing-bear, not into core.weechat where the app starts: WeeChat refuses
    // channel commands in a core buffer.
    const input = page.getByTestId('message-input');
    await input.click();
    await input.fill(`/join ${LONG_CHANNEL}`);
    await input.press('Enter');

    // Measured here: joining does not move the chat to the buffer it joined — the header stays on
    // #glowing-bear. What arrives is a sidebar row, and the sidebar is closed at this viewport, so
    // waitForBufferMobile widens, reads the row, and comes back.
    await waitForBufferMobile(page, LONG_CHANNEL, 20000);
    await page.evaluate(() => window.__hideBufferListOnMobile?.());
    await expect(page.getByTestId('buffer-list')).not.toBeAttached();

    // A buffer the chat is not looking at, with unread in it: the case the strip exists for.
    await irc.sendMessage(LONG_CHANNEL, 'trim probe');

    const item = page.getByTestId('hotlist-buffer-item').filter({ hasText: LONG_CHANNEL.slice(0, 15) });
    await expect(item).toHaveCount(1, { timeout: 20000 });

    const label = (await item.first().textContent()) ?? '';
    expect(label).toContain(LONG_CHANNEL.slice(0, 15));
    expect(label, `the label kept the whole name: ${JSON.stringify(label)}`).not.toContain(LONG_CHANNEL);
    expect(label).toContain('\u2026');

    // Trimming a label may not cost the entry the count it exists to show.
    await expect(item.first().getByTestId('hotlist-count')).toContainText('(1)');

    // And the short label is still a route to the whole buffer.
    await item.first().click();
    await expect(
        page.getByTestId('topic-bar').locator('.topic-channel-name'),
    ).toContainText(LONG_CHANNEL);
});
