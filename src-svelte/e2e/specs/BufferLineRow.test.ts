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

// ---- BufferLineRow rendering tests ----

test.describe('rendering', () => {
    test.beforeAll(async () => {
        await waitForBuffer(page, '#glowing-bear', 15000);
        await switchToBuffer(page, '#glowing-bear');
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
        // Clear accumulated unread state from prior serial tests so auto-scroll works correctly
        await page.evaluate(() => {
            const container = document.querySelector('[data-testid="chat-messages"]') as HTMLElement;
            if (container) {
                container.scrollTop = container.scrollHeight;
                container.dispatchEvent(new Event('scroll', { bubbles: true }));
            }
        });
        await page.evaluate(() => new Promise(requestAnimationFrame));
        const msg = 'e2e-scroll-' + Date.now();
        const input = page.getByTestId('message-input');
        await input.fill(msg);
        await input.press('Enter');
        const messageCell = page.locator('[data-testid="bufferline-row"] td.message').filter({ hasText: msg });
        await expect(messageCell).toBeVisible({ timeout: 5000 });
        // Wait for rAF-based auto-scroll to complete
        await page.evaluate(() => new Promise(requestAnimationFrame));
        await page.evaluate(() => new Promise(requestAnimationFrame));
        // Verify chat container is scrolled to bottom
        const scrollState = await page.evaluate(() => {
            const container = document.querySelector('[data-testid="chat-messages"]') as HTMLElement;
            if (!container) return null;
            return {
                atBottom: container.scrollTop >= container.scrollHeight - container.clientHeight - 3,
                scrollDiff: container.scrollHeight - container.clientHeight - container.scrollTop,
            };
        });
        expect(scrollState).not.toBeNull();
        expect(scrollState!.atBottom).toBe(true);
        expect(scrollState!.scrollDiff).toBeLessThanOrEqual(3);
    });

    test('displays topic bar with buffer name after connecting', async () => {
        await expect(page.getByTestId('topic-bar')).toBeVisible();
        await expect(page.getByTestId('topic-bar').getByText('#glowing-bear')).toBeAttached();
    });

    test('has no error messages in console during connection and message rendering', async () => {
        const logs = await page.evaluate(() => (window as any).__consoleLogs || []);
        expect(logs.length).toBe(0);
    });
});

// ---- BufferLineRow linkification tests ----

test.describe('linkification', () => {
    test.beforeEach(async () => {
        await waitForBuffer(page, '#glowing-bear', 15000);
        await switchToBuffer(page, '#glowing-bear');
    });

    test('renders URLs in bufferline messages as links', async () => {
        const { botSay } = await import('../helpers/messages');
        await botSay('Check out https://example.com for more info');
        const link = page.locator('[data-testid="bufferline-row"] td.message a.irc-link').filter({ hasText: 'https://example.com' }).first();
        await expect(link).toBeAttached({ timeout: 10000 });
    });

    test('excludes trailing punctuation from URL links', async () => {
        const { botSay } = await import('../helpers/messages');
        await botSay('Visit https://example.com/page.');
        const link = page.locator('[data-testid="bufferline-row"] td.message a.irc-link').filter({ hasText: 'https://example.com/page' }).first();
        await expect(link).toHaveAttribute('href', 'https://example.com/page', { timeout: 10000 });
    });

    test('does NOT linkify email addresses', async () => {
        const { botSay } = await import('../helpers/messages');
        await botSay('Contact us at test@example.com');
        const msgCell = page.locator('[data-testid="bufferline-row"] td.message').filter({ hasText: 'test@example.com' }).first();
        await expect(msgCell).toBeAttached({ timeout: 10000 });
        const anchor = msgCell.locator('a');
        await expect(anchor).toHaveCount(0);
    });

    test('handles multiple URLs in one message', async () => {
        const { botSay } = await import('../helpers/messages');
        await botSay('See https://example.com and https://github.com');
        const targetRow = page.locator('[data-testid="bufferline-row"]').filter({ hasText: 'https://github.com' }).first();
        const links = targetRow.locator('td.message a.irc-link');
        await expect(links).toHaveCount(2, { timeout: 10000 });
    });

    test('renders FTP URLs as links', async () => {
        const { botSay } = await import('../helpers/messages');
        await botSay('Download from ftp://files.example.com/file.zip');
        const link = page.locator('[data-testid="bufferline-row"] td.message a.irc-link').filter({ hasText: 'ftp://files.example.com' }).first();
        await expect(link).toHaveAttribute('href', 'ftp://files.example.com/file.zip', { timeout: 10000 });
    });

    test('renders user-sent URLs as links', async () => {
        const { sendMessage } = await import('../helpers/messages');
        const msgText = 'Check out https://svelte.dev';
        await sendMessage(page, msgText);
        const targetRow = page.locator('[data-testid="bufferline-row"]').filter({ hasText: msgText }).first();
        const link = targetRow.locator('td.message a.irc-link').first();
        const href = await link.getAttribute('href');
        expect(href).toContain('https://svelte.dev');
    });

    test('shows links in topic bar', async () => {
        await irc.setTopic('#glowing-bear', 'Welcome! Visit https://glowing-bear.org');
        const topicLinks = page.locator('[data-testid="topic-bar"] a');
        await expect(topicLinks.first()).toHaveAttribute('href', 'https://glowing-bear.org', { timeout: 10000 });
    });

    test('has no nested anchor tags in messages', async () => {
        const { botSay } = await import('../helpers/messages');
        await botSay('Link: https://example.com');
        const targetRow = page.locator('[data-testid="bufferline-row"]').filter({ hasText: 'https://example.com' }).first();
        const links = targetRow.locator('td.message a.irc-link');
        const count = await links.count();
        expect(count).toBeGreaterThanOrEqual(1);
        for (let i = 0; i < count; i++) {
            const link = links.nth(i);
            const nestedAnchors = link.locator('a');
            await expect(nestedAnchors).toHaveCount(0);
        }
    });
});

