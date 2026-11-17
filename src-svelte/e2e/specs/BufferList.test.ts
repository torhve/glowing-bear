import { test, expect } from '@playwright/test';
import { connectToWeechat, clearSettings, waitForAppReady } from '../helpers/connection';
import { irc } from '../helpers/irc-control';
import { switchToBuffer, waitForBuffer } from '../helpers/buffers';
import { closeSpecChatChannel, openSpecChatChannel } from '../helpers/spec-chat-channel';

import { setupEffectOrphanFilter } from '../helpers/pageerror';
import { createConnectedPage } from '../fixtures/auth';

let page: import('@playwright/test').Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
    page = await createConnectedPage(browser);
});

test.afterAll(async () => {
    await page.close();
});

test.beforeEach(async () => {
    setupEffectOrphanFilter(page)
    // Ensure we're still connected after previous serial test
    const isConnected = await page.getByTestId('chat-view').isVisible().catch(() => false);
    if (!isConnected) {
        await page.goto('http://localhost:8001/');
        await waitForAppReady(page);
        await clearSettings(page);
        await connectToWeechat(page);
    }
});

test('should display buffer list after connecting', async () => {
    await expect(page.getByTestId('buffer-list')).toBeVisible();
    await expect(page.getByTestId('buffer-list-items')).toBeVisible();
});

test('should display multiple buffer items', async () => {
    const count = await page.getByTestId('buffer-item').count();
    expect(count).toBeGreaterThanOrEqual(1);
});

test('should highlight the active buffer', async () => {
    await expect(page.locator('[data-testid="buffer-item"].border-s-accent')).toBeVisible();
});

test('should switch buffers when clicking a buffer item', async () => {
    await page.getByTestId('buffer-item').first().click();
    await expect(page.getByTestId('topic-bar')).toBeVisible({ timeout: 5000 });
});

test('should update topic bar when switching buffers', async () => {
    await expect(page.getByTestId('topic-bar')).toBeVisible();
    await page.getByTestId('buffer-item').first().click();
    await expect(page.getByTestId('topic-bar')).toBeVisible({ timeout: 5000 });
});

test('should toggle server grouping in buffer list', async () => {
    const toggleBtn = page.getByTestId('toggle-server-groups');
    await expect(toggleBtn).toBeVisible();
    await page.evaluate(() => {
        (window as any).__setGbSettings?.({ orderbyserver: false });
    });
    await expect(toggleBtn).toHaveAttribute('title', 'Group by server', { timeout: 5000 });
    await toggleBtn.click();
    await expect(toggleBtn).toHaveAttribute('title', 'Switch to list view', { timeout: 5000 });
});

test('should show buffer search input in topbar', async () => {
    await page.getByTestId('search-button').click();
    await expect(page.locator('#buffer-search')).toBeVisible({ timeout: 5000 });
    // Close modal for subsequent tests
    await page.keyboard.press('Escape');
    await expect(page.locator('#buffer-search')).not.toBeVisible({ timeout: 5000 });
});

// The dialog keeps a row when the query reaches its short name, full name, buffer number or
// title (bufferSearchMatch.ts:38-45), and marks what it matched on the rows it keeps. Which
// fields a query can reach is a pure function's job and is pinned in
// src-svelte/test/unit/buffer-search-match.test.ts. What belongs to the browser is the dialog's
// own promise: it keeps what the query reaches and drops what it does not.
//
// So this spec joins the two channels it asserts on. An absolute row count was never a claim
// about the dialog — it was a claim about how many buffers the fixture happened to be holding,
// and on a fresh fixture that number is three.
test('searching buffers keeps the match and drops what the query does not reach', async () => {
    const kept = await openSpecChatChannel(page, 'searchkeep');
    const dropped = await openSpecChatChannel(page, 'searchdrop');
    try {
        await page.getByTestId('search-button').click();
        const searchInput = page.locator('#buffer-search');
        await expect(searchInput).toBeVisible({ timeout: 5000 });

        const rows = page.locator('[data-search-index]');
        const rowFor = (channel: string) => rows.filter({ hasText: channel });

        // Both rows this spec created are listed before any query. Without this the assertions
        // below could pass on a dialog that listed neither row.
        await expect(rowFor(kept)).toHaveCount(1);
        await expect(rowFor(dropped)).toHaveCount(1);

        await searchInput.fill(kept);
        await expect(rowFor(kept)).toHaveCount(1);
        await expect(rowFor(dropped)).toHaveCount(0);

        // The other half: the row that survives is the one the query reaches, not the one the
        // dialog happened to list first.
        await searchInput.fill(dropped);
        await expect(rowFor(dropped)).toHaveCount(1);
        await expect(rowFor(kept)).toHaveCount(0);
    } finally {
        await page.keyboard.press('Escape').catch(() => {});
        await switchToBuffer(page, '#glowing-bear').catch(() => {});
        closeSpecChatChannel(kept);
        closeSpecChatChannel(dropped);
    }
});

