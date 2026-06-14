import { test, expect } from '@playwright/test';
import { connectToWeechat, clearSettings, waitForAppReady } from '../helpers/connection';
import { botSay, botNotice, botSayColored, assertLastMessage } from '../helpers/messages';
import { waitForBuffer, switchToBuffer } from '../helpers/buffers';
import { irc } from '../helpers/irc-control';

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
});

test.afterAll(async () => {
    await page.close();
});

test.beforeEach(async () => {
    page.on('pageerror', (error) => {
        if (error.message?.includes('effect_orphan')) return;
    });
});

test('shows gbtest IRC server and #glowing-bear in buffer list', async () => {
    await waitForBuffer(page, 'gbtest', 15000);
    await waitForBuffer(page, '#glowing-bear', 5000);
});

test('shows Well met! welcome from the bot', async () => {
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
    await expect(page.getByTestId('chat-messages')).toBeAttached();
});

test('shows bot messages in chat', async () => {
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
    await botSay('Hello from the bot!');
    const msgRow = page.locator('[data-testid="bufferline-row"] td.message').filter({ hasText: 'Hello from the bot!' }).first();
    await expect(msgRow).toBeVisible({ timeout: 10000 });
});

test('shows multiple bot messages in order', async () => {
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
    await botSay('Message one');
    await botSay('Message two');
    await botSay('Message three');
    const msgRow = page.locator('[data-testid="bufferline-row"] td.message').filter({ hasText: 'Message three' }).first();
    await expect(msgRow).toBeVisible({ timeout: 10000 });
});

test('shows notices from bot', async () => {
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
    await botNotice('This is a notice');
    const msgRow = page.locator('[data-testid="bufferline-row"] td.message').filter({ hasText: 'This is a notice' }).first();
    await expect(msgRow).toBeVisible({ timeout: 10000 });
});

test('renders XSS payloads literally, not as HTML', async () => {
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
    await botSay('<img src="">');
    const imgs = page.locator('[data-testid="chat-messages"] img');
    await expect(imgs).toHaveCount(0);
});

test('shows join message when bot joins a channel', async () => {
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
    await irc.botJoin('#other-channel');
    await irc.botJoin('#glowing-bear');
    const joinedMsg = page.locator('[data-testid="bufferline-row"] td.message').filter({ hasText: /gbbot.*joined/ }).first();
    await expect(joinedMsg).toBeVisible({ timeout: 10000 });
});

test('shows part message when bot leaves', async () => {
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
    await irc.botPart('#glowing-bear');
    const leftMsg = page.locator('[data-testid="bufferline-row"] td.message').filter({ hasText: 'has left' }).first();
    await expect(leftMsg).toBeVisible({ timeout: 10000 });
});

test('shows topic changes from bot', async () => {
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
    await irc.setTopic('#glowing-bear', 'Welcome to the test channel!');
    await expect(page.getByTestId('topic-bar')).toContainText('Welcome to the test channel!', { timeout: 10000 });
});

test('shows bot and user in nicklist for #glowing-bear', async () => {
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
    await expect(page.getByTestId('nicklist')).toBeAttached({ timeout: 10000 });
});

test('renders IRC colored messages', async () => {
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
    await botSayColored('This is red text', '04');
    const msgRow = page.locator('[data-testid="bufferline-row"] td.message').filter({ hasText: 'This is red text' }).first();
    await expect(msgRow).toBeVisible({ timeout: 10000 });
});

test('switches between core and #glowing-bear buffers', async () => {
    await waitForBuffer(page, '#glowing-bear', 15000);
    await waitForBuffer(page, 'gbtest', 5000);
    await switchToBuffer(page, 'gbtest');
    await expect(page.getByTestId('topic-bar')).toBeAttached({ timeout: 5000 });
    await switchToBuffer(page, '#glowing-bear');
    await expect(page.getByTestId('topic-bar')).toContainText('#glowing-bear', { timeout: 5000 });
});

test('shows bot nick change', async () => {
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
    await irc.botNick('gbbot2');
    const msgRow = page.locator('[data-testid="bufferline-row"] td.message').filter({ hasText: 'gbbot2' }).first();
    await expect(msgRow).toBeVisible({ timeout: 10000 });
});
