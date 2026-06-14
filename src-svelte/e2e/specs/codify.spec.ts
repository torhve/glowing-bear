import { test, expect } from '@playwright/test';
import { connectToWeechat, clearSettings, waitForAppReady } from '../helpers/connection';
import { botSay } from '../helpers/messages';
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

// ---- Bufferline tests ----

test('renders single-backtick inline code in bufferline messages', async () => {
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
    await botSay('Use `hello` for inline code');
    const lastRow = page.locator('[data-testid="bufferline-row"]').last();
    const codeEl = lastRow.locator('td.message code').first();
    await expect(codeEl).toBeAttached({ timeout: 10000 });
    await expect(codeEl).toContainText('hello');
});

test('renders triple-backtick code block in bufferline messages', async () => {
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
    await botSay('Here is ```code block``` content');
    const lastRow = page.locator('[data-testid="bufferline-row"]').last();
    const codeEl = lastRow.locator('td.message code').first();
    await expect(codeEl).toBeAttached({ timeout: 10000 });
    await expect(codeEl).toContainText('code block');
});

test('does NOT codify backticks without preceding space', async () => {
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
    await botSay('weird`sadsd`stuff');
    const lastRow = page.locator('[data-testid="bufferline-row"]').last();
    const codeEls = lastRow.locator('td.message code');
    await expect(codeEls).toHaveCount(0);
    await expect(lastRow.locator('td.message')).toContainText('weird`sadsd`stuff');
});

test('renders hidden brackets around code in bufferlines', async () => {
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
    await botSay('test ```mycode``` end');
    const lastRow = page.locator('[data-testid="bufferline-row"]').last();
    const hiddenBrackets = lastRow.locator('td.message .hidden-bracket');
    await expect(hiddenBrackets).toHaveCount(2, { timeout: 10000 });
    const bracketTexts = await hiddenBrackets.allTextContents();
    expect(bracketTexts).toContain('```');
});

test('handles mixed text and code in bufferline', async () => {
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
    await botSay('this is ```<code>``` more text');
    const lastRow = page.locator('[data-testid="bufferline-row"]').last();
    const codeEl = lastRow.locator('td.message code').first();
    await expect(codeEl).toBeAttached({ timeout: 10000 });
    await expect(codeEl).toContainText('<code>');
    await expect(lastRow.locator('td.message')).toContainText('this is');
    await expect(lastRow.locator('td.message')).toContainText('more text');
});

test('nested backticks do not break code block rendering', async () => {
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
    await botSay('outer ```has `inner` backtick``` end');
    const lastRow = page.locator('[data-testid="bufferline-row"]').last();
    const codeEl = lastRow.locator('td.message code').first();
    await expect(codeEl).toBeAttached({ timeout: 10000 });
    const codeContent = await codeEl.textContent();
    expect(codeContent).toContain('has `inner` backtick');
});

// ---- Topic (LinkifiedText) tests ----

async function openTopicModal() {
    await page.getByTestId('topic-bar').first().click();
}

async function closeTopicModal() {
    await page.mouse.click(1, 1);
}

test('renders inline code in topic bar', async () => {
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
    await irc.setTopic('#glowing-bear', 'Use `command` to run');
    await openTopicModal();
    await expect(page.getByTestId('topic-modal')).toBeVisible({ timeout: 5000 });
    const codeEl = page.locator('[data-testid="topic-modal"] code').first();
    await expect(codeEl).toBeAttached({ timeout: 5000 });
    await expect(codeEl).toContainText('command');
    await closeTopicModal();
    await expect(page.getByTestId('topic-modal')).not.toBeVisible({ timeout: 5000 });
});

test('renders triple-backtick code in topic modal', async () => {
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
    await irc.setTopic('#glowing-bear', 'Config: ```key=value``` here');
    await openTopicModal();
    await expect(page.getByTestId('topic-modal')).toBeVisible({ timeout: 5000 });
    const codeEl = page.locator('[data-testid="topic-modal"] code').first();
    await expect(codeEl).toBeAttached({ timeout: 5000 });
    await expect(codeEl).toContainText('key=value');
    await closeTopicModal();
    await expect(page.getByTestId('topic-modal')).not.toBeVisible({ timeout: 5000 });
});

test('does NOT codify without space in topic', async () => {
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
    await irc.setTopic('#glowing-bear', 'weird`stuff`here');
    await openTopicModal();
    await expect(page.getByTestId('topic-modal')).toBeVisible({ timeout: 5000 });
    const codeEls = page.locator('[data-testid="topic-modal"] code');
    await expect(codeEls).toHaveCount(0);
    await expect(page.getByTestId('topic-modal')).toContainText('weird`stuff`here');
    await closeTopicModal();
    await expect(page.getByTestId('topic-modal')).not.toBeVisible({ timeout: 5000 });
});
