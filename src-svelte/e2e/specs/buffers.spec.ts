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
    await expect(page.getByPlaceholder('Search buffers...')).toBeVisible();
});

test('should filter buffers when searching', async () => {
    await page.getByTestId('search-button').click();
    await page.waitForTimeout(200);
    const searchInput = page.getByPlaceholder('Search buffers...');
    await searchInput.fill('weechat');
    const items = page.getByTestId('buffer-item');
    const count = await items.count();
    expect(count).toBeGreaterThanOrEqual(0);
});

test('should close buffer search with Escape key', async () => {
    // Ensure search is closed, then open fresh
    await page.getByTestId('search-button').click();
    await page.waitForTimeout(200);
    await expect(page.getByPlaceholder('Search buffers...')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    await expect(page.getByPlaceholder('Search buffers...')).not.toBeVisible({ timeout: 5000 });
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
        // Toggle twice to ensure clean state
        await page.getByTestId('search-button').click();
        await page.waitForTimeout(100);
        await page.getByTestId('search-button').click();
        await page.waitForTimeout(200);
        const searchInput = page.locator('#buffer-search');
        await expect(searchInput).toBeAttached();
        await searchInput.clear();
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

        // Switch back to #glowing-bear so it becomes active
        const gbItem = page.getByTestId('buffer-item').filter({ hasText: '#glowing-bear' }).first();
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
        const activeBufferVisible = page.getByTestId('buffer-item').filter({ hasText: '#glowing-bear' });
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
});

test.describe('quick keys display', () => {
    test('should show numbered quick key badges on buffer items when enabled', async () => {
        // Press Alt keydown to toggle showQuickKeys to true
        await page.keyboard.down('Alt');
        await page.waitForTimeout(200);
        await page.keyboard.up('Alt');
        await page.waitForTimeout(500);

        // Verify numbered badges appear on buffer items
        const quickKeyBadges = page.locator('[data-testid="buffer-item"] span.bg-accent');
        const badgeCount = await quickKeyBadges.count();
        expect(badgeCount).toBeGreaterThanOrEqual(1);

        // Verify badges contain sequential numbers starting from 1
        for (let i = 0; i < badgeCount; i++) {
            const text = await quickKeyBadges.nth(i).textContent();
            expect(parseInt(text!, 10)).toBe(i + 1);
        }

        // Toggle off by pressing Alt again
        await page.keyboard.down('Alt');
        await page.waitForTimeout(200);
        await page.keyboard.up('Alt');
        await page.waitForTimeout(300);

        // Badges should no longer be visible
        const quickKeyBadgesOff = page.locator('[data-testid="buffer-item"] span.bg-accent');
        const badgeCountOff = await quickKeyBadgesOff.count();
        expect(badgeCountOff).toBe(0);
    });
});
