import { test, expect } from '@playwright/test';
import { connectToWeechat, disconnect, fillPortInput, waitForAppReady, setSettings } from '../helpers/connection';
import { fillInput } from '../helpers/input';

import { setupEffectOrphanFilter } from '../helpers/pageerror';

const RELAY_URL = 'ws://localhost:9010/weechat';
const PASSWORD = 'testpassword123';

test.describe('Connection Form', () => {
    test.beforeEach(async ({ page }) => {
        setupEffectOrphanFilter(page)
        // Always start with clean state: clear settings and force reload
        await page.goto('http://localhost:8001/');
        await page.evaluate(() => localStorage.removeItem('gb-settings'));
        await page.reload();
        await waitForAppReady(page);
        // Verify we're disconnected (connection form should be visible)
        await expect(page.getByTestId('host-input')).toBeVisible({ timeout: 10000 });
    });

    test('should display the connection form', async ({ page }) => {
        await expect(page.getByTestId('host-input')).toBeVisible();
        await expect(page.getByTestId('port-input')).toBeVisible();
        await expect(page.getByTestId('password-input')).toBeVisible();
        await expect(page.getByTestId('connect-button')).toBeVisible();
    });

    test('should connect to WeeChat relay', async ({ page }) => {
        await connectToWeechat(page);
    });

    test('should show connecting state while connecting', async ({ page }) => {
        await fillInput(page, 'host-input', 'localhost');
        await fillInput(page, 'port-input', '9010');
        await fillInput(page, 'password-input', 'testpassword123');
        await page.getByTestId('connect-button').click();
        // Connection is fast in test environment — button becomes disabled immediately
        await expect(page.getByTestId('connect-button')).toBeDisabled({ timeout: 5000 });
        await expect(page.getByTestId('chat-view')).toBeVisible({ timeout: 45000 });
    });

    test('should show error message on connection failure', async ({ page }) => {
        await fillInput(page, 'host-input', 'localhost');
        await fillInput(page, 'port-input', '9999');
        await fillInput(page, 'password-input', 'wrongpassword');
        await page.getByTestId('connect-button').click();
        await expect(page.getByTestId('error-message').first()).toBeVisible({ timeout: 15000 });
    });

    test('should show error on wrong password', async ({ page }) => {
        // Use invalid port to force connection failure (test server doesn't validate passwords)
        await fillInput(page, 'host-input', 'localhost');
        await fillInput(page, 'port-input', '19999');
        await fillInput(page, 'password-input', 'wrongpassword');
        await page.getByTestId('connect-button').click();
        
        // Wait for error message to appear
        await expect(page.getByTestId('error-message').first()).toBeVisible({ timeout: 15000 });
    });

    test('should reconnect after disconnect', async ({ page }) => {
        page.on('pageerror', (error) => {
            if (error.message?.includes('Request timeout')) return;
        });
        await connectToWeechat(page);
        await expect(page.getByTestId('chat-view')).toBeVisible();
        await disconnect(page);
        // Ensure connection form is fully visible before reconnecting
        await expect(page.getByTestId('host-input')).toBeVisible({ timeout: 15000 });
        await connectToWeechat(page);
        await expect(page.getByTestId('chat-view')).toBeVisible({ timeout: 45000 });
    });

    test('should save connection settings to localStorage', async ({ page }) => {
        await page.evaluate(() => {
            localStorage.setItem('gb-settings', JSON.stringify({
                hostField: 'localhost',
                port: '9010',
                tls: false,
            }));
        });
        await page.reload();
        await expect(page.getByTestId('host-input')).toHaveValue('localhost', { timeout: 10000 });
        await expect(page.getByTestId('port-input')).toHaveValue('9010', { timeout: 5000 });
    });

    test('should not connect with empty host', async ({ page }) => {
        await page.getByTestId('host-input').clear();
        await page.getByTestId('host-input').blur();
        await page.getByTestId('connect-button').click();
        await expect(page.getByTestId('host-input')).toHaveClass(/border-danger/, { timeout: 5000 });
    });

    test('should disable connect button while connecting', async ({ page }) => {
        await fillInput(page, 'host-input', 'localhost');
        await fillInput(page, 'port-input', '9010');
        await fillInput(page, 'password-input', 'testpassword123');
        await page.getByTestId('connect-button').click();
        await expect(page.getByTestId('chat-view')).toBeVisible({ timeout: 45000 });
    });

    test('should toggle TLS checkbox', async ({ page }) => {
        const tlsCheck = page.getByTestId('tls-checkbox');
        await expect(tlsCheck).not.toBeChecked();
        await tlsCheck.click();
        await expect(tlsCheck).toBeChecked();
    });

    test('should toggle save password option', async ({ page }) => {
        const savePasswordCheck = page.getByTestId('savepassword-checkbox');
        await expect(savePasswordCheck).not.toBeChecked();
        await savePasswordCheck.click();
        await expect(savePasswordCheck).toBeChecked();
    });

    test('should show autoconnect option when save password is enabled', async ({ page }) => {
        await page.evaluate(() => {
            localStorage.setItem('gb-settings', JSON.stringify({ savepassword: true }));
        });
        await page.reload();
        await expect(page.getByTestId('host-input')).toBeVisible({ timeout: 5000 });
        await expect(page.getByTestId('autoconnect-checkbox')).toBeAttached({ timeout: 5000 });
    });

    test('should connect when pressing Enter with focus off the form', async ({ page }) => {
        await fillInput(page, 'host-input', 'localhost');
        await fillInput(page, 'port-input', '9010');
        await fillInput(page, 'password-input', 'testpassword123');
        // Move focus off the form by clicking an accordion summary outside the form
        await page.locator('summary').nth(1).click();
        await page.keyboard.press('Enter');
        await expect(page.getByTestId('connect-button')).toBeDisabled({ timeout: 5000 });
        await expect(page.getByTestId('chat-view')).toBeVisible({ timeout: 45000 });
    });

    test('should connect when pressing Enter while password field is focused', async ({ page }) => {
        await fillInput(page, 'host-input', 'localhost');
        await fillInput(page, 'port-input', '9010');
        await fillInput(page, 'password-input', 'testpassword123');
        // Focus the password input, then press Enter
        await page.getByTestId('password-input').focus();
        await page.keyboard.press('Enter');
        await expect(page.getByTestId('connect-button')).toBeDisabled({ timeout: 5000 });
        await expect(page.getByTestId('chat-view')).toBeVisible({ timeout: 45000 });
    });
});

