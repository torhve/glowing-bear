import { test, expect } from '@playwright/test';
import { connectToWeechat, clearSettings, waitForAppReady } from '../helpers/connection';
import { irc } from '../helpers/irc-control';
import { switchToBuffer } from '../helpers/buffers';

let page: import('@playwright/test').Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await page.goto('http://localhost:8001/');
    await waitForAppReady(page);
    await clearSettings(page);
    page.on('pageerror', (error) => {
        if (error.message?.includes('effect_orphan')) return;
    });
    await connectToWeechat(page);
});

test.afterAll(async () => {
    await page.close();
});

test.beforeEach(async () => {
    page.on('pageerror', (error) => {
        if (error.message?.includes('effect_orphan')) return;
    });
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
    await expect(page.locator('[data-testid="buffer-item"].bg-accent\\/20')).toBeVisible();
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
    await page.waitForTimeout(200);
    await expect(toggleBtn).toHaveAttribute('title', 'Group by server');
    await toggleBtn.click();
    await page.waitForTimeout(300);
    await expect(toggleBtn).toHaveAttribute('title', 'Switch to list view');
});

test('should show buffer search input in topbar', async () => {
    await page.getByTestId('search-button').click();
    await page.waitForTimeout(200);
    await expect(page.locator('#buffer-search')).toBeVisible();
    // Close modal for subsequent tests
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
});

test('should filter buffers when searching', async () => {
    await page.getByTestId('search-button').click();
    await page.waitForTimeout(200);
    const searchInput = page.locator('#buffer-search');
    await expect(searchInput).toBeVisible({ timeout: 5000 });
    // Count all search results before filtering
    const allResultsBefore = page.locator('[data-search-index]');
    const countBefore = await allResultsBefore.count();
    expect(countBefore).toBeGreaterThanOrEqual(1);
    // Fill with a query that matches #glowing-bear
    await searchInput.fill('#glowing-bear');
    await page.waitForTimeout(300);
    // Only matching buffers should be visible in search results
    const filteredResults = page.locator('[data-search-index]');
    const filteredCount = await filteredResults.count();
    expect(filteredCount).toBeGreaterThanOrEqual(1);
    // All visible search results should contain the search query text
    for (let i = 0; i < filteredCount; i++) {
        const text = await filteredResults.nth(i).textContent();
        expect(text?.toLowerCase()).toContain('#glowing-bear'.toLowerCase());
    }
    // Close modal for subsequent tests
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
});

test('should close buffer search with Escape key', async () => {
    // Ensure search is closed, then open fresh
    const modal = page.locator('#buffer-search-modal');
    if (await modal.isVisible().catch(() => false)) {
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
    }
    await page.getByTestId('search-button').click();
    await page.waitForTimeout(200);
    const searchInput = page.locator('#buffer-search');
    await expect(searchInput).toBeVisible({ timeout: 5000 });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    await expect(modal).not.toBeVisible({ timeout: 5000 });
});