// ---- BufferLineRow codify tests ----

test.describe('codify', () => {
    test.beforeEach(async () => {
        await waitForBuffer(page, '#glowing-bear', 15000);
        await switchToBuffer(page, '#glowing-bear');
    });

    test('renders single-backtick inline code in bufferline messages', async () => {
        const { botSay } = await import('../helpers/messages');
        await botSay('Use `hello` for inline code');
        const targetRow = page.locator('[data-testid="bufferline-row"]').filter({ hasText: 'inline code' }).first();
        const codeEl = targetRow.locator('td.message code').first();
        await expect(codeEl).toBeAttached({ timeout: 10000 });
        await expect(codeEl).toContainText('hello');
    });

    test('renders triple-backtick code block in bufferline messages', async () => {
        const { botSay } = await import('../helpers/messages');
        await botSay('Here is ```code block``` content');
        const targetRow = page.locator('[data-testid="bufferline-row"]').filter({ hasText: 'code block' }).first();
        const codeEl = targetRow.locator('td.message code').first();
        await expect(codeEl).toBeAttached({ timeout: 10000 });
        await expect(codeEl).toContainText('code block');
    });

    test('does NOT codify backticks without preceding space', async () => {
        const { botSay } = await import('../helpers/messages');
        await botSay('weird`sadsd`stuff');
        const targetRow = page.locator('[data-testid="bufferline-row"]').filter({ hasText: 'weird' }).first();
        const codeEls = targetRow.locator('td.message code');
        await expect(codeEls).toHaveCount(0);
        await expect(targetRow.locator('td.message')).toContainText('weird`sadsd`stuff');
    });

    test('renders hidden brackets around code in bufferlines', async () => {
        const { botSay } = await import('../helpers/messages');
        await botSay('test ```mycode``` end');
        const targetRow = page.locator('[data-testid="bufferline-row"]').filter({ hasText: 'mycode' }).first();
        const hiddenBrackets = targetRow.locator('td.message .hidden-bracket');
        await expect(hiddenBrackets).toHaveCount(2, { timeout: 10000 });
        const bracketTexts = await hiddenBrackets.allTextContents();
        expect(bracketTexts).toContain('```');
    });

    test('handles mixed text and code in bufferline', async () => {
        const { botSay } = await import('../helpers/messages');
        await botSay('this is ```<code>``` more text');
        const targetRow = page.locator('[data-testid="bufferline-row"]').filter({ hasText: '<code>' }).first();
        const codeEl = targetRow.locator('td.message code').first();
        await expect(codeEl).toBeAttached({ timeout: 10000 });
        await expect(codeEl).toContainText('<code>');
        await expect(targetRow.locator('td.message')).toContainText('this is');
        await expect(targetRow.locator('td.message')).toContainText('more text');
    });

    test('nested backticks do not break code block rendering', async () => {
        const { botSay } = await import('../helpers/messages');
        await botSay('outer ```has `inner` backtick``` end');
        const targetRow = page.locator('[data-testid="bufferline-row"]').filter({ hasText: 'backtick' }).first();
        const codeEl = targetRow.locator('td.message code').first();
        await expect(codeEl).toBeAttached({ timeout: 10000 });
        const codeContent = await codeEl.textContent();
        expect(codeContent).toContain('has `inner` backtick');
    });

    // Topic (LinkifiedText) tests
    test('renders inline code in topic bar', async () => {
        await irc.setTopic('#glowing-bear', 'Use `command` to run');
        await page.getByTestId('topic-bar').first().click();
        await expect(page.getByTestId('topic-modal')).toBeVisible({ timeout: 5000 });
        const codeEl = page.locator('[data-testid="topic-modal"] code').first();
        await expect(codeEl).toBeAttached({ timeout: 5000 });
        await expect(codeEl).toContainText('command');
        await page.mouse.click(1, 1);
        await expect(page.getByTestId('topic-modal')).not.toBeVisible({ timeout: 5000 });
    });

    test('renders triple-backtick code in topic modal', async () => {
        await irc.setTopic('#glowing-bear', 'Config: ```key=value``` here');
        await page.getByTestId('topic-bar').first().click();
        await expect(page.getByTestId('topic-modal')).toBeVisible({ timeout: 5000 });
        const codeEl = page.locator('[data-testid="topic-modal"] code').first();
        await expect(codeEl).toBeAttached({ timeout: 5000 });
        await expect(codeEl).toContainText('key=value');
        await page.mouse.click(1, 1);
        await expect(page.getByTestId('topic-modal')).not.toBeVisible({ timeout: 5000 });
    });

    test('does NOT codify without space in topic', async () => {
        await irc.setTopic('#glowing-bear', 'weird`stuff`here');
        await page.getByTestId('topic-bar').first().click();
        await expect(page.getByTestId('topic-modal')).toBeVisible({ timeout: 5000 });
        const codeEls = page.locator('[data-testid="topic-modal"] code');
        await expect(codeEls).toHaveCount(0);
        await expect(page.getByTestId('topic-modal')).toContainText('weird`stuff`here');
        await page.mouse.click(1, 1);
        await expect(page.getByTestId('topic-modal')).not.toBeVisible({ timeout: 5000 });
    });
});

