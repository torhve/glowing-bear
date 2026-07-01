import { test, expect } from '@playwright/test';
import { createConnectedPage } from '../fixtures/auth';

test.describe.configure({ mode: 'serial' });

test.describe('Native PBKDF2-SHA256 auth (no crypto.subtle)', () => {
    test('should connect via native PBKDF2-SHA256 when crypto.subtle is unavailable', async ({ browser }) => {
        // Block crypto.subtle to force native TypeScript fallback path
        const context = await browser.newContext();
        await context.addInitScript(() => {
            if (typeof crypto !== 'undefined' && 'subtle' in crypto) {
                delete (crypto as any).subtle;
            }
        });
        const page = await createConnectedPage(context, { blockCdn: false });

        // Verify connected state
        await expect(page.getByTestId('chat-view')).toBeVisible({ timeout: 60000 });
        await expect(page.getByTestId('disconnect-button')).toBeVisible({ timeout: 10000 });

        // Verify no hash algorithm mismatch error
        const errorDiv = page.locator('[data-error-type="hash-algorithm"]');
        await expect(errorDiv).not.toBeVisible({ timeout: 5000 });

        // Verify buffers loaded (full connection success)
        await expect(page.getByTestId('buffer-list')).toBeAttached({ timeout: 15000 });
    });
});
