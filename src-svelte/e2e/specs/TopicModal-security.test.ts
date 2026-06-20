import { test, expect } from '@playwright/test';
import { createConnectedPage } from '../fixtures/auth';
import { waitForBuffer, switchToBuffer } from '../helpers/buffers';
import { irc } from '../helpers/irc-control';

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
});

async function openTopicModal() {
    await page.getByTestId('topic-bar').first().click();
}

async function closeTopicModal() {
    await page.mouse.click(1, 1);
}

test('does NOT linkify javascript: URLs in topic', async () => {
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
    await irc.setTopic('#glowing-bear', 'javascript:void(0)');
    await openTopicModal();
    await expect(page.getByTestId('topic-modal')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('topic-modal').locator('a')).toHaveCount(0);
    await expect(page.getByTestId('topic-modal')).toContainText('javascript:void(0)');
    await closeTopicModal();
    await expect(page.getByTestId('topic-modal')).not.toBeVisible({ timeout: 5000 });
});

test('renders valid URLs as links in topic modal', async () => {
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
    await irc.setTopic('#glowing-bear', 'Welcome to https://glowing-bear.org');
    await openTopicModal();
    const topicLink = page.locator('[data-testid="topic-modal"] a');
    await expect(topicLink).toHaveAttribute('href', 'https://glowing-bear.org', { timeout: 10000 });
    await closeTopicModal();
    await expect(page.getByTestId('topic-modal')).not.toBeVisible({ timeout: 5000 });
});

test('does NOT execute <script> tags in topic', async () => {
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
    await irc.setTopic('#glowing-bear', '<script>alert("xss")</script>');
    await openTopicModal();
    await expect(page.getByTestId('topic-modal')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('topic-modal').locator('script')).toHaveCount(0);
    await expect(page.getByTestId('topic-modal')).toContainText('<script>alert("xss")</script>');
    await closeTopicModal();
    await expect(page.getByTestId('topic-modal')).not.toBeVisible({ timeout: 5000 });
});

test('does NOT render <img> tags as images in topic', async () => {
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
    await irc.setTopic('#glowing-bear', '<img src=x onerror=alert(1)>');
    await openTopicModal();
    await expect(page.getByTestId('topic-modal')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('topic-modal').locator('img')).toHaveCount(0);
    await expect(page.getByTestId('topic-modal')).toContainText('<img src=x onerror=alert(1)>');
    await closeTopicModal();
    await expect(page.getByTestId('topic-modal')).not.toBeVisible({ timeout: 5000 });
});
