import { Page, expect } from '@playwright/test';

export async function clearSettings(page: Page) {
  await page.evaluate(() => {
    localStorage.removeItem('gb-settings');
    localStorage.removeItem('gb-last-buffer');
  });
}

export async function setSettings(page: Page, settings: Record<string, unknown>) {
  await page.evaluate((s) => (window as any).__setGbSettings?.(s), settings);
}

export async function connectToWeechat(page: Page) {
  await page.getByTestId('host-input').fill('localhost');
  await page.getByTestId('port-input').fill('9001');
  await page.getByTestId('password-input').fill('testpassword123');
  await page.getByTestId('connect-button').click();
  await page.getByTestId('chat-view').waitFor({ state: 'visible', timeout: 45000 });
}

export async function disconnect(page: Page) {
  await page.getByTestId('disconnect-button').click();
  await page.waitForTimeout(4000);
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
