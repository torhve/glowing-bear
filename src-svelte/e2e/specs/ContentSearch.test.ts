import { test, expect } from '@playwright/test';
import { createConnectedPage } from '../fixtures/auth';
import { waitForBuffer, switchToBuffer } from '../helpers/buffers';
import { irc } from '../helpers/irc-control';
import { setupEffectOrphanFilter } from '../helpers/pageerror';

let page: import('@playwright/test').Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
    page = await createConnectedPage(browser);
    setupEffectOrphanFilter(page);
});

test.afterAll(async () => {
    await page.close();
});

test.beforeEach(async () => {
    setupEffectOrphanFilter(page);
});

async function openContentSearch(p: import('@playwright/test').Page) {
    await p.evaluate(() => {
        document.dispatchEvent(
            new KeyboardEvent('keydown', {
                ctrlKey: true,
                code: 'KeyF',
                key: 'f',
                keyCode: 70,
                bubbles: true,
            }),
        );
    });
    await expect(p.locator('#content-search-modal')).toBeVisible({
        timeout: 5000,
    });
}

async function closeContentSearch(p: import('@playwright/test').Page) {
    await p.getByTestId('content-search-close').click();
    await expect(p.locator('#content-search-modal')).not.toBeVisible({
        timeout: 5000,
    });
}

async function waitForGrepBuffer(
    p: import('@playwright/test').Page,
    timeout = 10000,
) {
    // WeeChat's grep buffer shortName is 'grep' (fullName: 'python.grep')
    await waitForBuffer(p, 'grep', timeout);
}

test('Ctrl+F opens content search modal', async () => {
    // Ensure we're on a real buffer (not the grep buffer)
    await switchToBuffer(page, '#glowing-bear');
    await openContentSearch(page);
});

test('content search modal auto-focuses input when opened', async () => {
    await switchToBuffer(page, '#glowing-bear');
    await openContentSearch(page);

    const focused = await page.evaluate(() => {
        return document.activeElement?.id === 'content-search-input';
    });
    expect(focused).toBe(true);
});

test('content search modal shows correct title and hint', async () => {
    await switchToBuffer(page, '#glowing-bear');
    await openContentSearch(page);

    await expect(page.getByText('Search Buffer Content')).toBeVisible();
    await expect(
        page.getByText('Press Enter to search current buffer'),
    ).toBeVisible();
});

test('Enter key executes search and closes modal', async () => {
    await switchToBuffer(page, '#glowing-bear');
    await openContentSearch(page);

    const testMsg = `e2e-grep-enter-${Date.now()}`;
    await page.locator('#content-search-input').fill(testMsg);

    // Press Enter — triggers executeContentSearch which sends /grep and closes modal
    await page.locator('#content-search-input').press('Enter');

    // Modal should close after search execution
    await expect(page.locator('#content-search-modal')).not.toBeVisible({
        timeout: 5000,
    });
});

test('close button closes the modal', async () => {
    await switchToBuffer(page, '#glowing-bear');
    await openContentSearch(page);

    await closeContentSearch(page);
});

test('grep buffer is auto-switched after search', async () => {
    await switchToBuffer(page, '#glowing-bear');

    // Send a message we can actually find
    const testMsg = `e2e-grep-auto-switch-${Date.now()}`;
    await irc.sendMessage('#glowing-bear', testMsg);
    const msgRow = page
        .locator('[data-testid="bufferline-row"] td.message')
        .filter({ hasText: testMsg })
        .first();
    await expect(msgRow).toBeVisible({ timeout: 10000 });

    await openContentSearch(page);
    await page.locator('#content-search-input').fill(testMsg);

    // Execute search — triggers executeContentSearch which sends /grep and switches to grep buffer
    await page.locator('#content-search-input').press('Enter');

    // Wait for grep buffer to appear and be active
    await waitForGrepBuffer(page, 15000);

    // Verify we're now on the grep buffer
    await expect(
        page.getByTestId('topic-bar').locator('.topic-channel-name'),
    ).toContainText('grep', { timeout: 5000 });
});

test('empty query does not trigger search', async () => {
    await switchToBuffer(page, '#glowing-bear');
    await openContentSearch(page);

    // Make sure input is empty
    await page.locator('#content-search-input').fill('');

    // Press Enter with empty input — modal should stay open
    await page.locator('#content-search-input').press('Enter');

    // Modal should still be visible (no search was executed)
    await expect(page.locator('#content-search-modal')).toBeVisible({
        timeout: 3000,
    });

    await closeContentSearch(page);
});

test('paste goes to search input, not message bar, when modal is open', async () => {
    await switchToBuffer(page, '#glowing-bear');
    await openContentSearch(page);

    const pasteText = `paste-target-${Date.now()}`;

    // Focus the search input and fill it with text
    await page.locator('#content-search-input').fill(pasteText);

    // Verify the search input has the pasted text
    const inputValue = await page.locator('#content-search-input').inputValue();
    expect(inputValue).toBe(pasteText);

    // Verify the message input was NOT affected by the global paste handler
    const msgInput = await page
        .locator('[data-testid="message-input"]')
        .inputValue();
    expect(msgInput).toBe('');

    await closeContentSearch(page);
});

test('search results appear in grep buffer', async () => {
    // First ensure we're on #glowing-bear
    await switchToBuffer(page, '#glowing-bear');

    // Send a unique message to the channel
    const testMsg = `grep-visible-${Date.now()}`;
    await irc.sendMessage('#glowing-bear', testMsg);

    // Wait for the message to appear in chat
    const msgRow = page
        .locator('[data-testid="bufferline-row"] td.message')
        .filter({ hasText: testMsg })
        .first();
    await expect(msgRow).toBeVisible({ timeout: 10000 });

    // Now search for it
    await openContentSearch(page);
    await page.locator('#content-search-input').fill(testMsg);
    await page.locator('#content-search-input').press('Enter');

    // Wait for grep buffer to appear and switch to it
    await waitForGrepBuffer(page, 15000);
    await page.waitForTimeout(2000);

    // Switch back to #glowing-bear first to see messages there
    await switchToBuffer(page, '#glowing-bear');

    // Re-run grep to populate results
    await openContentSearch(page);
    await page.locator('#content-search-input').fill(testMsg);
    await page.locator('#content-search-input').press('Enter');

    // Wait for grep buffer to appear
    await waitForGrepBuffer(page, 15000);
    await page.waitForTimeout(2000);

    // The grep buffer should contain the message
    const grepResult = page
        .locator('[data-testid="bufferline-row"] td.message')
        .filter({ hasText: testMsg })
        .first();
    await expect(grepResult).toBeVisible({ timeout: 10000 });
});