// ---- BufferLineRow vertical alignment tests ----

test.describe('vertical alignment', () => {
    test.beforeEach(async () => {
        await waitForBuffer(page, '#glowing-bear', 15000);
        await switchToBuffer(page, '#glowing-bear');
    });

    test('time and nick align to top on multi-line messages', async () => {
        const longMsg = 'line1 ' + 'a'.repeat(300) + ' line3';
        await irc.sendMessage('#glowing-bear', longMsg);
        const row = page.locator('[data-testid="bufferline-row"] td.message').filter({ hasText: 'line1' }).first();
        await expect(row).toBeVisible({ timeout: 10000 });

        const timeStyle = await page.evaluate(() => {
            const td = document.querySelector('td.time');
            return td ? window.getComputedStyle(td).verticalAlign : null;
        });
        const prefixStyle = await page.evaluate(() => {
            const td = document.querySelector('td.prefix');
            return td ? window.getComputedStyle(td).verticalAlign : null;
        });
        expect(timeStyle).toBe('top');
        expect(prefixStyle).toBe('top');
    });

    test('time and nick align to top on single-line messages', async () => {
        const msg = 'short-msg-' + Date.now();
        await irc.sendMessage('#glowing-bear', msg);
        const row = page.locator('[data-testid="bufferline-row"] td.message').filter({ hasText: msg }).first();
        await expect(row).toBeVisible({ timeout: 10000 });

        const timeStyle = await page.evaluate(() => {
            const td = document.querySelector('td.time');
            return td ? window.getComputedStyle(td).verticalAlign : null;
        });
        const prefixStyle = await page.evaluate(() => {
            const td = document.querySelector('td.prefix');
            return td ? window.getComputedStyle(td).verticalAlign : null;
        });
        expect(timeStyle).toBe('top');
        expect(prefixStyle).toBe('top');
    });
});
