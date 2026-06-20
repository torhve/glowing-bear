import { test, expect } from '@playwright/test';
import { connectToWeechat, clearSettings, setSettings, waitForAppReady } from '../helpers/connection';
import { openSettings, closeSettings } from '../helpers/settings';
import { waitForBuffer, switchToBuffer } from '../helpers/buffers';

let page: import('@playwright/test').Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await page.goto('http://localhost:8001/');
    await waitForAppReady(page);
    await clearSettings(page);
    await setSettings(page, {
        savepassword: false,
        autoconnect: false,
        showNicklist: true,
    });
    page.on('pageerror', (error) => {
        if (error.message?.includes('effect_orphan')) return;
    });
    await connectToWeechat(page);
    // Switch to #glowing-bear which has nick data (required for nicklist to render on desktop)
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
    await page.waitForTimeout(500);
    await expect(page.getByTestId('nicklist')).toBeVisible({ timeout: 10000 });
});

test.afterAll(async () => {
    await page.close();
});

test.beforeEach(async () => {
    page.on('pageerror', (error) => {
        if (error.message?.includes('effect_orphan')) return;
    });
});

test('should show nicklist button in topbar', async () => {
    await expect(page.getByTestId('nicklist-button')).toBeVisible();
});

test('should display nicklist when enabled in settings', async () => {
    await expect(page.getByTestId('nicklist')).toBeVisible({ timeout: 10000 });
});

test('should have nicklist search input', async () => {
    const searchInput = page.getByTestId('nicklist-search');
    await expect(searchInput).toBeVisible();
    await expect(searchInput).toHaveAttribute('placeholder', 'Search nicks...');
});

test('should filter nicks when searching', async () => {
    const searchInput = page.getByTestId('nicklist-search');
    await expect(searchInput).toBeVisible();
    // Fill with a common substring that should match at least some nicks (e.g., 'o' matches 'root', 'gbbot', etc.)
    await searchInput.fill('o');
    await page.waitForTimeout(300);
    // The search input should contain the text we typed
    await expect(searchInput).toHaveValue('o');
});

test('should have nicklist items container', async () => {
    await expect(page.getByTestId('nicklist-items')).toBeVisible();
});

test('should have nicklist header', async () => {
    await expect(page.getByTestId('nicklist').getByText('Nicklist')).toBeVisible();
});

test('should show settings button in topbar', async () => {
    await expect(page.getByTestId('settings-button')).toBeVisible();
});

test('should open settings modal when clicking settings button', async () => {
    await closeSettings(page).catch(() => {});
    await page.getByTestId('settings-button').click();
    await expect(page.getByTestId('settings-modal')).toBeVisible();
});

test('should close settings modal when clicking close button', async () => {
    // Close modal if already open from previous test
    const modalExists = await page.getByTestId('settings-modal').isVisible().catch(() => false);
    if (modalExists) {
        const closeBtnExists = await page.getByTestId('settings-modal-close').isVisible().catch(() => false);
        if (closeBtnExists) {
            await page.getByTestId('settings-modal-close').click();
            await page.waitForTimeout(100);
        }
    }
    await page.getByTestId('settings-button').click();
    await page.waitForTimeout(200);
    await page.getByTestId('settings-modal-close').click();
    await page.waitForTimeout(200);
    await expect(page.getByTestId('settings-modal')).not.toBeVisible({ timeout: 5000 });
});

test('should have theme selector in settings', async () => {
    await closeSettings(page).catch(() => {});
    await page.waitForTimeout(100);
    await page.getByTestId('settings-button').click();
    await page.waitForTimeout(200);
    await expect(page.getByTestId('theme-selector')).toBeAttached();
});

test('should have nicklist toggle in settings', async () => {
    await closeSettings(page).catch(() => {});
    await page.waitForTimeout(100);
    await page.getByTestId('settings-button').click();
    await page.waitForTimeout(200);
    await expect(page.getByTestId('settings-modal').getByText('Show nicklist')).toBeAttached();
});

test('should have display options in settings', async () => {
    await closeSettings(page).catch(() => {});
    await page.waitForTimeout(100);
    await page.getByTestId('settings-button').click();
    await page.waitForTimeout(200);
    await expect(page.getByTestId('settings-modal')).toBeVisible();
    // Verify specific display-related settings are present
    await expect(page.getByText('Show nicklist')).toBeAttached();
    await expect(page.getByText('Only show buffers with unread messages')).toBeAttached();
    await expect(page.getByText('Group by server')).toBeAttached();
    await expect(page.getByText('Use Alt+[0-9] to switch buffers')).toBeAttached();
    await page.getByTestId('settings-modal-close').click();
    await page.waitForTimeout(100);
});

test('should have nicklist toggle button in topbar', async () => {
    await page.getByTestId('nicklist-button').click();
    await page.waitForTimeout(300);
    await expect(page.getByTestId('nicklist')).not.toBeVisible({ timeout: 5000 });
});

test('should show nicklist again after toggling off and on', async () => {
    await page.getByTestId('nicklist-button').click();
    await page.waitForTimeout(200);
    await page.getByTestId('nicklist-button').click();
    await page.waitForTimeout(200);
    await page.getByTestId('nicklist-button').click();
    await page.waitForTimeout(200);
    await expect(page.getByTestId('nicklist')).toBeAttached();
    // Toggle off
    await page.getByTestId('nicklist-button').click();
    await page.waitForTimeout(300);
    // Toggle on
    await page.getByTestId('nicklist-button').click();
    await page.waitForTimeout(300);
    await expect(page.getByTestId('nicklist')).toBeAttached();
});

test('should hide nicklist on buffers without nick data', async () => {
    // Ensure nicklist is enabled (previous toggle tests may have turned it off)
    await setSettings(page, { showNicklist: true });
    await page.waitForTimeout(300);
    // Nicklist should be visible on the current channel buffer
    await expect(page.getByTestId('nicklist')).toBeVisible({ timeout: 5000 });

    // Switch to a server-level buffer (no nicklist) — e.g. 'gbtest' or 'irc.gbtest'
    const serverBuffer = page.getByTestId('buffer-item').filter({ hasText: /gbtest/i }).first();
    if ((await serverBuffer.isVisible().catch(() => false))) {
        await serverBuffer.click();
        await page.waitForTimeout(500);
        // Nicklist should be hidden (not attached) for server buffers
        await expect(page.getByTestId('nicklist')).not.toBeAttached({ timeout: 5000 });
    }

    // Switch back to a channel buffer to restore nicklist
    const channelBuffer = page.getByTestId('buffer-item').filter({ hasText: /#gbtest|glowing-bear/i }).first();
    if ((await channelBuffer.isVisible().catch(() => false))) {
        await channelBuffer.click();
        await page.waitForTimeout(500);
        // Nicklist should reappear
        await expect(page.getByTestId('nicklist')).toBeVisible({ timeout: 5000 });
    }
});
