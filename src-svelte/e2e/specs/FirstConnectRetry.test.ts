import { test, expect } from '@playwright/test';
import { setupEffectOrphanFilter } from '../helpers/pageerror';
import { waitForAppReady } from '../helpers/connection';

/**
 * What auto-reconnect is supposed to mean when the relay is not there yet.
 *
 * `autoconnect` was a setting that only applied to sessions. A relay that was down
 * when the app opened was never retried on the legacy transport at all — status
 * `disconnected`, zero attempts, no countdown — however the user had configured it,
 * while the very same loss an hour later was retried with a ticking countdown. The
 * API transport retried the first attempt; the legacy transport did not, because
 * `handleReconnectDecision()` short-circuited on `wasEverConnected`.
 *
 * These specs pin the decision and, just as importantly, what the app *says* about
 * it. A rejected `connect()` is not the same fact as a stopped connection: when a
 * retry is armed, the app has already decided to try again, and a second message
 * telling the user to check their settings is not redundant but false. That pairing
 * is exactly what the legacy transport used to show — a "Connection failed. Check
 * settings and try again." toast beside a "Reconnecting in 30s..." toast.
 *
 * The banner is deliberately absent here. It is gated on a session being on screen
 * (`connected || retained`), and an app that never connected has no session to
 * retain — so the countdown toast is the user-visible retry signal, and that is what
 * these specs read rather than a banner that is not supposed to exist yet.
 */

test.describe.configure({ mode: 'serial' });

const DEAD_PORT = '9999';

async function openWithSettings(page: import('@playwright/test').Page, init: Record<string, unknown>) {
    // Seeded before load rather than typed into the form: the form populates its
    // fields from the settings store once on mount, and the address has to be the
    // failing one before the first attempt starts.
    await page.addInitScript((value: Record<string, unknown>) => {
        localStorage.setItem('gb-settings', JSON.stringify(value));
    }, init);
    await page.goto('http://localhost:8001/');
    await waitForAppReady(page);
}

async function readRetryState(page: import('@playwright/test').Page) {
    return page.evaluate(() => {
        const c = (window as any).__connectionState;
        return {
            status: c?.status as string,
            attempts: c?.reconnectAttempts as number,
            errors: Object.keys(c?.errors ?? {}).filter((k) => (c as any).errors[k]).sort(),
            armed: !!(window as any).__pendingRetry?.().active,
        };
    });
}

async function toastTexts(page: import('@playwright/test').Page) {
    return page.evaluate(() =>
        Array.from(document.querySelectorAll('[data-testid=toast]'))
            .map((el) => (el as HTMLElement).innerText.replace(/\s+/g, ' ').trim()));
}

for (const protocol of ['legacy', 'api'] as const) {
    test(`a relay that is down when the app opens is retried (${protocol})`, async ({ page }) => {
        setupEffectOrphanFilter(page);
        await openWithSettings(page, {
            protocol, autoconnect: true, hostField: '127.0.0.1', port: DEAD_PORT, tls: false,
            savepassword: false, password: '',
        });

        await page.getByTestId('connect-button').click();

        // The countdown toast is the promise the app is making: it will try again,
        // and it says when.
        const countdown = page.getByText(/Reconnecting in \d+s/);
        await expect(countdown).toBeVisible({ timeout: 10000 });

        const state = await readRetryState(page);
        expect(state.status, 'a retry in progress is not an error').toBe('reconnecting');
        expect(state.attempts, 'the first retry is attempt 1').toBe(1);
        expect(state.armed, 'a retry is actually armed, not just announced').toBe(true);

        // The false instruction. Before the attempt settled after the retry decision,
        // the form rejected its own await first and added this beside the countdown.
        const toasts = await toastTexts(page);
        expect(
            toasts.filter((t) => t.includes('Check settings and try again')),
            `a retry is already scheduled, so "check settings and try again" is false: ${JSON.stringify(toasts)}`,
        ).toHaveLength(0);
    });
}

test('a first connect the app will not retry is terminal, and names the cause', async ({ page }) => {
    setupEffectOrphanFilter(page);
    await openWithSettings(page, {
        protocol: 'legacy', autoconnect: false, hostField: '127.0.0.1', port: DEAD_PORT, tls: false,
        savepassword: false, password: '',
    });

    await page.getByTestId('connect-button').click();

    await expect.poll(() => readRetryState(page), { timeout: 10000 }).toMatchObject({
        status: 'error',
        armed: false,
    });

    const state = await readRetryState(page);
    expect(state.attempts, 'nothing was scheduled').toBe(0);
    expect(state.errors, 'an unreachable relay is named, not left as a bare error')
        .toContain('serverUnreachable');

    // Here the instruction IS correct: nothing is scheduled, so the user is the one
    // who has to act.
    const toasts = await toastTexts(page);
    expect(
        toasts.filter((t) => t.includes('Check settings and try again')),
        `a stopped retry loop should tell the user what to do: ${JSON.stringify(toasts)}`,
    ).toHaveLength(1);
});

test('a rejected credential is named as one by a relay that says so', async ({ page }) => {
    setupEffectOrphanFilter(page);
    // The API relay answers a wrong credential with a real 401, so this is the one
    // transport that can tell a rejected password apart from an unreachable host.
    //
    // What this deliberately does NOT assert is whether the app stops retrying it.
    // Measured against the live fixtures, neither transport treats a rejected
    // credential as terminal: the API relay names it `passwordError` and the retry
    // loop keeps going, and the legacy relay does not answer a wrong password with
    // 401 at all — it closes without a code, which reaches the app as 1006 and is
    // named `serverUnreachable`. Whether a named credential rejection should end the
    // loop is an open decision, not a property of this change, so it is recorded here
    // rather than pinned. The 401/403 branch that *is* reachable is pinned at unit
    // level in `first-connect-retry.test.ts`, where a synthetic close code can be
    // given directly instead of hoping a relay produces one.
    await openWithSettings(page, {
        protocol: 'api', autoconnect: true, hostField: '127.0.0.1', port: '9010', tls: false,
        savepassword: false, password: 'wrong-password-entirely',
    });

    await page.getByTestId('connect-button').click();

    await expect.poll(() => readRetryState(page), { timeout: 15000 }).toMatchObject({
        errors: expect.arrayContaining(['passwordError']),
    });
});
