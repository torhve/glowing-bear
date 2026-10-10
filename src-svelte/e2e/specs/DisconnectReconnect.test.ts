import { test, expect } from '@playwright/test';
import { setSettings, reconnect } from '../helpers/connection';
import { createConnectedPage } from '../fixtures/auth';

let page: import('@playwright/test').Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
    page = await createConnectedPage(browser, {
        settings: { savepassword: false, autoconnect: false },
    });
});

test.afterAll(async () => {
    await page.close();
});

test.beforeEach(async () => {
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
        await page.getByTestId('port-input').fill('9010');
        await page.getByTestId('password-input').fill('testpassword123');
        await page.getByTestId('connect-button').click();
        await expect(page.getByTestId('chat-view')).toBeVisible({ timeout: 45000 });
    }
    // Disconnect first
    await page.getByTestId('disconnect-button').click();
    await expect(page.getByTestId('host-input')).toBeVisible({ timeout: 15000 });

    await page.getByTestId('host-input').fill('localhost');
    await page.getByTestId('port-input').fill('9010');
    await page.getByTestId('password-input').fill('testpassword123');
    await page.getByTestId('connect-button').click();

    await expect(page.getByTestId('chat-view')).toBeVisible({ timeout: 45000 });
    await expect(page.getByTestId('buffer-item').first()).toBeVisible({ timeout: 10000 });
});

// Rewritten with the retained shell: the toast that used to carry this is
// suppressed while the banner is on screen, and the way back is the banner's
// "Edit connection" action revealing the form over the retained chat.
test('banner offers a way back when autoconnect is disabled', async () => {
    // Ensure connected state (previous serial test may have disconnected)
    if (!(await page.getByTestId('disconnect-button').isVisible())) {
        await page.getByTestId('host-input').fill('localhost');
        await page.getByTestId('port-input').fill('9010');
        await page.getByTestId('password-input').fill('testpassword123');
        await page.getByTestId('connect-button').click();
        await expect(page.getByTestId('chat-view')).toBeVisible({ timeout: 45000 });
    }
    await setSettings(page, { autoconnect: false });

    // Simulate WebSocket close directly (not via disconnect(), which suppresses toast for user-initiated disconnects)
    await page.evaluate(() => {
        const ws = (window as any).__getSession?.()?.getSocket?.();
        if (ws) ws.close(3000, 'test disconnect');
    });

    // The banner presents the loss, and the toast does not repeat it.
    const banner = page.getByTestId('connection-banner');
    await expect(banner).toBeVisible({ timeout: 8000 });
    await expect(banner).toContainText(/lost|reached/i);
    await expect(page.getByTestId('toast')).not.toBeVisible();

    // Reconnect by editing the connection: the form appears over the retained
    // chat, credentials are filled in, and Connect runs.
    await page.getByTestId('connection-banner-edit').click();
    await expect(page.getByTestId('host-input')).toBeVisible({ timeout: 10000 });
    await page.getByTestId('host-input').fill('localhost');
    await page.getByTestId('port-input').fill('9010');
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

test('no error message shown after intentional disconnect via double Escape', async () => {
    // Ensure connected state
    if (!(await page.getByTestId('disconnect-button').isVisible())) {
        await page.getByTestId('host-input').fill('localhost');
        await page.getByTestId('port-input').fill('9010');
        await page.getByTestId('password-input').fill('testpassword123');
        await page.getByTestId('connect-button').click();
        await expect(page.getByTestId('chat-view')).toBeVisible({ timeout: 45000 });
    }

    // Disconnect via double Escape
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');

    // ConnectionForm should appear
    await expect(page.getByTestId('host-input')).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId('chat-view')).not.toBeVisible();

    // No error message should be visible — user initiated disconnect is not an error
    await expect(page.getByTestId('error-message')).not.toBeVisible();
});

test('no error message shown after intentional disconnect via TopBar button', async () => {
    // Reconnect first (previous test disconnected)
    await reconnect(page);
    await expect(page.getByTestId('chat-view')).toBeVisible();

    // Disconnect via TopBar button
    const disconnectBtn = page.getByTestId('disconnect-button');
    await expect(disconnectBtn).toBeVisible();
    await disconnectBtn.click();

    // ConnectionForm should appear
    await expect(page.getByTestId('host-input')).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId('chat-view')).not.toBeVisible();

    // No error message should be visible — user initiated disconnect is not an error
    await expect(page.getByTestId('error-message')).not.toBeVisible();
});
