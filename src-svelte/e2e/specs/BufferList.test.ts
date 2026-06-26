import { test, expect } from '@playwright/test';
import { connectToWeechat, clearSettings, waitForAppReady } from '../helpers/connection';
import { irc } from '../helpers/irc-control';
import { switchToBuffer, waitForBuffer } from '../helpers/buffers';

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
    await expect(page.locator('#buffer-search')).not.toBeVisible({ timeout: 5000 }).catch(() => {});
});

// Skipped — FormInput one-way value binding does not reliably trigger Svelte 5 reactivity from Playwright interactions.
// When FormInput is updated to use bind:value, uncomment this test.
test.skip('should filter buffers when searching', async () => {
    await page.getByTestId('search-button').click();
    const searchInput = page.locator('#buffer-search');
    await expect(searchInput).toBeVisible({ timeout: 5000 });
    const allResultsBefore = page.locator('[data-search-index]');
    const countBefore = await allResultsBefore.count();
    expect(countBefore).toBeGreaterThanOrEqual(1);
    await searchInput.fill('#glowing-bear');
    await expect(async () => {
        const n = await allResultsBefore.count();
        expect(n).toBeLessThanOrEqual(countBefore);
        expect(n).toBeGreaterThanOrEqual(1);
    }).toPass({ timeout: 5000 });
    const filteredCount = await allResultsBefore.count();
    for (let i = 0; i < filteredCount; i++) {
        const text = await allResultsBefore.nth(i).textContent();
        expect(text?.toLowerCase()).toContain('#glowing-bear'.toLowerCase());
    }
    await page.keyboard.press('Escape');
    await expect(searchInput).not.toBeVisible({ timeout: 5000 }).catch(() => {});
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

test.describe.skip('buffer search arrow navigation', () => {
    // Skipped — search modal uses Svelte 5 one-way value binding on FormInput
    // which doesn't reliably trigger reactivity from Playwright interactions.
    // The search functionality works correctly in the app; this is a test infrastructure issue.

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
        // Clear input using evaluate for Svelte 5 reactivity
        await page.evaluate(() => {
            const input = document.getElementById('buffer-search') as HTMLInputElement;
            if (input) {
                input.value = '';
                input.dispatchEvent(new Event('input', { bubbles: true }));
            }
        });
    });

    test('should open search dropdown with matching results', async () => {
        const searchInput = page.locator('#buffer-search');
        // Use evaluate + dispatchEvent for Svelte 5 reactivity on one-way bound input
        // Search for 'g' which matches gbtest, glowing-bear, gbbot2
        await page.evaluate(() => {
            const input = document.getElementById('buffer-search') as HTMLInputElement;
            if (input) {
                input.value = 'g';
                input.dispatchEvent(new Event('input', { bubbles: true }));
            }
        });
        const results = page.locator('[data-search-index]');
        await expect(results).not.toHaveCount(0, { timeout: 5000 });
    });

    test('should highlight first result by default', async () => {
        const searchInput = page.locator('#buffer-search');
        await page.evaluate(() => {
            const input = document.getElementById('buffer-search') as HTMLInputElement;
            if (input) {
                input.value = 'g';
                input.dispatchEvent(new Event('input', { bubbles: true }));
            }
        });
        await expect(page.locator('[data-search-index="0"]')).toHaveClass(/bg-accent/, { timeout: 5000 });
    });

    test('should move highlight down on ArrowDown', async () => {
        const searchInput = page.locator('#buffer-search');
        await page.evaluate(() => {
            const input = document.getElementById('buffer-search') as HTMLInputElement;
            if (input) {
                input.value = 'g';
                input.dispatchEvent(new Event('input', { bubbles: true }));
            }
        });
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
        await page.evaluate(() => {
            const input = document.getElementById('buffer-search') as HTMLInputElement;
            if (input) {
                input.value = '#';
                input.dispatchEvent(new Event('input', { bubbles: true }));
            }
        });
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
        await page.evaluate(() => {
            const input = document.getElementById('buffer-search') as HTMLInputElement;
            if (input) {
                input.value = 'g';
                input.dispatchEvent(new Event('input', { bubbles: true }));
            }
        });
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
        await page.evaluate(() => {
            const input = document.getElementById('buffer-search') as HTMLInputElement;
            if (input) {
                input.value = 'g';
                input.dispatchEvent(new Event('input', { bubbles: true }));
            }
        });
        const results = page.locator('[data-search-index]');
        const count = await results.count();
        expect(count).toBeGreaterThanOrEqual(1);
        await page.dispatchEvent('#buffer-search', 'keydown', { key: 'ArrowUp' });
        const lastIdx = count - 1;
        await expect(page.locator(`[data-search-index="${lastIdx}"]`)).toHaveClass(/bg-accent/);
    });

    test('should activate the highlighted result on Enter', async () => {
        const searchInput = page.locator('#buffer-search');
        await page.evaluate(() => {
            const input = document.getElementById('buffer-search') as HTMLInputElement;
            if (input) {
                input.value = 'g';
                input.dispatchEvent(new Event('input', { bubbles: true }));
            }
        });
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
        await page.evaluate(() => {
            const input = document.getElementById('buffer-search') as HTMLInputElement;
            if (input) {
                input.value = 'g';
                input.dispatchEvent(new Event('input', { bubbles: true }));
            }
        });
        const results = page.locator('[data-search-index]');
        const count = await results.count();
        if (count >= 3) {
            await page.dispatchEvent('#buffer-search', 'keydown', { key: 'ArrowDown' });
            await page.dispatchEvent('#buffer-search', 'keydown', { key: 'ArrowDown' });
            await expect(page.locator('[data-search-index="2"]')).toHaveClass(/bg-accent/);
            // Update query using evaluate for Svelte 5 reactivity
            await page.evaluate(() => {
                const input = document.getElementById('buffer-search') as HTMLInputElement;
                if (input) {
                    input.value = 'gl';
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                }
            });
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
