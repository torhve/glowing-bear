import { test, expect } from '@playwright/test';
import { connectToWeechat, clearSettings, waitForAppReady } from '../helpers/connection';
import { botSay } from '../helpers/messages';
import { waitForBuffer, switchToBuffer } from '../helpers/buffers';

let page: import('@playwright/test').Page;

test.describe.configure({ mode: 'serial', timeout: 60000 });

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

test('does NOT linkify javascript: URLs in messages', async () => {
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
    await botSay('Check out javascript:void(document.body.innerHTML="HACKED")');
    const lastRow = page.locator('[data-testid="bufferline-row"]').last();
    const messageLinks = lastRow.locator('.message a');
    await expect(messageLinks).toHaveCount(0, { timeout: 10000 });
    await expect(lastRow.locator('.message')).toContainText('javascript:void(document.body.innerHTML="HACKED")');
});

test('does NOT render <img> tags as images in messages', async () => {
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
    await botSay('Look at this <img src=x onerror=alert(1)> tag');
    const msgCell = page.locator('[data-testid="bufferline-row"] .message').last();
    await expect(msgCell).toContainText('<img src=x onerror=alert(1)>', { timeout: 10000 });
    await expect(page.locator('[data-testid="bufferline-row"] .message img')).toHaveCount(0);
});

test('does NOT execute onerror handlers in messages', async () => {
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
    await botSay('<div onerror="alert(\'xss\')">test</div>');
    const msgCell = page.locator('[data-testid="bufferline-row"] .message').last();
    await expect(msgCell).toContainText('<div onerror="alert(\'xss\')">test</div>', { timeout: 10000 });
});

test('does NOT linkify data: URLs in messages', async () => {
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
    await botSay('Check out data:text/html,<script>alert(1)</script>');
    const lastRow = page.locator('[data-testid="bufferline-row"]').last();
    const messageLinks = lastRow.locator('.message a');
    await expect(messageLinks).toHaveCount(0, { timeout: 10000 });
    await expect(lastRow.locator('.message')).toContainText('data:text/html,<script>alert(1)</script>');
});

test('renders valid https:// URLs as links with rel="noopener noreferrer"', async () => {
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
    await botSay('Visit https://example.com for info');
    const lastRow = page.locator('[data-testid="bufferline-row"]').last();
    const anchor = lastRow.locator('.message a');
    await expect(anchor).toHaveAttribute('href', 'https://example.com');
    await expect(anchor).toHaveAttribute('target', '_blank');
    await expect(anchor).toHaveAttribute('rel', 'noopener noreferrer');
});

test('does NOT create nested anchor tags in messages', async () => {
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
    await botSay('See <a href="http://evil.com">link</a> here');
    const anchors = page.locator('[data-testid="bufferline-row"] .message a');
    const count = await anchors.count();
    for (let i = 0; i < count; i++) {
        const anchor = anchors.nth(i);
        const nestedAnchors = anchor.locator('a');
        await expect(nestedAnchors).toHaveCount(0);
    }
});

test('renders <script> tags as literal text in messages', async () => {
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
    await botSay('<script>alert("xss")</script>');
    const msgCell = page.locator('[data-testid="bufferline-row"] .message').last();
    await expect(msgCell).toContainText('<script>alert("xss")</script>', { timeout: 10000 });
    await expect(page.locator('[data-testid="bufferline-row"] .message script')).toHaveCount(0);
});

test('handles URLs with special characters safely', async () => {
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
    await botSay('Check https://example.com/path?q=<script>&foo=bar');
    const messageLinks = page.locator('[data-testid="bufferline-row"] .message a').first();
    await expect(messageLinks).toBeAttached({ timeout: 10000 });
    await expect(page.locator('[data-testid="bufferline-row"] .message').last()).toContainText('https://example.com/path');
});
