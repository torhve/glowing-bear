import { test, expect } from '@playwright/test';
import { connectToWeechat, clearSettings, setSettings, waitForAppReady } from '../helpers/connection';
import { waitForBuffer, switchToBuffer } from '../helpers/buffers';
import { irc } from '../helpers/irc-control';

let page: import('@playwright/test').Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await page.route('**/cdnjs.cloudflare.com/**', (route) => route.abort());

    // Mock Audio to capture constructor calls for sound notification tests
    await page.addInitScript(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as any).__audioCalls = [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const OrigAudio = (window as any).Audio || function () {};
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as any).Audio = function (src: unknown) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (window as any).__audioCalls.push(src);
            return new OrigAudio(src);
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as any).Audio.prototype.play = function () {};
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as any).Audio.prototype.pause = function () {};

        // Force document.hidden = true so playNotificationSound triggers in headless
        try { Object.defineProperty(document, 'hidden', { value: true, writable: false, configurable: true }); } catch { /* noop */ }
    });

    await page.goto('http://localhost:8001/');
    await waitForAppReady(page);
    await clearSettings(page);
    await setSettings(page, {
        savepassword: false,
        autoconnect: false,
        soundnotification: true,
    });
    page.on('pageerror', (error) => {
        if (error.message?.includes('effect_orphan')) return;
    });
    await connectToWeechat(page);
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
});

test.afterAll(async () => {
    await page.close();
});

test.beforeEach(async () => {
    page.on('pageerror', (error) => {
        if (error.message?.includes('effect_orphan')) return;
    });
    await page.evaluate(() => {
        const w = window as unknown as Record<string, unknown>;
        w.__audioCalls = [];
    });
});

async function getAudioCalls(p: import('@playwright/test').Page): Promise<string[]> {
    return await p.evaluate(() => {
        const w = window as unknown as Record<string, unknown>;
        return (w.__audioCalls as string[]) || [];
    });
}

function fillPortInput(p: import('@playwright/test').Page, port: string) {
    return p.evaluate((p) => {
        const input = document.querySelector('[data-testid="port-input"]');
        if (input) {
            (input as HTMLInputElement).value = p;
            input.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }, port);
}

async function reconnectWithSound(page: import('@playwright/test').Page, enabled: boolean) {
    await clearSettings(page);
    await setSettings(page, { savepassword: false, autoconnect: false, soundnotification: enabled });
    await page.getByTestId('disconnect-button').click().catch(() => {});
    await page.waitForTimeout(2000);
    await page.getByTestId('host-input').fill('localhost');
    await fillPortInput(page, '9001');
    await page.getByTestId('password-input').fill('testpassword123');
    await page.getByTestId('connect-button').click();
    await page.getByTestId('chat-view').waitFor({ state: 'visible', timeout: 45000 });
}

test('sound plays on highlight when setting enabled', async () => {
    // Send a PM to trigger a notification sound (PMs always trigger highlights)
    await irc.sendPm('gbbot', 'notification-sound-test');
    await page.waitForTimeout(3000);

    const audioCalls = await getAudioCalls(page);
    expect(audioCalls.length).toBeGreaterThan(0);
});

test('sound does not play when soundnotification is disabled', async () => {
    await reconnectWithSound(page, false);
    await waitForBuffer(page, '#glowing-bear', 10000);
    await switchToBuffer(page, '#glowing-bear');
    await page.waitForTimeout(500);

    await irc.sendPm('gbbot', 'no-sound-test');
    await page.waitForTimeout(3000);

    const audioCalls = await getAudioCalls(page);
    expect(audioCalls.length).toBe(0);
});

test('sound setting toggle persists', async () => {
    await page.getByTestId('settings-button').click();
    await expect(page.getByTestId('settings-modal')).toBeVisible({ timeout: 5000 });

    const checkbox = page.getByTestId('sound-checkbox');
    await expect(checkbox).toBeChecked();

    await checkbox.uncheck();
    await expect(checkbox).not.toBeChecked();

    await page.getByTestId('settings-modal-close').click();
    await expect(page.getByTestId('settings-modal')).not.toBeVisible({ timeout: 5000 });

    // Reopen and verify
    await page.getByTestId('settings-button').click();
    await expect(page.getByTestId('settings-modal')).toBeVisible({ timeout: 5000 });
    await expect(checkbox).not.toBeChecked();
    await page.getByTestId('settings-modal-close').click();
});
