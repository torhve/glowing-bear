/**
 * Focus reconnect, in a browser.
 *
 * The unit coverage in connection-lifecycle.test.ts stubs both inputs the handler
 * reads — it is handed a `pendingRetry` function and it redefines
 * `document.visibilityState`. That proves the decision (fire on a long wait, leave
 * a short one alone, never spend a TOTP code) but not the wiring, and the wiring is
 * what was broken: the facade used to register both transports' listeners, the
 * registration guard was first-wins, so on a legacy connection the handler asked
 * the null API orchestrator whether a retry was pending, always got "no", and the
 * early reconnect silently never happened.
 *
 * This spec arms a real backoff on a real legacy session and asks whether coming
 * back to the tab actually cuts in front of it.
 *
 * Honest limit: this harness cannot put a real tab in the background. Chromium's
 * CDP `Emulation.setPageVisibilityOverride` is not available to Playwright here
 * (measured: "'Emulation.setPageVisibilityOverride' wasn't found"), so the spec
 * dispatches the `visibilitychange` event the browser would have dispatched. What
 * it proves is that the app responds to that event through the transport that is
 * actually serving the session; it cannot prove the browser fires it, and that is
 * browser behaviour rather than app code.
 */
import { test, expect } from '@playwright/test';
import { setupEffectOrphanFilter } from '../helpers/pageerror';
import { connectLegacyToWeechat, setSettings } from '../helpers/connection';
import { waitForBuffer, switchToBuffer } from '../helpers/buffers';
import { waitForChatSettled } from '../helpers/waits';
import { waitForAppReady } from '../helpers/connection';

test.describe.configure({ mode: 'serial' });

/** Read the armed retry, then dispatch the event, in one browser turn so the two
 *  timestamps come from the page's clock and not from a Node clock beside it. */
async function dropAndDispatch(page: import('@playwright/test').Page) {
    await page.evaluate(() => {
        const socket = (window as any).__getWs?.();
        if (socket) socket.close(3000, 'test drop');
    });

    const countdown = page.getByTestId('connection-banner-countdown');
    await expect(countdown, 'the outage is reported as a wait, not as a dead end').toBeVisible({ timeout: 10000 });

    // `__connectionState` is the store's current value, not the store itself
    // (+page.svelte reassigns it to `$connectionState`), so this reads a snapshot.
    return page.evaluate(() => {
        const armedUntil = (window as any).__connectionState?.nextReconnectAt ?? 0;
        document.dispatchEvent(new Event('visibilitychange'));
        return { armedUntil, dispatchedAt: Date.now() };
    });
}

/**
 * Resolve at the moment the page reports a live session, and return the page's own
 * clock reading at that instant. Both timestamps must come from the page: the claim
 * under test is a comparison against a deadline the page armed.
 */
async function waitUntilConnected(page: import('@playwright/test').Page, timeoutMs: number) {
    const handle = await page.waitForFunction(
        () => ((window as any).__connectionState?.status === 'connected' ? Date.now() : false),
        null,
        { timeout: timeoutMs },
    );
    return handle.jsonValue() as number;
}