test('should close buffer search with Escape key', async () => {
    // Ensure search is closed, then open fresh
    const modal = page.locator('#buffer-search-modal');
    if (await modal.isVisible().catch(() => false)) {
        await page.keyboard.press('Escape');
        await expect(modal).not.toBeVisible({ timeout: 5000 });
    }
    await page.getByTestId('search-button').click();
    const searchInput = page.locator('#buffer-search');
    await expect(searchInput).toBeVisible({ timeout: 5000 });
    await page.keyboard.press('Escape');
    await expect(modal).not.toBeVisible({ timeout: 5000 });
});

test('should show close button in topic bar for active buffer', async () => {
    const closeButtons = page.getByTestId('close-buffer');
    const count = await closeButtons.count();
    expect(count).toBeGreaterThanOrEqual(1);
});

test('should display buffer short names in the list', async () => {
    await expect(page.getByTestId('buffer-item').first()).toBeAttached();
});

test('should show buffers div with border and padding', async () => {
    const bufferList = page.getByTestId('buffer-list');
    const borderStyle = await bufferList.evaluate(el => getComputedStyle(el).borderRightStyle);
    expect(borderStyle).toBe('solid');
});

test.describe('buffer search arrow navigation', () => {
    // This describe carried the same note as the filter test above — "the one-way binding needs
    // bind:value, this is a test infrastructure issue" — and the workaround that note implies:
    // set the input through page.evaluate and dispatch a synthetic input event. Measured here, a
    // plain fill on #buffer-search filters the list, so the workaround was solving a problem this
    // app does not have. It is gone; these tests type into the dialog.

    // The arrow keys move a highlight between the rows the dialog is showing, so the number of
    // rows is this group's precondition. A query reaching however many buffers the fixture happens
    // to hold is not one: on a fresh fixture `g` reaches two buffers, which is not enough for a
    // highlight to move across three rows. This group joins three channels of its own. Their names
    // share the prefix `gbownar`, which no other buffer here carries, so the query these tests type
    // reaches exactly those three rows.
    const owned: string[] = [];

    test.beforeAll(async () => {
        for (const suffix of ['a', 'b', 'c']) owned.push(await openSpecChatChannel(page, `ar${suffix}`));
    });

    test.afterAll(async () => {
        // Leave a stable buffer first: closing the buffer the app is showing moves it somewhere
        // the next test did not choose.
        await switchToBuffer(page, '#glowing-bear').catch(() => {});
        for (const channel of owned) closeSpecChatChannel(channel);
    });

    /** Open the dialog on this group's three channels, and state that arrangement. */
    async function openQuery() {
        const searchInput = page.locator('#buffer-search');
        await searchInput.fill('gbownar');
        const results = page.locator('[data-search-index]');
        // The count is the arrangement, stated as the number of channels this group joined. A row
        // left over from an aborted run that also matches the token fails here instead of quietly
        // shifting the highlight assertions onto another row.
        await expect(results).toHaveCount(owned.length, { timeout: 10000 });
        return { searchInput, results };
    }

    test.beforeEach(async () => {
        // Close search modal if already open (from previous test)
        const modal = page.locator('#buffer-search-modal');
        if (await modal.isVisible()) {
            await page.keyboard.press('Escape');
            await expect(modal).not.toBeVisible({ timeout: 5000 });
        }
        // Open search modal
        const searchBtn = page.getByTestId('search-button');
        await searchBtn.click({ timeout: 10000 });
        const searchInput = page.locator('#buffer-search');
        await expect(searchInput).toBeVisible({ timeout: 5000 });
        await searchInput.fill('');
    });

    test('should open search dropdown with matching results', async () => {
        await openQuery();
        // The dropdown lists the buffers the query reaches — here, all three this group joined.
        for (const channel of owned) {
            await expect(page.locator('[data-search-index]').filter({ hasText: channel })).toHaveCount(1);
        }
    });

    test('should highlight first result by default', async () => {
        await openQuery();
        await expect(page.locator('[data-search-index="0"]')).toHaveClass(/bg-accent/);
    });

    test('should move highlight down on ArrowDown', async () => {
        await openQuery();
        await page.dispatchEvent('#buffer-search', 'keydown', { key: 'ArrowDown' });
        await expect(page.locator('[data-search-index="0"]')).not.toHaveClass(/bg-accent/);
        await expect(page.locator('[data-search-index="1"]')).toHaveClass(/bg-accent/);
    });

    test('should move highlight up on ArrowUp', async () => {
        await openQuery();
        await page.dispatchEvent('#buffer-search', 'keydown', { key: 'ArrowDown' });
        await page.dispatchEvent('#buffer-search', 'keydown', { key: 'ArrowDown' });
        await expect(page.locator('[data-search-index="2"]')).toHaveClass(/bg-accent/);
        await page.dispatchEvent('#buffer-search', 'keydown', { key: 'ArrowUp' });
        await expect(page.locator('[data-search-index="1"]')).toHaveClass(/bg-accent/);
    });

    test('should wrap from last to first on ArrowDown', async () => {
        await openQuery();
        // Walking one row past the end has to land back on the first row.
        for (let step = 0; step < owned.length; step++) {
            await page.dispatchEvent('#buffer-search', 'keydown', { key: 'ArrowDown' });
        }
        await expect(page.locator('[data-search-index="0"]')).toHaveClass(/bg-accent/);
    });

    test('should wrap from first to last on ArrowUp', async () => {
        await openQuery();
        // And the other way round: one row before the top is the bottom row.
        await page.dispatchEvent('#buffer-search', 'keydown', { key: 'ArrowUp' });
        await expect(page.locator(`[data-search-index="${owned.length - 1}"]`)).toHaveClass(/bg-accent/);
    });

    test('should activate the highlighted result on Enter', async () => {
        const { searchInput } = await openQuery();
        await page.dispatchEvent('#buffer-search', 'keydown', { key: 'ArrowDown' });
        await searchInput.press('Enter');
        // Enter acts on the highlighted row: the dialog closes and the chat is looking at that
        // buffer again.
        await expect(searchInput).not.toBeVisible({ timeout: 5000 });
        await expect(page.getByTestId('chat-view')).toBeVisible();
    });

    test('should reset highlight to top when query changes', async () => {
        const { searchInput, results } = await openQuery();
        await page.dispatchEvent('#buffer-search', 'keydown', { key: 'ArrowDown' });
        await page.dispatchEvent('#buffer-search', 'keydown', { key: 'ArrowDown' });
        await expect(page.locator('[data-search-index="2"]')).toHaveClass(/bg-accent/);

        // Narrowing the query re-ranks the list, so the highlight restarts at the top instead of
        // following a buffer that has moved somewhere else in it — the dialog's own oninput resets
        // selectedIndex (BufferSearchModal.svelte:198). The narrower query here reaches one of the
        // three channels this group joined.
        await searchInput.fill('gbownara');
        await expect(results).toHaveCount(1);
        await expect(page.locator('[data-search-index="0"]')).toHaveClass(/bg-accent/, { timeout: 5000 });
    });

    test('should close search on Escape', async () => {
        const searchInput = page.locator('#buffer-search');
        await searchInput.fill('test');
        await searchInput.press('Escape');
        await expect(searchInput).not.toBeVisible({ timeout: 5000 });
    });
});

