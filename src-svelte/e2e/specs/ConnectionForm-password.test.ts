import { test, expect } from '@playwright/test';
import { fillPortInput, waitForAppReady, clearSettings } from '../helpers/connection';
import { fillInput } from '../helpers/input';
import { setupEffectOrphanFilter } from '../helpers/pageerror';

// Tests that verify typed password isn't overwritten by other field edits.
// These start from a clean state (no saved settings).
test.describe('Connection Form password handling', () => {
  test.beforeEach(async ({ page }) => {
  	setupEffectOrphanFilter(page);
  	await page.goto('http://localhost:8001/');
  	await clearSettings(page);
  	await waitForAppReady(page);
  	await expect(page.getByTestId('host-input')).toBeVisible({ timeout: 10000 });
  });

  test('typed password is not overwritten when editing host field', async ({ page }) => {
  	await fillInput(page, 'host-input', 'localhost');
  	await fillInput(page, 'port-input', '9001');
  	await fillInput(page, 'password-input', 'my_secret_password');

  	const passwordBefore = await page.getByTestId('password-input').inputValue();
  	expect(passwordBefore).toBe('my_secret_password');

  	// Edit host field — triggers handleHostChange() → updateSettings()
  	// In old code this would re-run the $effect and overwrite typed password
  	await fillInput(page, 'host-input', 'example.com');

  	await page.getByTestId('password-input').focus();
  	const passwordAfter = await page.getByTestId('password-input').inputValue();
  	expect(passwordAfter).toBe('my_secret_password');
  });

  test('typed password is not overwritten when toggling TLS', async ({ page }) => {
  	await fillInput(page, 'host-input', 'localhost');
  	await fillInput(page, 'port-input', '9001');
  	await fillInput(page, 'password-input', 'another_secret');

  	const passwordBefore = await page.getByTestId('password-input').inputValue();
  	expect(passwordBefore).toBe('another_secret');

  	// Toggle TLS checkbox — triggers toggleTLS() → updateSettings({ tls })
  	await page.getByTestId('tls-checkbox').click();

  	const passwordAfter = await page.getByTestId('password-input').inputValue();
  	expect(passwordAfter).toBe('another_secret');
  });

  test('connecting with typed password succeeds when different from saved password', async ({ page }) => {
  	// Set up localStorage with a wrong saved password BEFORE reload
  	await page.evaluate(() => {
  		localStorage.setItem('gb-settings', JSON.stringify({
  			hostField: 'localhost',
  			port: '9001',
  			tls: false,
  			password: 'wrong_password',
  			savepassword: true,
  			autoconnect: false,
  		}));
  	});
  	await page.reload();
  	await waitForAppReady(page);

  	// Form should have loaded the saved (wrong) values
  	await expect(page.getByTestId('host-input')).toHaveValue('localhost');
  	await expect(page.getByTestId('password-input')).toHaveValue('wrong_password');

  	// Type the correct password (overwriting the wrong one)
  	await fillInput(page, 'password-input', 'testpassword123');
  	expect(await page.getByTestId('password-input').inputValue()).toBe('testpassword123');

  	// Edit another field to trigger any potential re-sync bug
  	await fillInput(page, 'host-input', 'localhost');
  	expect(await page.getByTestId('password-input').inputValue()).toBe('testpassword123');

  	// Click connect — should succeed with typed password
  	await page.getByTestId('connect-button').click();
  	await expect(page.getByTestId('chat-view')).toBeVisible({ timeout: 45000 });
  });


});

// Tests that require pre-loaded localStorage data.
// No beforeEach — each test controls its own page navigation.
test.describe('Connection Form password with saved settings', () => {
  test.beforeEach(async ({ page }) => {
  	setupEffectOrphanFilter(page);
  	// Clear settings on first load before we set up our test data
  	await page.goto('http://localhost:8001/');
  	await clearSettings(page);
  });

  test('unchecking save password clears stored password on reload', async ({ page }) => {
  	// Set up: have a saved password with savepassword enabled, THEN reload
  	await page.evaluate(() => {
  		localStorage.setItem('gb-settings', JSON.stringify({
  			hostField: 'localhost',
  			port: '9001',
  			tls: false,
  			password: 'saved_secret',
  			savepassword: true,
  			autoconnect: false,
  		}));
  	});
  	await page.reload();
  	await waitForAppReady(page);

  	// Password field should show the saved value
  	await expect(page.getByTestId('password-input')).toHaveValue('saved_secret', { timeout: 5000 });
  	await expect(page.getByTestId('savepassword-checkbox')).toBeChecked();

  	// Uncheck "Save password" — click triggers toggleSavePassword via onclick
  	await page.getByTestId('savepassword-checkbox').click();
  	await expect(page.getByTestId('savepassword-checkbox')).not.toBeChecked({ timeout: 3000 });
  	// Wait for any async updates to flush
  	await page.waitForTimeout(100);

  	// Reload the page to verify the password was cleared from localStorage
  	await page.reload();
  	await waitForAppReady(page);

  	// Password field should now be empty (was cleared when unchecking)
  	await expect(page.getByTestId('password-input')).toHaveValue('', { timeout: 5000 });
  });
});