test.describe.configure({ mode: 'serial' });

test.describe('Disconnect handling', () => {
    test.beforeEach(async ({ page }) => {
        setupEffectOrphanFilter(page)
        await page.goto('http://localhost:8001/');
        await page.evaluate(() => localStorage.removeItem('gb-settings'));
        await page.reload();
        await waitForAppReady(page);
    });

    // Both of these used to be the toast's job. With a retained view on screen the
    // banner presents the loss and carries the way back, and the toast is
    // suppressed rather than stacked on top of it — see ConnectionBanner.test.ts.
    test('shows the connection banner when autoconnect is off after being connected', async ({ page }) => {
        await connectToWeechat(page);
        await expect(page.getByTestId('chat-view')).toBeVisible({ timeout: 45000 });

        // Disable autoconnect in settings
        await setSettings(page, { autoconnect: false });

        // Simulate WebSocket close (browser only allows 1000 or 3000-4999)
        await page.evaluate(() => {
            const socket = (window as any).__getSession?.()?.getSocket?.();
            if (socket) socket.close(3000, 'test disconnect');
        });

        await expect(page.getByTestId('connection-banner')).toBeVisible({ timeout: 5000 });
        await expect(page.getByTestId('connection-banner')).toContainText(/lost|reached/i);
        await expect(page.getByTestId('toast')).not.toBeVisible();
    });

    test('should reconnect when clicking the banner reconnect action', async ({ page }) => {
        await connectToWeechat(page);
        await expect(page.getByTestId('chat-view')).toBeVisible({ timeout: 45000 });

        // Disable autoconnect so no loop is running: the banner's action starts one
        await setSettings(page, { autoconnect: false });

        // Simulate WebSocket close
        await page.evaluate(() => {
            const socket = (window as any).__getSession?.()?.getSocket?.();
            if (socket) socket.close(3000, 'test disconnect');
        });

        await expect(page.getByTestId('connection-banner-retry')).toBeVisible({ timeout: 5000 });
        await page.getByTestId('connection-banner-retry').click();

        // Should be connected again, with the banner gone
        await expect(page.getByTestId('chat-view')).toBeVisible({ timeout: 45000 });
        await expect(page.getByTestId('connection-banner')).not.toBeVisible({ timeout: 10000 });
    });

    // Rewritten together with the retained shell. This spec used to pin the
    // behaviour the reconnect-in-place work removes — an unexpected disconnect
    // replacing chat with the connection form — so the same scenario now asserts
    // the opposite. Leaving on purpose still shows the form, and that is covered
    // by the Leave specs in ConnectionBanner.test.ts.
    test('keeps the chat shell after an unexpected disconnect', async ({ page }) => {
        await connectToWeechat(page);
        await expect(page.getByTestId('chat-view')).toBeVisible({ timeout: 45000 });

        // Verify connected state — chat view visible, host input hidden
        await expect(page.getByTestId('host-input')).not.toBeVisible();

        // Disable autoconnect and simulate WebSocket close
        await setSettings(page, { autoconnect: false });
        await page.evaluate(() => {
            const socket = (window as any).__getSession?.()?.getSocket?.();
            if (socket) socket.close(3000, 'test disconnect');
        });

        // The shell survives and the banner takes over the status presentation.
        await expect(page.getByTestId('connection-banner')).toBeVisible({ timeout: 10000 });
        await expect(page.getByTestId('chat-view')).toBeVisible();
        await expect(page.getByTestId('host-input')).not.toBeVisible();
    });
});
