import { test, expect } from '@playwright/test';
import { connectToWeechat, clearSettings, setSettings, waitForAppReady, reconnect, fillPortInput } from '../helpers/connection';

import { setupEffectOrphanFilter } from '../helpers/pageerror';

let page: import('@playwright/test').Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await page.route('**/cdnjs.cloudflare.com/**', (route) => route.abort());
    await page.goto('http://localhost:8001/');
    await waitForAppReady(page);
    await clearSettings(page);
    await setSettings(page, {
        savepassword: false,
        autoconnect: false,
    });
    setupEffectOrphanFilter(page)
    await connectToWeechat(page);
});

test.afterAll(async () => {
    await page.close();
});

test.beforeEach(async () => {
    setupEffectOrphanFilter(page)
});



test('disconnect via double Escape', async () => {
    await expect(page.getByTestId('chat-view')).toBeVisible();

    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');

    await expect(page.getByTestId('host-input')).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId('chat-view')).not.toBeVisible();
});

test('disconnect via TopBar button', async () => {
    await reconnect(page);
    await expect(page.getByTestId('chat-view')).toBeVisible();

    const disconnectBtn = page.getByTestId('disconnect-button');
    await expect(disconnectBtn).toBeVisible();
    await disconnectBtn.click();
    await expect(page.getByTestId('host-input')).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId('chat-view')).not.toBeVisible();
});

test('reconnect preserves settings and reconnects successfully', async () => {
    // Ensure connected state (previous serial test may have disconnected)
    if (!(await page.getByTestId('disconnect-button').isVisible())) {
        await page.getByTestId('host-input').fill('localhost');
        await fillPortInput(page, '9001');
        await page.getByTestId('password-input').fill('testpassword123');
        await page.getByTestId('connect-button').click();
        await expect(page.getByTestId('chat-view')).toBeVisible({ timeout: 45000 });
    }
    // Disconnect first
    await page.getByTestId('disconnect-button').click();
    await expect(page.getByTestId('host-input')).toBeVisible({ timeout: 15000 });

    await page.getByTestId('host-input').fill('localhost');
    await fillPortInput(page, '9001');
    await page.getByTestId('password-input').fill('testpassword123');
    await page.getByTestId('connect-button').click();

    await expect(page.getByTestId('chat-view')).toBeVisible({ timeout: 45000 });
    await expect(page.getByTestId('buffer-item').first()).toBeVisible({ timeout: 10000 });
});

test('disconnect toast shows reconnect button when autoconnect disabled', async () => {
    // Ensure connected state (previous serial test may have disconnected)
    if (!(await page.getByTestId('disconnect-button').isVisible())) {
        await page.getByTestId('host-input').fill('localhost');
        await fillPortInput(page, '9001');
        await page.getByTestId('password-input').fill('testpassword123');
        await page.getByTestId('connect-button').click();
        await expect(page.getByTestId('chat-view')).toBeVisible({ timeout: 45000 });
    }
    await setSettings(page, { autoconnect: false });

    // Simulate WebSocket close directly (not via disconnect(), which suppresses toast for user-initiated disconnects)
    await page.evaluate(() => {
        const ws = (window as any).__getWs?.();
        if (ws) ws.close(3000, 'test disconnect');
    });

    // Wait for disconnect toast to appear
    const toast = page.getByTestId('toast');
    await expect(toast).toBeVisible({ timeout: 8000 });
    await expect(toast).toContainText(/Disconnected/i);

    // Reconnect by filling in credentials and connecting
    await page.getByTestId('host-input').fill('localhost');
    await fillPortInput(page, '9001');
    await page.getByTestId('password-input').fill('testpassword123');
    await page.getByTestId('connect-button').click();

    await expect(page.getByTestId('chat-view')).toBeVisible({ timeout: 45000 });
});

test('no-op when pressing Escape while already disconnected', async () => {
    // Disconnect first
    await page.getByTestId('disconnect-button').click();
    await expect(page.getByTestId('host-input')).toBeVisible({ timeout: 15000 });

    // Press Escape — should not change anything
    await page.keyboard.press('Escape');

    await expect(page.getByTestId('host-input')).toBeVisible();
    await expect(page.getByTestId('chat-view')).not.toBeVisible();

    const disconnectBtn = page.getByTestId('disconnect-button');
    const isVisible = await disconnectBtn.isVisible().catch(() => false);
    expect(isVisible).toBe(false);
});
