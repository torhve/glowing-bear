import { test, expect } from '@playwright/test';
import { createConnectedPage } from '../fixtures/auth';

test.describe.configure({ mode: 'serial' });

// Both transports implement a pure-JS PBKDF2-SHA256 fallback for browsers
// without crypto.subtle (they advertise only the algorithms they can compute).
test.describe('Native PBKDF2-SHA256 auth (no crypto.subtle)', () => {
    const blockSubtle = () => {
        if (typeof crypto !== 'undefined' && 'subtle' in crypto) {
            delete (crypto as any).subtle;
        }
    };

    test('should connect via native PBKDF2-SHA256 on the API relay', async ({ browser }) => {
        const context = await browser.newContext();
        await context.addInitScript(blockSubtle);
        const page = await createConnectedPage(context, { blockCdn: false });

        await expect(page.getByTestId('chat-view')).toBeVisible({ timeout: 60000 });
        await expect(page.getByTestId('disconnect-button')).toBeVisible({ timeout: 10000 });

        const errorDiv = page.locator('[data-error-type="hash-algorithm"]');
        await expect(errorDiv).not.toBeVisible({ timeout: 5000 });

        await expect(page.getByTestId('buffer-list')).toBeAttached({ timeout: 15000 });
        await page.close();
    });

    test('should connect via native PBKDF2-SHA256 on the legacy relay', async ({ browser }) => {
        const context = await browser.newContext();
        await context.addInitScript(blockSubtle);
        const page = await createConnectedPage(context, {
            blockCdn: false,
            port: '9001',
            settings: { protocol: 'legacy' },
        });

        await expect(page.getByTestId('chat-view')).toBeVisible({ timeout: 60000 });
        await expect(page.getByTestId('disconnect-button')).toBeVisible({ timeout: 10000 });

        const errorDiv = page.locator('[data-error-type="hash-algorithm"]');
        await expect(errorDiv).not.toBeVisible({ timeout: 5000 });

        await expect(page.getByTestId('buffer-list')).toBeAttached({ timeout: 15000 });
        await page.close();
    });
});
