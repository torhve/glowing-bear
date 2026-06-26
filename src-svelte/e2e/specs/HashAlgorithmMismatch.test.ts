import { test, expect } from '@playwright/test';
import { connectToWeechat, waitForAppReady } from '../helpers/connection';

import { setupEffectOrphanFilter } from '../helpers/pageerror';

test.describe.configure({ mode: 'serial' });

test.describe('Hash algorithm mismatch error display', () => {
    test.beforeEach(async ({ page }) => {
        setupEffectOrphanFilter(page)
    });

    test('should display hash algorithm error message when server rejects plain auth', async ({ page }) => {
        await page.goto('http://localhost:8001/');
        await page.evaluate(() => localStorage.removeItem('gb-settings'));
        await page.reload();
        await waitForAppReady(page);
        await expect(page.getByTestId('host-input')).toBeVisible({ timeout: 10000 });

        // Inject hashAlgorithmDisagree via the exposed store setter
        await page.evaluate(() => {
            const setErrors = (window as any).__setConnectionErrors;
            if (setErrors) setErrors({ hashAlgorithmDisagree: true });
        });

        const errorDiv = page.locator('[data-error-type="hash-algorithm"]');
        await expect(errorDiv).toBeVisible({ timeout: 5000 });
        await expect(errorDiv).toContainText('Hash algorithm mismatch');
        await expect(errorDiv).toContainText('pbkdf2+sha512');
    });

    test('should render both passwordError and hashAlgorithmDisagree independently', async ({ page }) => {
        await page.goto('http://localhost:8001/');
        await page.evaluate(() => localStorage.removeItem('gb-settings'));
        await page.reload();
        await waitForAppReady(page);
        await expect(page.getByTestId('host-input')).toBeVisible({ timeout: 10000 });

        await page.evaluate(() => {
            const setErrors = (window as any).__setConnectionErrors;
            if (setErrors) setErrors({ passwordError: true, hashAlgorithmDisagree: true });
        });

        await expect(page.locator('[data-error-type="hash-algorithm"]')).toBeVisible({ timeout: 5000 });
        await expect(page.locator('[data-error-type="password-error"]')).toBeVisible({ timeout: 5000 });
    });

    test('connection form shows hash algorithm error after injected state', async ({ page }) => {
        // Fresh setup - start clean
        await page.goto('http://localhost:8001/');
        await page.evaluate(() => localStorage.removeItem('gb-settings'));
        await page.reload();
        await waitForAppReady(page);
        await expect(page.getByTestId('host-input')).toBeVisible({ timeout: 10000 });

        // Inject hash algorithm mismatch error
        await page.evaluate(() => {
            const setErrors = (window as any).__setConnectionErrors;
            if (setErrors) setErrors({ hashAlgorithmDisagree: true });
        });

        // Verify error is visible on the connection form
        await expect(page.locator('[data-error-type="hash-algorithm"]')).toBeVisible({ timeout: 5000 });

        // Verify the connect button is still clickable (not disabled by auth error alone)
        await expect(page.getByTestId('connect-button')).toBeEnabled();
    });
});
