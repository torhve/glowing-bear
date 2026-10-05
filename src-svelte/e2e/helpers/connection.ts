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

export async function connectToWeechat(page: Page, port = '9010') {
    await fillInput(page, 'host-input', 'localhost');
    await fillInput(page, 'port-input', port);
    await fillInput(page, 'password-input', 'testpassword123');
    await page.getByTestId('connect-button').click();
    await page.getByTestId('chat-view').waitFor({ state: 'visible', timeout: 45000 });
}

/**
 * Connect to the legacy relay (port 9001) with the protocol override set to
 * 'legacy'. The override skips the API handshake probe, which would burn the
 * full probe timeout against a relay that never answers HTTP. Auto-detection
 * itself is covered explicitly in Dual-protocol.test.ts.
 */
export async function connectLegacyToWeechat(page: Page) {
    await setSettings(page, { protocol: 'legacy' });
    await connectToWeechat(page, '9001');
    await waitForTransport(page, 'legacy');
}

/** Wait until the facade has settled on the expected transport. */
export async function waitForTransport(page: Page, transport: 'api' | 'legacy', timeout = 15000) {
    await expect.poll(async () => page.evaluate(() => {
        const w = window as any;
        const hasSession = !!w.__getSession?.();
        const hasWs = !!w.__getWs?.();
        if (hasSession && !hasWs) return 'api';
        if (hasWs && !hasSession) return 'legacy';
        return 'none';
    }), { timeout }).toBe(transport);
}

/** Read a WeeChat config value from wconfig (populated by the legacy
 *  handshake; the API transport has no config endpoint). */
export async function getConfigValue(page: Page, key: string): Promise<string | undefined> {
    return page.evaluate((k) => {
        const w = (window as any).__wconfig;
        if (typeof w?.subscribe === 'function') {
            let value: Record<string, string> | undefined;
            const unsub = w.subscribe((v: Record<string, string>) => { value = v; });
            unsub();
            return value?.[k];
        }
        return w?.[k];
    }, key);
}

export async function reconnect(page: Page, options?: {
  extraSettings?: Record<string, unknown>;
  preserveLastBuffer?: boolean;
  port?: string;
}) {
    const extraSettings = options?.extraSettings ?? {};
    const preserveLastBuffer = options?.preserveLastBuffer ?? false;
    const port = options?.port ?? '9010';
    await clearSettings(page, preserveLastBuffer);
    await setSettings(page, { savepassword: false, autoconnect: false, ...extraSettings });
    await page.getByTestId('disconnect-button').click().catch(() => {});
    await page.getByTestId('host-input').waitFor({ state: 'visible', timeout: 10000 });
    await fillInput(page, 'host-input', 'localhost');
    await fillInput(page, 'port-input', port);
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

export async function waitForAppReady(page: Page, timeout = 10000) {
    await expect(page.locator('body')).toHaveAttribute('data-app-ready', 'true', { timeout });
}
