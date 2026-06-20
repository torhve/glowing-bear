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
    // Use filter with hasText to target the specific message row.
    const msgCell = page.locator('[data-testid="bufferline-row"] td.message').filter({ hasText: 'javascript:void' }).first();
    await expect(msgCell).toBeVisible({ timeout: 10000 });
    const messageLinks = msgCell.locator('a');
    await expect(messageLinks).toHaveCount(0);
    await expect(msgCell).toContainText('javascript:void(document.body.innerHTML="HACKED")');
});

test('does NOT render <img> tags as images in messages', async () => {
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
    await botSay('Look at this <img src=x onerror=alert(1)> tag');
    const msgCell = page.locator('[data-testid="bufferline-row"] td.message').filter({ hasText: '<img src=x onerror=alert(1)>' }).first();
    await expect(msgCell).toBeVisible({ timeout: 10000 });
    await expect(msgCell).toContainText('<img src=x onerror=alert(1)>');
    await expect(page.locator('[data-testid="bufferline-row"] .message img')).toHaveCount(0);
});

test('does NOT execute onerror handlers in messages', async () => {
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
    await botSay('<div onerror="alert(\'xss\')">test</div>');
    // Use a unique filter to avoid matching previous test's message also containing "onerror"
    const msgCell = page.locator('[data-testid="bufferline-row"] td.message').filter({ hasText: "alert('xss')" }).first();
    await expect(msgCell).toBeVisible({ timeout: 10000 });
    await expect(msgCell).toContainText('<div onerror="alert(\'xss\')">test</div>');
});

test('does NOT linkify data: URLs in messages', async () => {
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
    await botSay('Check out data:text/html,<script>alert(1)</script>');
    // Use filter with hasText to target the specific message row.
    const msgCell = page.locator('[data-testid="bufferline-row"] td.message').filter({ hasText: 'data:text/html' }).first();
    await expect(msgCell).toBeVisible({ timeout: 10000 });
    const messageLinks = msgCell.locator('a');
    await expect(messageLinks).toHaveCount(0);
    await expect(msgCell).toContainText('data:text/html,<script>alert(1)</script>');
});

test('renders valid https:// URLs as links with rel="noopener noreferrer"', async () => {
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
    await botSay('Visit https://gitlab.com for info');
    // Use a unique URL that won't match any prior test's message text.
    const msgCell = page.locator('[data-testid="bufferline-row"] td.message').filter({ hasText: 'https://gitlab.com' }).first();
    await expect(msgCell).toBeVisible({ timeout: 10000 });
    const anchor = msgCell.locator('a');
    await expect(anchor).toHaveAttribute('href', 'https://gitlab.com');
    await expect(anchor).toHaveAttribute('target', '_blank');
    await expect(anchor).toHaveAttribute('rel', 'noopener noreferrer');
});

test('does NOT create nested anchor tags in messages', async () => {
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
    await botSay('See <a href="http://evil.com">link</a> here');
    // Use filter to target the specific message row.
    const msgCell = page.locator('[data-testid="bufferline-row"] td.message').filter({ hasText: 'evil.com' }).first();
    await expect(msgCell).toBeVisible({ timeout: 10000 });
    const anchors = msgCell.locator('a');
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
    await botSay('<script>alert("script-test-xyz")</script>');
    // Use a unique substring to avoid matching previous test's message also containing "<script>alert"
    const msgCell = page.locator('[data-testid="bufferline-row"] td.message').filter({ hasText: 'script-test-xyz' }).first();
    await expect(msgCell).toBeVisible({ timeout: 10000 });
    await expect(msgCell).toContainText('<script>alert("script-test-xyz")</script>');
    await expect(page.locator('[data-testid="bufferline-row"] .message script')).toHaveCount(0);
});

test('handles URLs with special characters safely', async () => {
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
    await botSay('Check https://github.com/path?q=<script>&foo=bar');
    // Use filter to target the specific message row.
    const msgCell = page.locator('[data-testid="bufferline-row"] td.message').filter({ hasText: 'https://github.com/path' }).first();
    await expect(msgCell).toBeVisible({ timeout: 10000 });
    const messageLinks = msgCell.locator('a');
    await expect(messageLinks).toBeAttached();
    await expect(msgCell).toContainText('https://github.com/path');
});
