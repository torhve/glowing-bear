import { Page, expect } from '@playwright/test';
import { fillInput } from './input';

export async function clearSettings(page: Page, preserveLastBuffer = false) {
    await page.evaluate((preserve) => {
        localStorage.removeItem('gb-settings');
        if (!preserve) localStorage.removeItem('gb-last-buffer');
    }, preserveLastBuffer);
}

export async function setSettings(page: Page, settings: Record<string, unknown>) {
    await page.evaluate((s) => (window as any).__setGbSettings?.(s), settings);
}

export async function fillPortInput(page: Page, port: string) {
    await fillInput(page, 'port-input', port);
}

export async function connectToWeechat(page: Page) {
    await fillInput(page, 'host-input', 'localhost');
    await fillInput(page, 'port-input', '9001');
    await fillInput(page, 'password-input', 'testpassword123');
    await page.getByTestId('connect-button').click();
    await page.getByTestId('chat-view').waitFor({ state: 'visible', timeout: 45000 });
}

export async function reconnect(page: Page, options?: {
  extraSettings?: Record<string, unknown>;
  preserveLastBuffer?: boolean;
}) {
    const extraSettings = options?.extraSettings ?? {};
    const preserveLastBuffer = options?.preserveLastBuffer ?? false;
    await clearSettings(page, preserveLastBuffer);
    await setSettings(page, { savepassword: false, autoconnect: false, ...extraSettings });
    await page.getByTestId('disconnect-button').click().catch(() => {});
    await page.getByTestId('host-input').waitFor({ state: 'visible', timeout: 10000 });
    await fillInput(page, 'host-input', 'localhost');
    await fillInput(page, 'port-input', '9001');
    await fillInput(page, 'password-input', 'testpassword123');
    await page.getByTestId('connect-button').click();
    await page.getByTestId('chat-view').waitFor({ state: 'visible', timeout: 45000 });
}

export async function disconnect(page: Page) {
    await page.getByTestId('disconnect-button').click();
    await page.getByTestId('host-input').waitFor({ state: 'visible', timeout: 15000 });
}

export async function sendWeechatCommand(page: Page, command: string) {
    await page.evaluate((cmd) => (window as any).__sendWeechatCommand?.(cmd), command);
}

// Send a weechat command, then re-fetch config via infolist to update wconfig.
// WeeChat relay processes /set commands but doesn't emit events that update wconfig,
// so we explicitly fetch the option value afterward to sync the store.
// Uses a window-level flag because page.evaluate cannot await WS callback-based Promises.
export async function sendWeechatCommandAndWaitForConfig(
    page: Page, command: string, optionName: string, expectedValue: string, timeoutMs = 15000
): Promise<void> {
    await sendWeechatCommand(page, command);
    // Wait briefly for WeeChat to process the command
    await new Promise(r => setTimeout(r, 500));
    // Trigger infolist fetch and set a flag when done
    await page.evaluate((name) => {
        const fn = (window as any).__fetchConfValue;
        if (typeof fn !== 'function') return;
        fn(name).then(() => {
            (window as any).__confFetchDone = name;
        });
    }, optionName);
    // Poll until the fetch completes or overall timeout
    const overallStart = Date.now();
    while (Date.now() - overallStart < timeoutMs) {
        const done = await page.evaluate(() => (window as any).__confFetchDone);
        if (done === optionName) break;
        await new Promise(r => setTimeout(r, 200));
    }
    // Poll wconfig until the expected value appears or overall timeout
    while (Date.now() - overallStart < timeoutMs) {
        const val = await getConfigValue(page, optionName);
        if (val === expectedValue) return;
        await new Promise(r => setTimeout(r, 300));
    }
    throw new Error(`Timeout waiting for ${optionName}=${expectedValue}`);
}

export async function getConfigValue(page: Page, key: string): Promise<string> {
    return await page.evaluate((k) => {
        const wconfigObj = (window as any).__wconfig;
        if (!wconfigObj) return '';
        // Handle both store objects (with .get()) and plain record objects
        const value = typeof wconfigObj.get === 'function' ? wconfigObj.get() : wconfigObj;
        return value?.[k] ?? '';
    }, key);
}

export async function waitForAppReady(page: Page, timeout = 10000) {
    await expect(page.locator('body')).toHaveAttribute('data-app-ready', 'true', { timeout });
}
