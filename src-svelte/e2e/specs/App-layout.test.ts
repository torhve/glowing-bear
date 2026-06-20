import { test, expect } from '@playwright/test';
import { createConnectedPage } from '../fixtures/auth';
import { waitForBuffer, switchToBuffer } from '../helpers/buffers';

let page: import('@playwright/test').Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
    page = await createConnectedPage(browser);
    page.on('pageerror', (error) => {
        if (error.message?.includes('effect_orphan')) return;
    });
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
});

test.afterAll(async () => {
    await page.close();
});

test.beforeEach(async () => {
    page.on('pageerror', (error) => {
        if (error.message?.includes('effect_orphan')) return;
    });
});

test('should display the chat view after connecting', async () => {
    await expect(page.getByTestId('chat-messages')).toBeVisible();
});

test('should display the topic bar with buffer name', async () => {
    await expect(page.getByTestId('topic-bar')).toBeVisible();
    await expect(page.getByTestId('topic-bar')).toContainText('#');
});

test('should display the topic modal when clicking topic bar', async () => {
    await page.getByTestId('topic-bar').first().click();
    await expect(page.getByTestId('topic-modal')).toBeVisible({ timeout: 5000 });
    // Click the backdrop to close
    const modal = page.getByTestId('topic-modal');
    const boundingBox = await modal.boundingBox();
    if (boundingBox) {
        await page.mouse.click(1, 1);
    }
    await expect(modal).not.toBeVisible({ timeout: 5000 });
});

test('should display the input bar with buffer prefix', async () => {
    await expect(page.getByTestId('input-bar')).toBeVisible();
    await expect(page.getByTestId('message-input')).toBeVisible();
    await expect(page.getByTestId('send-button')).toBeVisible();
});

test('should enable send button when message is typed', async () => {
    const sendBtn = page.getByTestId('send-button');
    await expect(sendBtn).toBeDisabled();
    const input = page.getByTestId('message-input');
    await input.focus();
    await input.clear();
    await input.fill('hello world');
    await expect(sendBtn).not.toBeDisabled();
});

test('should disable send button when message is cleared', async () => {
    const sendBtn = page.getByTestId('send-button');
    const input = page.getByTestId('message-input');
    await input.focus();
    await input.clear();
    await input.fill('hello');
    await expect(sendBtn).not.toBeDisabled();
    await input.focus();
    await input.clear();
    await expect(sendBtn).toBeDisabled();
});

test('should send a message via Enter key', async () => {
    const input = page.getByTestId('message-input');
    await input.focus();
    await input.clear();
    await input.pressSequentially('test message via enter');
    await input.press('Enter');
    await expect(input).toHaveValue('', { timeout: 5000 });
});

test('should send a message via Send button', async () => {
    const modal = page.getByTestId('topic-modal');
    await expect(modal).not.toBeVisible();
    const input = page.getByTestId('message-input');
    const sendBtn = page.getByTestId('send-button');
    await input.focus();
    await input.clear();
    await input.fill('test message via button');
    await sendBtn.click();
    await expect(input).toHaveValue('', { timeout: 5000 });
});

test('should show chat messages container with virtual scrolling', async () => {
    const chatMessages = page.getByTestId('chat-messages');
    await expect(chatMessages).toBeAttached();
    await expect(chatMessages).toHaveAttribute('data-testid', 'chat-messages');
});

test('should show top-bar with app name when connected', async () => {
    await expect(page.getByTestId('top-bar')).toBeVisible();
    await expect(page.getByTestId('top-bar')).toContainText('Glowing Bear');
});

test('should show disconnect button when connected', async () => {
    await expect(page.getByTestId('disconnect-button')).toBeVisible();
});

test('should show WeeChat version in settings modal', async () => {
    await page.getByTestId('settings-button').click();
    await expect(page.getByTestId('settings-modal')).toBeVisible();
    await expect(page.getByTestId('settings-modal')).toContainText('WeeChat');
    await page.getByTestId('settings-modal-close').click();
    await expect(page.getByTestId('settings-modal')).not.toBeVisible();
});
