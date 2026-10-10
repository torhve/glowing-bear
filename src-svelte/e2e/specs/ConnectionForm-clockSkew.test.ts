import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { clearSettings, setSettings, waitForAppReady } from '../helpers/connection';
import { fillInput } from '../helpers/input';
import { setupEffectOrphanFilter } from '../helpers/pageerror';

test.describe.configure({ mode: 'serial' });

/**
 * Answer the version gate with the relay's own `{"error":"Invalid timestamp"}`.
 *
 * Only that one request is stubbed: the handshake probe still reaches the real
 * gbtest API relay, so the client really selects the API transport and really
 * classifies a real 401 body. Injecting the error flag instead would prove only
 * that the block renders, not that the client arrives at it from the wire.
 */
async function stubInvalidTimestamp(page: Page) {
    await page.route('**/api/version', (route) => route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Invalid timestamp' }),
    }));
}

/**
 * `autoconnect` is what makes a failure land as a retry loop ('reconnecting')
 * instead of a one-shot 'failed'. It is a setting, not a form field: the form's
 * own checkbox is DEBUG_FORM-only.
 */
async function openFormAndConnect(page: Page, opts: { autoconnect?: boolean } = {}) {
    await page.goto('http://localhost:8001/');
    await clearSettings(page);
    await page.reload();
    await waitForAppReady(page);
    if (opts.autoconnect) {
        await setSettings(page, { autoconnect: true });
    }
    await expect(page.getByTestId('host-input')).toBeVisible({ timeout: 10000 });
    await fillInput(page, 'host-input', 'localhost');
    await fillInput(page, 'port-input', '9010');
    await fillInput(page, 'password-input', 'testpassword123');
    await page.getByTestId('connect-button').click();
}

test.describe('Rejected login timestamp (clock skew)', () => {
    test.beforeEach(async ({ page }) => {
        setupEffectOrphanFilter(page);
    });

    test('explains a rejected timestamp as a clock problem, not a password or a network fault', async ({ page }) => {
        await stubInvalidTimestamp(page);
        await openFormAndConnect(page);

        const skew = page.locator('[data-error-type="clock-skew"]');
        await expect(skew, 'the relay named the cause; the form must repeat it').toBeVisible({ timeout: 15000 });
        await expect(skew).toContainText('timestamp');
        // The two things the user can actually act on.
        await expect(skew).toContainText('clock');
        await expect(skew).toContainText('relay.network.time_window');

        // What the same 401 used to be reported as. Both are false here: the
        // credential may be correct and the relay demonstrably answered.
        await expect(page.locator('[data-error-type="password-error"]')).toBeHidden();
        await expect(page.locator('[data-error-type="server-unreachable"]')).toBeHidden();
        // And the form must not stack its generic fallback on top of a named cause.
        await expect(page.locator('[data-error-type="connection-error"]')).toBeHidden();
    });

    test('keeps naming it while the retry loop is still running', async ({ page }) => {
        // autoconnect on: the failure lands as 'reconnecting', not 'failed'. A
        // cause that retrying cannot fix has to be said in that path too, or the
        // only trace of it is in the dev console.
        await stubInvalidTimestamp(page);
        await openFormAndConnect(page, { autoconnect: true });

        // The flag is what the transport's 'reconnecting' path set; the form's own
        // catch only changes the status afterwards, never the flags.
        await expect
            .poll(() => page.evaluate(() => (window as any).__connectionState?.reconnectAttempts), { timeout: 15000 })
            .toBeGreaterThan(0);
        await expect
            .poll(() => page.evaluate(() => (window as any).__connectionState?.errors?.clockSkewError), { timeout: 15000 })
            .toBe(true);
        await expect(page.locator('[data-error-type="clock-skew"]'), 'a live retry loop must still name the cause').toBeVisible();
    });
});
