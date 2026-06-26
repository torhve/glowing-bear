import { test, expect } from '@playwright/test';
import { waitForAppReady } from '../helpers/connection';

import { setupEffectOrphanFilter } from '../helpers/pageerror';

test.describe('Features', () => {
    test.beforeEach(async ({ page }) => {
        setupEffectOrphanFilter(page)
        // Clear saved settings and unregister service workers to avoid stale state bleed between test files
        await page.goto('http://localhost:8001/');
        await page.evaluate(() => localStorage.removeItem('gb-settings'));
        await page.evaluate(async () => {
            const registrations = await navigator.serviceWorker.getRegistrations();
            for (const reg of registrations) {
                await reg.unregister();
            }
        });
        await page.reload();
        await waitForAppReady(page);
    });

    test('should display all help panels on connection form', async ({ page }) => {
        const details = page.locator('details');
        // 6 panels: About (open by default), Connection settings, Getting Started, Usage, Install app, Get involved
        await expect(details).toHaveCount(6);
        await expect(details.nth(0).locator('summary')).toContainText('About');
        await expect(details.nth(1).locator('summary')).toContainText('Connection settings');
        await expect(details.nth(2).locator('summary')).toContainText('Getting Started');
        await expect(details.nth(3).locator('summary')).toContainText('Usage instructions');
        await expect(details.nth(4).locator('summary')).toContainText('Install app');
        await expect(details.nth(5).locator('summary')).toContainText('Get involved');
    });

    test('should toggle help panel content', async ({ page }) => {
        // Use the second details panel (Connection settings) which starts closed
        const details = page.locator('details').nth(1);
        await details.locator('summary').click();
        await expect(details.locator('div')).toBeVisible();
        await details.locator('summary').click();
    });

    test('should validate host input on blur', async ({ page }) => {
        const input = page.getByTestId('host-input');
        await input.clear();
        await input.pressSequentially('invalid host!@#', { delay: 10 });
        await input.blur();
        await expect(input).toHaveClass(/border-danger/);
    });

    test('should accept valid IPv4 address', async ({ page }) => {
        const input = page.getByTestId('host-input');
        await input.clear();
        await input.fill('192.168.1.1');
        await input.blur();
        await expect(input).not.toHaveClass(/border-danger/);
    });

    test('should accept valid hostname', async ({ page }) => {
        const input = page.getByTestId('host-input');
        await input.clear();
        await input.fill('irc.example.com');
        await input.blur();
        await expect(input).not.toHaveClass(/border-danger/);
    });

    test('should accept IPv6 address', async ({ page }) => {
        const input = page.getByTestId('host-input');
        await input.clear();
        await input.fill('[::1]');
        await input.blur();
        await expect(input).not.toHaveClass(/border-danger/);
    });

    test('should accept host with port', async ({ page }) => {
        const input = page.getByTestId('host-input');
        await input.clear();
        await input.fill('localhost:9001');
        await input.blur();
        await expect(input).not.toHaveClass(/border-danger/);
    });

    test('should accept host with path', async ({ page }) => {
        const input = page.getByTestId('host-input');
        await input.clear();
        await input.fill('localhost/weechat');
        await input.blur();
        await expect(input).not.toHaveClass(/border-danger/);
    });

    test('should accept host with port and path', async ({ page }) => {
        const input = page.getByTestId('host-input');
        await input.clear();
        await input.fill('localhost:9001/weechat');
        await input.blur();
        await expect(input).not.toHaveClass(/border-danger/);
    });

    test('should show app title and subtitle', async ({ page }) => {
        await expect(page.locator('h1')).toContainText('Glowing Bear');
        await expect(page.locator('p.text-sm')).toContainText('WeeChat web frontend');
    });

    test('should have proper page structure', async ({ page }) => {
        await expect(page.locator('div.min-h-dvh')).toBeVisible();
        await expect(page.locator('div.connection-card')).toBeVisible();
        await expect(page.locator('form.connection-form')).toBeVisible();
    });

    test('should persist inputs after reload', async ({ page }) => {
        const hostInput = page.getByTestId('host-input');
        const portInput = page.getByTestId('port-input');
        const savePasswordCheck = page.getByTestId('savepassword-checkbox');
        
        await hostInput.clear();
        await hostInput.pressSequentially('localhost', { delay: 50 });
        await portInput.clear();
        await portInput.pressSequentially('9001', { delay: 50 });
        await savePasswordCheck.check();
        await page.reload();
        await expect(hostInput).toHaveValue('localhost');
        await expect(portInput).toHaveValue('9001');
        await expect(savePasswordCheck).toBeChecked();
    });
});
