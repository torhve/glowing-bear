import { Page, expect } from '@playwright/test';

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
  // Controlled Svelte inputs don't reliably respond to Playwright's fill().
  // Directly set DOM value and dispatch an input event to trigger the oninput handler.
  await page.evaluate((p) => {
    const input = document.querySelector('[data-testid="port-input"]');
    if (input) {
      (input as HTMLInputElement).value = p;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, port);
}

export async function connectToWeechat(page: Page) {
  await page.getByTestId('host-input').fill('localhost');
  await fillPortInput(page, '9001');
  await page.getByTestId('password-input').fill('testpassword123');
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
  await page.getByTestId('host-input').fill('localhost');
  await fillPortInput(page, '9001');
  await page.getByTestId('password-input').fill('testpassword123');
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