test.describe('onlyUnread filter', () => {
    async function toggleOnlyUnread() {
        await page.getByTestId('settings-button').click();
        await expect(page.getByTestId('settings-modal')).toBeVisible({ timeout: 5000 });
        await page.locator('label:has-text("Only show buffers with unread messages")').click();
        await page.getByTestId('settings-modal-close').click();
        await expect(page.getByTestId('settings-modal')).not.toBeVisible({ timeout: 5000 });
    }

    test('should hide non-unread buffers when onlyUnread is enabled', async () => {
        // Close any open modals from previous tests
        const modalVisible = await page.getByTestId('settings-modal').isVisible().catch(() => false);
        if (modalVisible) {
            await page.getByTestId('settings-modal-close').click();
            await expect(page.getByTestId('settings-modal')).not.toBeVisible({ timeout: 5000 });
        }

        // Send a message to #glowing-bear to ensure it has unread count
        const uniqueMsg = 'for unread filter test ' + Date.now();
        await irc.sendMessage('#glowing-bear', uniqueMsg);

        // Switch to #glowing-bear so it becomes active
        const gbItem = page.getByTestId('buffer-item').filter({ hasText: 'glowing-bear' }).first();
        await expect(gbItem).toBeVisible({ timeout: 5000 });
        await gbItem.click();
        await expect(page.getByTestId('topic-bar')).toBeVisible({ timeout: 5000 });

        // Count all buffers (filter is off by default)
        const allItemsBefore = page.getByTestId('buffer-item');
        const countBefore = await allItemsBefore.count();
        expect(countBefore).toBeGreaterThanOrEqual(1);

        // Open settings and enable "Only show buffers with unread messages"
        await toggleOnlyUnread();

        // With filter on, the active buffer should still be visible
        const filteredItems = page.getByTestId('buffer-item');
        const filteredCount = await filteredItems.count();
        expect(filteredCount).toBeGreaterThanOrEqual(1);

        // The active buffer should remain visible
        const activeBufferVisible = page.getByTestId('buffer-item').filter({ hasText: 'glowing-bear' });
        await expect(activeBufferVisible).toBeVisible({ timeout: 5000 });

        // Re-open settings and disable the filter
        await toggleOnlyUnread();

        // All buffers should be visible again
        const allItemsAfter = page.getByTestId('buffer-item');
        const countAfter = await allItemsAfter.count();
        expect(countAfter).toBeGreaterThanOrEqual(1);
    });

    test('should keep active buffer visible when clicking it with onlyUnread enabled', async () => {
        // Close any open modals from previous tests
        const modalVisible = await page.getByTestId('settings-modal').isVisible().catch(() => false);
        if (modalVisible) {
            await page.getByTestId('settings-modal-close').click();
            await expect(page.getByTestId('settings-modal')).not.toBeVisible({ timeout: 5000 });
        }

        // Ensure we are on #glowing-bear buffer
        await switchToBuffer(page, '#glowing-bear');
        await expect(page.getByTestId('topic-bar')).toBeVisible({ timeout: 5000 });

        // Enable onlyUnread filter
        await toggleOnlyUnread();

        // Verify #glowing-bear is visible as the active buffer
        const gbItem = page.getByTestId('buffer-item').filter({ hasText: 'glowing-bear' }).first();
        await expect(gbItem).toBeVisible({ timeout: 5000 });

        // Click the same buffer again - this triggers switchBuffer which zeroes unread counts
        await gbItem.click();
        await expect(page.getByTestId('topic-bar')).toBeVisible({ timeout: 5000 });

        // The buffer should STILL be visible because it's the active buffer
        const gbItemAfter = page.getByTestId('buffer-item').filter({ hasText: 'glowing-bear' }).first();
        await expect(gbItemAfter).toBeVisible({ timeout: 5000 });

        // Disable onlyUnread filter for subsequent tests
        await toggleOnlyUnread();
    });
});

