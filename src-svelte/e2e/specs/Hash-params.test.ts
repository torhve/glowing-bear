import { test, expect } from '@playwright/test';
import { waitForAppReady } from '../helpers/connection';

import { setupEffectOrphanFilter } from '../helpers/pageerror';

test.describe('Hash params', () => {
    test.beforeEach(async ({ page }) => {
        setupEffectOrphanFilter(page)
        // Clear settings on the base page before navigating to hash URL
        await page.goto('http://localhost:8001/');
        await page.evaluate(() => {
            try { localStorage.removeItem('gb-settings'); } catch {}
            try { localStorage.removeItem('gb-last-buffer'); } catch {}
        });
    });

    test('should prefill host from hash parameter', async ({ page }) => {
        await page.goto('http://localhost:8001/#host=my.domain.com');
        await page.reload();
        await waitForAppReady(page);
        await expect(page.getByTestId('host-input')).toHaveValue('my.domain.com');
    });

    test('should prefill port from hash parameter', async ({ page }) => {
        await page.goto('http://localhost:8001/#port=9001');
        await page.reload();
        await waitForAppReady(page);
        await expect(page.getByTestId('port-input')).toHaveValue('9001');
    });

    test('should prefill password from hash parameter', async ({ page }) => {
        await page.goto('http://localhost:8001/#password=hunter2');
        await page.reload();
        await waitForAppReady(page);
        const passwordInput = page.getByTestId('password-input');
        await expect(passwordInput).toBeVisible();
        const value = await passwordInput.evaluate((el: HTMLInputElement) => el.value);
        expect(value).toBe('hunter2');
    });

    test('should prefill autoconnect from hash parameter', async ({ page }) => {
        await page.goto('http://localhost:8001/#autoconnect=true&savepassword=true');
        await page.reload();
        await waitForAppReady(page);
        await page.getByTestId('savepassword-checkbox').check();
        await expect(page.getByTestId('autoconnect-checkbox')).toBeChecked();
    });

    test('should handle URL-encoded values', async ({ page }) => {
        await page.goto('http://localhost:8001/#host=my%2Edomain%2Ecom&password=p%40ss');
        await page.reload();
        await waitForAppReady(page);
        await expect(page.getByTestId('host-input')).toHaveValue('my.domain.com');
        const passwordInput = page.getByTestId('password-input');
        const value = await passwordInput.evaluate((el: HTMLInputElement) => el.value);
        expect(value).toBe('p@ss');
    });

    test('should combine host, port, and path into hostField', async ({ page }) => {
        await page.goto('http://localhost:8001/#host=localhost&port=9001&path=weechat2');
        await page.reload();
        await waitForAppReady(page);
        await expect(page.getByTestId('host-input')).toHaveValue('localhost:9001/weechat2');
    });

    test('should override stored settings with hash params', async ({ page }) => {
        // First set some stored settings
        await page.evaluate(() => {
            (window as any).__setGbSettings?.({ hostField: 'stored.host', port: '8080' });
        });
        // Navigate with different hash params
        await page.goto('http://localhost:8001/#host=hash.host&port=9001');
        await page.reload();
        await waitForAppReady(page);
        await expect(page.getByTestId('host-input')).toHaveValue('hash.host');
        await expect(page.getByTestId('port-input')).toHaveValue('9001');
    });

    test('should re-apply hash params on hash change', async ({ page }) => {
        await page.goto('http://localhost:8001/#host=initial.host');
        await waitForAppReady(page);
        await expect(page.getByTestId('host-input')).toHaveValue('initial.host');

        // Change the hash - this triggers onhashchange listener
        await page.evaluate(() => { window.location.hash = '#host=new.host'; });
        await expect(page.getByTestId('host-input')).toHaveValue('new.host', { timeout: 5000 });
    });

    test('should handle autoconnect=false', async ({ page }) => {
        await page.goto('http://localhost:8001/#autoconnect=true');
        await page.reload();
        await waitForAppReady(page);
        await page.getByTestId('savepassword-checkbox').check();
        await expect(page.getByTestId('autoconnect-checkbox')).toBeChecked();

        // Now set autoconnect=false via hash change
        await page.evaluate(() => { window.location.hash = '#autoconnect=false'; });
        await expect(page.getByTestId('autoconnect-checkbox')).not.toBeChecked({ timeout: 5000 });
    });

    test('should handle empty hash gracefully', async ({ page }) => {
        await page.goto('http://localhost:8001/');
        await waitForAppReady(page);
        const hostInput = page.getByTestId('host-input');
        await expect(hostInput).toBeVisible();
    });

    test('should ignore malformed hash params', async ({ page }) => {
        await page.goto('http://localhost:8001/#host=localhost&badparam&port=9001');
        await page.reload();
        await waitForAppReady(page);
        await expect(page.getByTestId('host-input')).toHaveValue('localhost');
        await expect(page.getByTestId('port-input')).toHaveValue('9001');
    });
});
