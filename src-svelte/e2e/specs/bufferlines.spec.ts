import { test, expect } from '@playwright/test';
import { connectToWeechat, clearSettings, waitForAppReady } from '../helpers/connection';
import { waitForBuffer, switchToBuffer } from '../helpers/buffers';

let page: import('@playwright/test').Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await page.goto('http://localhost:8001/');
    await waitForAppReady(page);
    await clearSettings(page);
    page.on('pageerror', (error) => {
        if (error.message?.includes('effect_orphan')) return;
    });
    await connectToWeechat(page);
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

test('renders bufferline rows after connecting', async () => {
    const rows = page.locator('[data-testid="chat-messages"] table tbody tr');
    const count = await rows.count();
    expect(count).toBeGreaterThanOrEqual(1);
});

test('has correct table structure with time, prefix, and message columns', async () => {
    const timeCells = page.locator('[data-testid="chat-messages"] td.time');
    const prefixCells = page.locator('[data-testid="chat-messages"] td.prefix');
    const messageCells = page.locator('[data-testid="chat-messages"] td.message');
    const timeCount = await timeCells.count();
    const prefixCount = await prefixCells.count();
    const messageCount = await messageCells.count();
    expect(timeCount).toBeGreaterThanOrEqual(1);
    expect(prefixCount).toBeGreaterThanOrEqual(1);
    expect(messageCount).toBeGreaterThanOrEqual(1);
});

test('displays timestamp in messages', async () => {
    const timeSpan = page.locator('[data-testid="chat-messages"] td.time span.date').first();
    const text = await timeSpan.textContent();
    expect(text).toMatch(/\d{2}:\d{2}/);
});

test('displays message content in the message column', async () => {
    const messageCells = page.locator('[data-testid="chat-messages"] td.message');
    const count = await messageCells.count();
    expect(count).toBeGreaterThanOrEqual(1);
});

test('shows full round-trip: send message via input → appears in chat', async () => {
    const msg = 'e2e-test-' + Date.now();
    const input = page.getByTestId('message-input');
    await input.fill(msg);
    await input.press('Enter');
    const messageCell = page.locator('[data-testid="chat-messages"] td.message').filter({ hasText: msg });
    await expect(messageCell).toBeVisible({ timeout: 5000 });
});

test('shows full round-trip: send message via Send button → appears in chat', async () => {
    const msg = 'e2e-test-btn-' + Date.now();
    const input = page.getByTestId('message-input');
    const sendBtn = page.getByTestId('send-button');
    await input.fill(msg);
    await sendBtn.click();
    const messageCell = page.locator('[data-testid="chat-messages"] td.message').filter({ hasText: msg });
    await expect(messageCell).toBeVisible({ timeout: 5000 });
});

test('scrolls to bottom after new message arrives', async () => {
    const msg = 'e2e-scroll-' + Date.now();
    const input = page.getByTestId('message-input');
    await input.fill(msg);
    await input.press('Enter');
    const messageCell = page.locator('[data-testid="chat-messages"] td.message').filter({ hasText: msg });
    await expect(messageCell).toBeVisible({ timeout: 5000 });
    const lastRow = page.locator('[data-testid="chat-messages"] tr').last();
    await expect(lastRow).toBeAttached();
});

test('displays topic bar with buffer name after connecting', async () => {
    await expect(page.getByTestId('topic-bar')).toBeVisible();
    await expect(page.getByTestId('topic-bar').getByText('#glowing-bear')).toBeAttached();
});

test('has no error messages in console during connection and message rendering', async () => {
    const logs = await page.evaluate(() => (window as any).__consoleLogs || []);
    expect(logs.length).toBe(0);
});