test.describe('quick keys display', () => {
    test('should show numbered quick key badges on buffer items when enabled', async () => {
        // Reload to clear any leftover filter state from previous tests
        await page.reload();
        await waitForAppReady(page);
        const isConnected = await page.getByTestId('chat-view').isVisible().catch(() => false);
        if (!isConnected) {
            await connectToWeechat(page);
        }
        // Enable quick keys and ensure no filters are active
        await page.evaluate(() => {
            (window as any).__setGbSettings?.({ showQuickKeys: true, enableQuickKeys: true, onlyUnread: false });
        });

        // Verify numbered badges appear on buffer items
        await expect(async () => {
            const quickKeyBadges = page.locator('[data-testid="buffer-item"] [data-testid="quick-key"]');
            const badgeCount = await quickKeyBadges.count();
            expect(badgeCount).toBeGreaterThanOrEqual(1);
        }).toPass({ timeout: 5000 });
        const quickKeyBadges = page.locator('[data-testid="buffer-item"] [data-testid="quick-key"]');
        const badgeCount = await quickKeyBadges.count();

        // Verify all badge values are unique integers in range 1-9
        const seen = new Set<number>();
        for (let i = 0; i < badgeCount; i++) {
            const text = await quickKeyBadges.nth(i).textContent();
            const num = parseInt(text!, 10);
            expect(num).toBeGreaterThanOrEqual(1);
            expect(num).toBeLessThanOrEqual(9);
            expect(seen.has(num)).toBe(false);
            seen.add(num);
        }
        // At most 9 quick key badges should appear
        expect(badgeCount).toBeLessThanOrEqual(9);

        // Disable quick keys via settings API
        await page.evaluate(() => {
            (window as any).__setGbSettings?.({ showQuickKeys: false });
        });

        // Badges should no longer be visible
        await expect(async () => {
            const n = await page.locator('[data-testid="buffer-item"] [data-testid="quick-key"]').count();
            expect(n).toBe(0);
        }).toPass({ timeout: 5000 });
    });
});