test.describe('coming back to the tab does not make the user wait out the backoff', () => {
    test.beforeEach(async ({ page }) => {
        setupEffectOrphanFilter(page);
        await page.goto('http://localhost:8001/');
        await page.evaluate(() => localStorage.removeItem('gb-settings'));
        await page.reload();
        await waitForAppReady(page);
    });

    test('a legacy session reconnects before its armed retry time', async ({ page }) => {
        await connectLegacyToWeechat(page);
        await waitForBuffer(page, '#glowing-bear');
        await switchToBuffer(page, '#glowing-bear');
        // After connecting: the Connect button writes autoconnect itself, so
        // setting it first is silently overwritten.
        await setSettings(page, { autoconnect: true });
        await waitForChatSettled(page);

        const { armedUntil, dispatchedAt } = await dropAndDispatch(page);
        expect(armedUntil, 'a retry is scheduled').toBeGreaterThan(0);
        // The first ladder step is 30 s and the focus threshold is 10 s, so a
        // correctly armed first retry is unambiguously in front of the threshold.
        expect(armedUntil - dispatchedAt, 'the wait left is long enough to cut in front of')
            .toBeGreaterThan(10_000);

        const connectedAt = await waitUntilConnected(page, 20_000);
        expect(connectedAt, 'the session came back').toBeGreaterThan(0);

        // The claim, stated as a comparison rather than a duration: the session was
        // live before the armed timer could have fired. A reconnect that arrived
        // from the backoff would land at or after `armedUntil`, so this fails if the
        // visibility change did nothing and passes only if it took over.
        expect(connectedAt - dispatchedAt, 'reconnected before the scheduled attempt was due')
            .toBeLessThan(armedUntil - dispatchedAt);

        await expect(page.getByTestId('connection-banner-countdown')).toBeHidden();
    });

    test('the takeover does not leave a second attempt armed behind it', async ({ page }) => {
        await connectLegacyToWeechat(page);
        await waitForBuffer(page, '#glowing-bear');
        await switchToBuffer(page, '#glowing-bear');
        await setSettings(page, { autoconnect: true });
        await waitForChatSettled(page);

        const { armedUntil, dispatchedAt } = await dropAndDispatch(page);
        expect(armedUntil, 'a retry is scheduled').toBeGreaterThan(0);

        const connectedAt = await waitUntilConnected(page, 20_000);
        expect(connectedAt, 'the session came back').toBeGreaterThan(0);
        expect(connectedAt - dispatchedAt, 'and it came back early').toBeLessThan(armedUntil - dispatchedAt);

        // The claim is about the retry loop, so it is asserted against the retry
        // loop rather than inferred from the session looking undisturbed.
        // `nextReconnectAt` cannot carry this: a manual takeover clears that display
        // field whether or not the timer it replaced is still running. `__pendingRetry`
        // reports the timer itself.
        const armedAfterTakeover = await page.evaluate(() => (window as any).__pendingRetry?.());
        expect(armedAfterTakeover?.active, 'the takeover cancelled the retry it replaced')
            .toBe(false);

        // Two further signals that the session itself was not replaced by something
        // that merely looked identical: the socket on screen is still the one the
        // takeover produced, and the status never left 'connected'.
        await page.evaluate((tag: string) => {
            const socket = (window as any).__getWs?.();
            if (socket) (socket as any).__focusProbeTag = tag;
            (window as any).__focusProbeTrace = [] as string[];
            (window as any).__focusProbeTimer = setInterval(() => {
                const status = (window as any).__connectionState?.status;
                const trace = (window as any).__focusProbeTrace as string[];
                if (status !== trace[trace.length - 1]) trace.push(status);
            }, 100);
        }, 'takeover-session');

        // Wait past the deadline the takeover replaced.
        const remaining = armedUntil - Date.now();
        if (remaining > 0) {
            // eslint-disable-next-line no-restricted-syntax -- pacing: this waits out the exact backoff deadline the takeover replaced, which is the thing under test
            await page.waitForTimeout(remaining + 3_000);
        }

        const after = await page.evaluate(() => {
            clearInterval((window as any).__focusProbeTimer);
            return {
                socketTag: ((window as any).__getWs?.() as any)?.__focusProbeTag,
                status: (window as any).__connectionState?.status,
                trace: (window as any).__focusProbeTrace as string[],
            };
        });

        const armedAfterDeadline = await page.evaluate(() => (window as any).__pendingRetry?.());
        expect(armedAfterDeadline?.active, 'and nothing re-armed across the old deadline').toBe(false);

        expect(after.socketTag, 'the same socket is still the live session — no second attempt opened beside it')
            .toBe('takeover-session');
        expect(after.trace, `the status never left 'connected' across the old deadline`)
            .toEqual(['connected']);
        expect(after.status).toBe('connected');
    });
});