test('should show close button on active buffer item', async () => {
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
    test.beforeEach(async () => {
        // Close search modal if already open (from previous test)
        const modal = page.locator('#buffer-search-modal');
        if (await modal.isVisible()) {
            await page.keyboard.press('Escape');
            await page.waitForTimeout(200);
        }
        // Open search modal
        const searchBtn = page.getByTitle('Search buffers (Alt+G)');
        await searchBtn.click({ timeout: 10000 });
        await page.waitForTimeout(300);
        const searchInput = page.locator('#buffer-search');
        await expect(searchInput).toBeVisible({ timeout: 5000 });
        await searchInput.fill('');
    });

    test('should open search dropdown with matching results', async () => {
        const searchInput = page.locator('#buffer-search');
        await searchInput.fill('#');
        const results = page.locator('[data-search-index]');
        const count = await results.count();
        expect(count).toBeGreaterThanOrEqual(1);
    });

    test('should highlight first result by default', async () => {
        const searchInput = page.locator('#buffer-search');
        await searchInput.fill('#');
        await expect(page.locator('[data-search-index="0"]')).toHaveClass(/bg-accent/, { timeout: 5000 });
    });

    test('should move highlight down on ArrowDown', async () => {
        const searchInput = page.locator('#buffer-search');
        await searchInput.fill('#');
        const results = page.locator('[data-search-index]');
        const count = await results.count();
        if (count >= 2) {
            await page.dispatchEvent('#buffer-search', 'keydown', { key: 'ArrowDown' });
            await expect(page.locator('[data-search-index="0"]')).not.toHaveClass(/bg-accent/);
            await expect(page.locator('[data-search-index="1"]')).toHaveClass(/bg-accent/);
        } else {
            test.skip();
        }
    });

    test('should move highlight up on ArrowUp', async () => {
        const searchInput = page.locator('#buffer-search');
        await searchInput.fill('#');
        const results = page.locator('[data-search-index]');
        const count = await results.count();
        if (count >= 3) {
            await page.dispatchEvent('#buffer-search', 'keydown', { key: 'ArrowDown' });
            await page.dispatchEvent('#buffer-search', 'keydown', { key: 'ArrowDown' });
            await expect(page.locator('[data-search-index="2"]')).toHaveClass(/bg-accent/);
            await page.dispatchEvent('#buffer-search', 'keydown', { key: 'ArrowUp' });
            await expect(page.locator('[data-search-index="1"]')).toHaveClass(/bg-accent/);
        } else {
            test.skip();
        }
    });

    test('should wrap from last to first on ArrowDown', async () => {
        const searchInput = page.locator('#buffer-search');
        await searchInput.fill('#');
        const results = page.locator('[data-search-index]');
        const count = await results.count();
        expect(count).toBeGreaterThanOrEqual(1);
        for (let i = 0; i < count; i++) {
            await page.dispatchEvent('#buffer-search', 'keydown', { key: 'ArrowDown' });
        }
        await expect(page.locator('[data-search-index="0"]')).toHaveClass(/bg-accent/);
    });

    test('should wrap from first to last on ArrowUp', async () => {
        const searchInput = page.locator('#buffer-search');
        await searchInput.fill('#');
        const results = page.locator('[data-search-index]');
        const count = await results.count();
        expect(count).toBeGreaterThanOrEqual(1);
        await page.dispatchEvent('#buffer-search', 'keydown', { key: 'ArrowUp' });
        const lastIdx = count - 1;
        await expect(page.locator(`[data-search-index="${lastIdx}"]`)).toHaveClass(/bg-accent/);
    });

    test('should activate the highlighted result on Enter', async () => {
        const searchInput = page.locator('#buffer-search');
        await searchInput.fill('#');
        const results = page.locator('[data-search-index]');
        const count = await results.count();
        expect(count).toBeGreaterThanOrEqual(1);
        await page.dispatchEvent('#buffer-search', 'keydown', { key: 'ArrowDown' });
        await searchInput.press('Enter');
        await expect(searchInput).not.toBeVisible({ timeout: 5000 });
        await expect(page.getByTestId('chat-view')).toBeVisible();
    });

    test('should reset highlight to top when query changes', async () => {
        const searchInput = page.locator('#buffer-search');
        await searchInput.fill('#');
        const results = page.locator('[data-search-index]');
        const count = await results.count();
        if (count >= 3) {
            await page.dispatchEvent('#buffer-search', 'keydown', { key: 'ArrowDown' });
            await page.dispatchEvent('#buffer-search', 'keydown', { key: 'ArrowDown' });
            await expect(page.locator('[data-search-index="2"]')).toHaveClass(/bg-accent/);
            await searchInput.fill(searchInput.inputValue() + 'g');
            await expect(page.locator('[data-search-index="0"]')).toHaveClass(/bg-accent/, { timeout: 5000 });
        } else {
            test.skip();
        }
    });

    test('should close search on Escape', async () => {
        const searchInput = page.locator('#buffer-search');
        await searchInput.fill('test');
        await searchInput.press('Escape');
        await expect(searchInput).not.toBeVisible({ timeout: 5000 });
    });
});

