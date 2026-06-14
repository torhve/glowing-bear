import { test, expect } from '@playwright/test';
import { connectToWeechat, clearSettings, waitForAppReady } from '../helpers/connection';
import { botSay, sendMessage } from '../helpers/messages';
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

test('renders URLs in bufferline messages as links', async () => {
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
    await botSay('Check out https://example.com for more info');
    const link = page.locator('[data-testid="bufferline-row"] td.message a.irc-link').filter({ hasText: 'https://example.com' }).first();
    await expect(link).toBeAttached({ timeout: 10000 });
});

test('excludes trailing punctuation from URL links', async () => {
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
    await botSay('Visit https://example.com/page.');
    const lastLink = page.locator('[data-testid="bufferline-row"] td.message a.irc-link').last();
    await expect(lastLink).toHaveAttribute('href', 'https://example.com/page', { timeout: 10000 });
});

test('does NOT linkify email addresses', async () => {
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
    await botSay('Contact us at test@example.com');
    const msgCell = page.locator('[data-testid="bufferline-row"] td.message').filter({ hasText: 'test@example.com' });
    await expect(msgCell).toBeAttached({ timeout: 10000 });
    const anchor = msgCell.locator('a');
    await expect(anchor).toHaveCount(0);
});

test('handles multiple URLs in one message', async () => {
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
    await botSay('See https://example.com and https://github.com');
    const lastRow = page.locator('[data-testid="bufferline-row"]').last();
    const links = lastRow.locator('td.message a.irc-link');
    await expect(links).toHaveCount(2, { timeout: 10000 });
});

test('renders FTP URLs as links', async () => {
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
    await botSay('Download from ftp://files.example.com/file.zip');
    const lastLink = page.locator('[data-testid="bufferline-row"] td.message a.irc-link').last();
    await expect(lastLink).toHaveAttribute('href', 'ftp://files.example.com/file.zip', { timeout: 10000 });
});

test('renders user-sent URLs as links', async () => {
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
    await sendMessage(page, 'Check out https://svelte.dev');
    const lastLink = page.locator('[data-testid="bufferline-row"] td.message a.irc-link').last();
    const href = await lastLink.getAttribute('href');
    expect(href).toContain('https://svelte.dev');
});

test('shows links in topic bar', async () => {
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
    await irc.setTopic('#glowing-bear', 'Welcome! Visit https://glowing-bear.org');
    const topicLinks = page.locator('[data-testid="topic-bar"] a');
    await expect(topicLinks.first()).toHaveAttribute('href', 'https://glowing-bear.org', { timeout: 10000 });
});

test('has no nested anchor tags in messages', async () => {
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
    await botSay('Link: https://example.com');
    const links = page.locator('[data-testid="bufferline-row"] td.message a.irc-link');
    const count = await links.count();
    expect(count).toBeGreaterThanOrEqual(1);
    for (let i = 0; i < count; i++) {
        const link = links.nth(i);
        const nestedAnchors = link.locator('a');
        await expect(nestedAnchors).toHaveCount(0);
    }
});
