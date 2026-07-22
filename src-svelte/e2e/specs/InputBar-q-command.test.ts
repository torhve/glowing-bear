import { test, expect } from '@playwright/test';
import { createConnectedPage } from '../fixtures/auth';
import { switchToBuffer, waitForBuffer } from '../helpers/buffers';
import { sendWeechatCommand } from '../helpers/connection';

let page: import('@playwright/test').Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
    page = await createConnectedPage(browser);
});

test.afterAll(async () => {
    await page.close();
});

test.beforeEach(async () => {
    // Switch to a known channel buffer to establish clean state
    await switchToBuffer(page, '#glowing-bear');
});

/**
 * Type a command in the input bar and press Enter to send it.
 */
async function typeCommand(cmd: string) {
    const input = page.getByTestId('message-input');
    await input.focus();
    await page.waitForTimeout(50);
    await input.fill(cmd);
    await input.press('Enter');
    await expect(input).toHaveValue('', { timeout: 5000 });
}

test('/q nick switches to query buffer', async () => {
    // Type /q gbbot and send — gbbot is the bot nick on gbtest
    await typeCommand('/q gbbot');

    // Wait for WeeChat to process /query and create the buffer
    // The buffer should appear in the buffer list and become active
    await waitForBuffer(page, 'gbbot', 15000);

    // Verify the topic bar shows the query buffer name
    await expect(
        page.getByTestId('topic-bar').locator('.topic-channel-name')
    ).toContainText('gbbot', { timeout: 15000 });
});

test('/query nick switches to query buffer (full command)', async () => {
    // Type /query gbbot and send — same behavior as /q
    await typeCommand('/query gbbot');

    await waitForBuffer(page, 'gbbot', 15000);

    await expect(
        page.getByTestId('topic-bar').locator('.topic-channel-name')
    ).toContainText('gbbot', { timeout: 15000 });
});

test('/q nick creates and switches to new buffer after close', async () => {
    // First create the gbbot buffer by typing /q gbbot
    await typeCommand('/q gbbot');
    await waitForBuffer(page, 'gbbot', 15000);
    await expect(
        page.getByTestId('topic-bar').locator('.topic-channel-name')
    ).toContainText('gbbot', { timeout: 15000 });

    // Switch back to channel
    await switchToBuffer(page, '#glowing-bear');

    // Close the gbbot buffer via WeeChat command
    await sendWeechatCommand(page, '/buffer close *gbbot*');
    await page.waitForTimeout(1000);

    // Verify gbbot buffer is gone from buffer list
    const gbbotInList = page.getByTestId('buffer-item').filter({ hasText: 'gbbot' });
    await expect(gbbotInList).not.toBeVisible({ timeout: 5000 }).catch(() => {});

    // Type /q gbbot again — should create new buffer and switch to it
    await typeCommand('/q gbbot');

    // Wait for WeeChat to create the buffer and client to switch
    await waitForBuffer(page, 'gbbot', 15000);

    // Verify switched to gbbot buffer
    await expect(
        page.getByTestId('topic-bar').locator('.topic-channel-name')
    ).toContainText('gbbot', { timeout: 15000 });
});
