import { test, expect } from '@playwright/test';
import { connectToWeechat, connectLegacyToWeechat, waitForAppReady, waitForTransport, setSettings, disconnect } from '../helpers/connection';

import { waitForBuffer, switchToBuffer } from '../helpers/buffers';
import { fillInput } from '../helpers/input';
import { irc } from '../helpers/irc-control';
import { setupEffectOrphanFilter } from '../helpers/pageerror';

// Dual-protocol transport selection, tested against the two REAL relays the
// gbtest fixture runs on one WeeChat instance:
//   9001 — legacy WebSocket relay (the fallback path)
//   9010 — API relay (WeeChat >= 4.10.1)
// No transport mocking: every test exercises the actual wire protocol.

test.describe.configure({ mode: 'serial' });

async function freshPage(browser: import('@playwright/test').Browser) {
    const page = await browser.newPage();
    setupEffectOrphanFilter(page);
    await page.goto('http://localhost:8001/');
    await page.evaluate(() => localStorage.removeItem('gb-settings'));
    await page.reload();
    await waitForAppReady(page);
    await expect(page.getByTestId('host-input')).toBeVisible({ timeout: 10000 });
    return page;
}

async function connectExpectError(page: import('@playwright/test').Page, port: string) {
    await fillInput(page, 'host-input', 'localhost');
    await fillInput(page, 'port-input', port);
    await fillInput(page, 'password-input', 'testpassword123');
    await page.getByTestId('connect-button').click();
    await expect(page.getByTestId('error-message').first()).toBeVisible({ timeout: 25000 });
    // The failed attempt must not leave a phantom connection behind.
    await expect(page.getByTestId('chat-view')).not.toBeVisible();
}

