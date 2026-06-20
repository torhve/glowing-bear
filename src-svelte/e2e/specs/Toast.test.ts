import { test, expect } from '@playwright/test';
import { createConnectedPage } from '../fixtures/auth';

let page: import('@playwright/test').Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
    page = await createConnectedPage(browser);
    page.on('pageerror', (error) => {
        if (error.message?.includes('effect_orphan')) return;
    });
});

test.afterAll(async () => {
    await page.close();
});

test.beforeEach(async () => {
    page.on('pageerror', (error) => {
        if (error.message?.includes('effect_orphan')) return;
    });
    // Clear any leftover toasts before each test
    await page.evaluate(() => (window as any).__toastStore?.set([]));
});

test('renders info toast with message', async () => {
    await page.evaluate(() => (window as any).__addToast?.('Hello world', { type: 'info' }));
    const toast = page.getByTestId('toast');
    await expect(toast).toBeVisible({ timeout: 5000 });
    await expect(toast).toContainText('Hello world');
});

test('info toast shows no icon', async () => {
    await page.evaluate(() => (window as any).__addToast?.('Info only', { type: 'info' }));
    const toast = page.getByTestId('toast');
    await expect(toast).toBeVisible({ timeout: 5000 });
    // info type has no icon — the toast-icon class should not exist
    await expect(toast.locator('.toast-icon')).toHaveCount(0);
});

test('success toast shows check-circle icon', async () => {
    await page.evaluate(() => (window as any).__addToast?.('Success!', { type: 'success' }));
    const toast = page.getByTestId('toast');
    await expect(toast).toBeVisible({ timeout: 5000 });
    await expect(toast.locator('.toast-icon')).toBeVisible();
});

test('error toast shows alert-circle icon', async () => {
    await page.evaluate(() => (window as any).__addToast?.('Error!', { type: 'error' }));
    const toast = page.getByTestId('toast');
    await expect(toast).toBeVisible({ timeout: 5000 });
    await expect(toast.locator('.toast-icon')).toBeVisible();
});

test('warning toast shows alert-triangle icon', async () => {
    await page.evaluate(() => (window as any).__addToast?.('Warning!', { type: 'warning' }));
    const toast = page.getByTestId('toast');
    await expect(toast).toBeVisible({ timeout: 5000 });
    await expect(toast.locator('.toast-icon')).toBeVisible();
});

test('toast dismisses on close button click', async () => {
    await page.evaluate(() => (window as any).__addToast?.('Dismiss me', { type: 'info', duration: 0 }));
    const toast = page.getByTestId('toast');
    await expect(toast).toBeVisible({ timeout: 5000 });
    await page.getByTestId('toast-close').click();
    await expect(toast).not.toBeVisible({ timeout: 5000 });
});

test('toast auto-dismisses after duration', async () => {
    await page.evaluate(() => (window as any).__addToast?.('Auto dismiss', { type: 'info', duration: 500 }));
    const toast = page.getByTestId('toast');
    await expect(toast).toBeVisible({ timeout: 5000 });
    await expect(toast).not.toBeVisible({ timeout: 3000 });
});

test('multiple toasts stack', async () => {
    await page.evaluate(() => {
        (window as any).__addToast?.('First toast', { type: 'info', duration: 5000 });
        (window as any).__addToast?.('Second toast', { type: 'success', duration: 5000 });
    });
    const toasts = page.getByTestId('toast');
    await expect(toasts).toHaveCount(2, { timeout: 5000 });
    await expect(toasts.first()).toContainText('First toast');
    await expect(toasts.last()).toContainText('Second toast');
});

test('toast renders action button with correct testid', async () => {
    await page.evaluate(() => {
        const undo = () => {};
        (window as any).__addToast?.('Action test', { type: 'info', duration: 5000, buttons: [{ text: 'Undo', action: undo }] });
    });
    const toast = page.getByTestId('toast');
    await expect(toast).toBeVisible({ timeout: 5000 });
    const actionBtn = page.getByTestId('toast-undo-button');
    await expect(actionBtn).toBeVisible();
    await expect(actionBtn).toHaveText('Undo');
});

test('toast action button is clickable', async () => {
    let clicked = false;
    await page.evaluate(() => {
        (window as any).__addToast?.('Clickable', { type: 'info', duration: 5000, buttons: [{ text: 'Retry', action: () => { (window as any).__retryClicked = true; } }] });
    });
    const actionBtn = page.getByTestId('toast-retry-button');
    await expect(actionBtn).toBeVisible({ timeout: 5000 });
    await actionBtn.click();
    const retryClicked = await page.evaluate(() => (window as any).__retryClicked);
    expect(retryClicked).toBe(true);
});

test('toast with multiple action buttons', async () => {
    await page.evaluate(() => {
        (window as any).__addToast?.('Multiple buttons', { type: 'info', duration: 5000, buttons: [{ text: 'Yes', action: () => {} }, { text: 'No', action: () => {} }] });
    });
    await expect(page.getByTestId('toast-yes-button')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('toast-no-button')).toBeVisible();
    await expect(page.getByTestId('toast-yes-button')).toHaveText('Yes');
    await expect(page.getByTestId('toast-no-button')).toHaveText('No');
});
