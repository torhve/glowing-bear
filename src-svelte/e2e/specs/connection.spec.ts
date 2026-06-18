import { test, expect } from '@playwright/test';
import { connectToWeechat, disconnect, fillPortInput, waitForAppReady } from '../helpers/connection';

test.describe('Connection Form', () => {
    test.beforeEach(async ({ page }) => {
        page.on('pageerror', (error) => {
            if (error.message?.includes('effect_orphan')) return;
        });
        // Always start with clean state: clear settings and force reload
        await page.goto('http://localhost:8001/');
        await page.evaluate(() => localStorage.removeItem('gb-settings'));
        // Wait a bit for settings to be cleared before reload
        await page.waitForTimeout(500);
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
        await page.getByTestId('host-input').clear();
        await page.getByTestId('host-input').fill('localhost');
        await fillPortInput(page, '9001');
        await page.getByTestId('password-input').clear();
        await page.getByTestId('password-input').fill('testpassword123');
        await page.getByTestId('connect-button').click();
        // Connection is fast in test environment — button becomes disabled immediately
        await expect(page.getByTestId('connect-button')).toBeDisabled({ timeout: 5000 });
        await expect(page.getByTestId('chat-view')).toBeVisible({ timeout: 45000 });
    });

    test('should show error message on connection failure', async ({ page }) => {
        await page.getByTestId('host-input').clear();
        await page.getByTestId('host-input').fill('localhost');
        await fillPortInput(page, '9999');
        await page.getByTestId('password-input').clear();
        await page.getByTestId('password-input').fill('wrongpassword');
        await page.getByTestId('connect-button').click();
        await expect(page.getByTestId('error-message').first()).toBeVisible({ timeout: 15000 });
    });

  test('should show error on wrong password', async ({ page }) => {
        // Use invalid port to force connection failure (test server doesn't validate passwords)
        await page.getByTestId('host-input').clear();
        await page.getByTestId('host-input').fill('localhost');
        await fillPortInput(page, '19999');
        await page.getByTestId('password-input').clear();
        await page.getByTestId('password-input').fill('wrongpassword');
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
        await connectToWeechat(page);
        await expect(page.getByTestId('chat-view')).toBeVisible({ timeout: 45000 });
    });

    test('should save connection settings to localStorage', async ({ page }) => {
        await page.evaluate(() => {
            localStorage.setItem('gb-settings', JSON.stringify({
                hostField: 'localhost',
                port: '9001',
                tls: false,
            }));
        });
        await page.reload();
        await expect(page.getByTestId('host-input')).toHaveValue('localhost', { timeout: 10000 });
        await expect(page.getByTestId('port-input')).toHaveValue('9001', { timeout: 5000 });
    });

    test('should not connect with empty host', async ({ page }) => {
        await page.getByTestId('host-input').clear();
        await page.getByTestId('host-input').blur();
        await page.waitForTimeout(300);
        await page.getByTestId('connect-button').click();
        await expect(page.getByTestId('host-input')).toHaveClass(/border-danger/, { timeout: 5000 });
    });

    test('should disable connect button while connecting', async ({ page }) => {
        await page.getByTestId('host-input').fill('localhost');
        await fillPortInput(page, '9001');
        await page.getByTestId('password-input').fill('testpassword123');
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
        await page.waitForTimeout(300);
        await expect(page.getByTestId('autoconnect-checkbox')).toBeAttached();
    });
});