test.describe('Dual-protocol transport selection', () => {
    test('auto-detection picks the API relay on the API port', async ({ browser }) => {
        const page = await freshPage(browser);
        await connectToWeechat(page, '9010');
        await waitForTransport(page, 'api');
        await page.close();
    });

    test('auto-detection falls back to legacy on the legacy port', async ({ browser }) => {
        const page = await freshPage(browser);
        // No protocol override: the handshake probe gets no HTTP answer from
        // the legacy relay, times out, and the legacy path takes over.
        await connectToWeechat(page, '9001');
        await waitForTransport(page, 'legacy', 30000);
        await page.close();
    });

    test('legacy transport receives channel messages', async ({ browser }) => {
        const page = await freshPage(browser);
        await connectLegacyToWeechat(page);
        await waitForBuffer(page, '#glowing-bear');
        await switchToBuffer(page, '#glowing-bear');
        await expect(page.getByTestId('topic-bar')).toBeVisible({ timeout: 5000 });

        const text = `legacy-wire-${Date.now()}`;
        await irc.sendMessage('#glowing-bear', text);
        await expect(page.getByText(text).first()).toBeVisible({ timeout: 20000 });
        await page.close();
    });

    test('legacy transport sends messages and recalls input history', async ({ browser }) => {
        const page = await freshPage(browser);
        await connectLegacyToWeechat(page);
        await waitForBuffer(page, '#glowing-bear');
        await switchToBuffer(page, '#glowing-bear');
        await expect(page.getByTestId('topic-bar')).toBeVisible({ timeout: 5000 });

        const text = `legacy-send-${Date.now()}`;
        const input = page.getByTestId('message-input');
        await input.focus();
        await page.evaluate((t) => {
            const el = document.querySelector('[data-testid="message-input"]') as HTMLTextAreaElement;
            el.value = t;
            el.dispatchEvent(new Event('input', { bubbles: true }));
        }, text);
        await input.press('Enter');

        // The echo comes back over the legacy wire, not the REST event stream.
        await expect(page.getByText(text).first()).toBeVisible({ timeout: 20000 });

        // ArrowUp recalls the sent line from per-buffer input history.
        await input.fill('');
        await input.press('ArrowUp');
        await expect(input).toHaveValue(text, { timeout: 5000 });
        await page.close();
    });

    test('legacy transport completes nicks client-side', async ({ browser }) => {
        const page = await freshPage(browser);
        await connectLegacyToWeechat(page);
        await waitForBuffer(page, '#glowing-bear');
        await switchToBuffer(page, '#glowing-bear');
        await page.getByTestId('nicklist').locator('[data-testid="nick-item"]').first()
            .waitFor({ state: 'visible', timeout: 10000 });

        // The legacy handshake populates wconfig in bulk (the API path has no
        // config endpoint); client-side completion reads nick_completer from it.
        const configKeys = await page.evaluate(() => {
            // +page exposes __wconfig as the store initially and as the plain
            // snapshot object once its effect has run; handle both shapes.
            const w = (window as any).__wconfig;
            if (typeof w?.subscribe === 'function') {
                let value: Record<string, unknown> | undefined;
                const unsub = w.subscribe((v: Record<string, unknown>) => { value = v; });
                unsub();
                return Object.keys(value ?? {}).length;
            }
            return Object.keys(w ?? {}).length;
        });
        expect(configKeys).toBeGreaterThan(0);

        const input = page.getByTestId('message-input');
        await input.focus();
        await page.evaluate(() => {
            const el = document.querySelector('[data-testid="message-input"]') as HTMLTextAreaElement;
            el.value = 'gbb';
            el.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await input.press('Tab');

        await expect(async () => {
            const val = await input.inputValue();
            expect(val).toMatch(/^gbbot2?:/);
        }).toPass({ timeout: 8000 });
        await page.close();
    });

    test('api override fails cleanly against the legacy relay', async ({ browser }) => {
        const page = await freshPage(browser);
        await setSettings(page, { protocol: 'api' });
        await connectExpectError(page, '9001');
        await page.close();
    });

    test('legacy override fails cleanly against the API relay', async ({ browser }) => {
        const page = await freshPage(browser);
        await setSettings(page, { protocol: 'legacy' });
        await connectExpectError(page, '9010');
        await page.close();
    });

    test('legacy transport survives a dropped socket and reconnects on legacy', async ({ browser }) => {
        test.setTimeout(120_000); // 3s probe + 30s backoff + reconnect + wire check
        const page = await freshPage(browser);
        await connectToWeechat(page, '9001'); // auto → legacy
        // Set autoconnect after the form submitted its own settings — the
        // connect form writes the full settings object on submit.
        await setSettings(page, { autoconnect: true });
        await waitForTransport(page, 'legacy', 30000);
        await waitForBuffer(page, '#glowing-bear');
        await switchToBuffer(page, '#glowing-bear');

        // Simulate a dropped wire: close the live legacy socket with a
        // non-normal code so the auto-reconnect path engages. The first
        // backoff step is 30s (initialReconnectDelay), so the wait windows
        // below must exceed it.
        await page.evaluate(() => {
            const ws = (window as any).__getWs?.();
            if (ws) ws.close(3000, 'test drop');
        });

        // The profile cache must reconnect on the same transport without
        // re-probing, and the legacy wire must work again afterwards.
        await waitForTransport(page, 'legacy', 60000);
        const text = `legacy-reconnect-${Date.now()}`;
        await irc.sendMessage('#glowing-bear', text);
        await expect(page.getByText(text).first()).toBeVisible({ timeout: 25000 });
        await page.close();
    });

    test('explicit disconnect clears the transport profile for re-detection', async ({ browser }) => {
        const page = await freshPage(browser);
        await connectToWeechat(page, '9010'); // auto → api
        await waitForTransport(page, 'api');
        await disconnect(page);
        // Same host, legacy port: the cleared profile must re-detect and fall
        // back to legacy instead of reusing the cached API choice.
        await connectToWeechat(page, '9001');
        await waitForTransport(page, 'legacy', 30000);
        await page.close();
    });

});
