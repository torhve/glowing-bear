import { test, expect } from '@playwright/test';
import { waitForAppReady } from '../helpers/connection';

test.describe.configure({ mode: 'serial' });

test.describe('Native PBKDF2-SHA256 auth (no crypto.subtle)', () => {
    test.beforeEach(async ({ page }) => {
        page.on('pageerror', (error) => {
            if (error.message?.includes('effect_orphan')) return;
        });
    });

    test.afterEach(async ({ page }) => {
        await page.close();
    });

    test('should connect via native PBKDF2-SHA256 when crypto.subtle is unavailable', async ({ browser }) => {
        // Block crypto.subtle to force native TypeScript fallback path
        const context = await browser.newContext();
        await context.addInitScript(() => {
            if (typeof crypto !== 'undefined' && 'subtle' in crypto) {
                delete (crypto as any).subtle;
            }
        });

        const page = await context.newPage();

        // Clear settings and load fresh page
        await page.goto('http://localhost:8001/');
        await page.evaluate(() => localStorage.removeItem('gb-settings'));
        await page.reload();
        await waitForAppReady(page);
        await expect(page.getByTestId('host-input')).toBeVisible({ timeout: 10000 });

        // Fill connection form — app uses native algo list: 'pbkdf2+sha256:sha256:plain'
        // Server returns empty password_hash_algo (non-default pbkdf2+sha256), which the
        // connectionManager handles by defaulting to pbkdf2+sha256.
        await page.getByTestId('host-input').fill('localhost');
        await page.evaluate(() => {
            const input = document.querySelector('[data-testid="port-input"]');
            if (input) {
                (input as HTMLInputElement).value = '9001';
                input.dispatchEvent(new Event('input', { bubbles: true }));
            }
        });
        await page.getByTestId('password-input').fill('testpassword123');
        await page.getByTestId('connect-button').click();

        // Native PBKDF2-SHA256 takes ~1-3s for 100k iterations — generous timeout
        await expect(page.getByTestId('chat-view')).toBeVisible({ timeout: 60000 });

        // Verify connected state
        await expect(page.getByTestId('disconnect-button')).toBeVisible({ timeout: 10000 });

        // Verify no hash algorithm mismatch error
        const errorDiv = page.locator('[data-error-type="hash-algorithm"]');
        await expect(errorDiv).not.toBeVisible({ timeout: 5000 });

        // Verify buffers loaded (full connection success)
        await expect(page.getByTestId('buffer-list')).toBeAttached({ timeout: 15000 });
    });
});
