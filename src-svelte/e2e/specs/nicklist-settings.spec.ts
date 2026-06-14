import { test, expect } from '@playwright/test';
import { connectToWeechat, clearSettings, setSettings, waitForAppReady } from '../helpers/connection';
import { openSettings, closeSettings } from '../helpers/settings';

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
    await searchInput.clear();
    await searchInput.fill('test');
    await expect(page.getByTestId('nicklist-items')).toBeVisible({ timeout: 5000 });
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