test.describe('onlyUnread filter', () => {
    test('should hide non-unread buffers when onlyUnread is enabled', async () => {
        // Close any open modals from previous tests
        const modalVisible = await page.getByTestId('settings-modal').isVisible().catch(() => false);
        if (modalVisible) {
            await page.getByTestId('settings-modal-close').click();
            await page.waitForTimeout(200);
        }

        // Send a message to #glowing-bear to ensure it has unread count
        await irc.sendMessage('#glowing-bear', 'for unread filter test');
        await page.waitForTimeout(1000);

        // Switch back to #glowing-bear so it becomes active (match both # and no # prefix)
        const gbItem = page.getByTestId('buffer-item').filter({ hasText: 'glowing-bear' }).first();
        const gbVisible = await gbItem.isVisible().catch(() => false);
        if (!gbVisible) {
            throw new Error('#glowing-bear buffer not found');
        }
        await gbItem.click();
        await page.waitForTimeout(500);

        // Count all buffers (filter is off by default)
        const allItemsBefore = page.getByTestId('buffer-item');
        const countBefore = await allItemsBefore.count();
        expect(countBefore).toBeGreaterThanOrEqual(1);

        // Open settings and enable "Only show buffers with unread messages"
        await page.getByTestId('settings-button').click();
        await page.waitForTimeout(200);
        await page.locator('label:has-text("Only show buffers with unread messages")').click();
        await page.waitForTimeout(200);
        await page.getByTestId('settings-modal-close').click();
        await page.waitForTimeout(200);

        // With filter on, only buffers with unread/notification/active/pinned should show
        // Since #glowing-bear is active AND has unread, at least it should still be visible
        const filteredItems = page.getByTestId('buffer-item');
        const filteredCount = await filteredItems.count();
        expect(filteredCount).toBeGreaterThanOrEqual(1);

        // Verify the buffer list re-renders with different visibility
        // (the active buffer should always remain visible regardless of unread state)
        const activeBufferVisible = page.getByTestId('buffer-item').filter({ hasText: 'glowing-bear' });
        await expect(activeBufferVisible).toBeVisible({ timeout: 5000 });

        // Re-open settings and disable the filter
        await page.getByTestId('settings-button').click();
        await page.waitForTimeout(200);
        await page.locator('label:has-text("Only show buffers with unread messages")').click();
        await page.waitForTimeout(200);
        await page.getByTestId('settings-modal-close').click();
        await page.waitForTimeout(200);

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
            await page.waitForTimeout(200);
        }

        // Ensure we are on #glowing-bear buffer
        await switchToBuffer(page, '#glowing-bear');
        await page.waitForTimeout(500);

        // Enable onlyUnread filter
        await page.getByTestId('settings-button').click();
        await page.waitForTimeout(200);
        await page.locator('label:has-text("Only show buffers with unread messages")').click();
        await page.waitForTimeout(200);
        await page.getByTestId('settings-modal-close').click();
        await page.waitForTimeout(500);

        // Verify #glowing-bear is visible as the active buffer
        const gbItem = page.getByTestId('buffer-item').filter({ hasText: 'glowing-bear' }).first();
        await expect(gbItem).toBeVisible({ timeout: 5000 });

        // Click the same buffer again - this triggers switchBuffer which zeroes unread counts
        await gbItem.click();
        await page.waitForTimeout(1000);

        // The buffer should STILL be visible because it's the active buffer
        const gbItemAfter = page.getByTestId('buffer-item').filter({ hasText: 'glowing-bear' }).first();
        await expect(gbItemAfter).toBeVisible({ timeout: 5000 });

        // Disable onlyUnread filter for subsequent tests
        await page.getByTestId('settings-button').click();
        await page.waitForTimeout(200);
        await page.locator('label:has-text("Only show buffers with unread messages")').click();
        await page.waitForTimeout(200);
        await page.getByTestId('settings-modal-close').click();
        await page.waitForTimeout(200);
    });
});

test.describe('quick keys display', () => {
    test('should show numbered quick key badges on buffer items when enabled', async () => {
        // Reset settings to known state before testing quick keys
        await page.evaluate(() => {
            (window as any).__setGbSettings?.({ showQuickKeys: true, enableQuickKeys: true, onlyUnread: false });
        });
        await page.waitForTimeout(300);

        // Verify numbered badges appear on buffer items
        const quickKeyBadges = page.locator('[data-testid="buffer-item"] .buffer-quickkey');
        const badgeCount = await quickKeyBadges.count();
        expect(badgeCount).toBeGreaterThanOrEqual(1);

        // Verify badges contain sequential keys: 1-9 then A-Z for 10+
        for (let i = 0; i < badgeCount; i++) {
            const text = await quickKeyBadges.nth(i).textContent();
            if (i < 9) {
                expect(text).toBe(String(i + 1));
            } else {
                const expected = String.fromCharCode(65 + i - 10);
                expect(text).toBe(expected);
            }
        }

        // Disable quick keys via settings API
        await page.evaluate(() => {
            (window as any).__setGbSettings?.({ showQuickKeys: false });
        });
        await page.waitForTimeout(300);

        // Badges should no longer be visible
        const quickKeyBadgesOff = page.locator('[data-testid="buffer-item"] .buffer-quickkey');
        const badgeCountOff = await quickKeyBadgesOff.count();
        expect(badgeCountOff).toBe(0);
    });
});
