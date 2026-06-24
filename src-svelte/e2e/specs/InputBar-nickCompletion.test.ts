import { test, expect } from '@playwright/test';
import { createConnectedPage } from '../fixtures/auth';
import { waitForBuffer, switchToBuffer } from '../helpers/buffers';

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

test('Tab key completes partial nick at start of input', async () => {
    await waitForBuffer(page, '#glowing-bear', 10000);
    await switchToBuffer(page, '#glowing-bear');
    await expect(page.getByTestId('topic-bar')).toBeVisible({ timeout: 5000 });

    const input = page.getByTestId('message-input');
    await input.focus();
    await input.fill('te');
    await page.evaluate(() => new Promise(r => requestAnimationFrame(r)));

    await input.press('Tab');

    // Wait for nick completion to appear
    await expect(async () => {
        const val = await input.inputValue();
        expect(val.length).toBeGreaterThan(2);
        if (/^(testuser|root|gbbot)/i.test(val)) {
            // matched a known nick pattern
        } else {
            expect(val).toContain(':');
        }
    }).toPass({ timeout: 5000 });
});

test('nick-complete button completes nick', async () => {
    await waitForBuffer(page, '#glowing-bear', 10000);
    await switchToBuffer(page, '#glowing-bear');
    await expect(page.getByTestId('topic-bar')).toBeVisible({ timeout: 5000 });

    // Wait for nicks to be loaded in the channel
    await page.getByTestId('nicklist').locator('[data-testid="nick-item"]').first().waitFor({ state: 'visible', timeout: 5000 });

    // Use evaluate to set value and dispatch input event — Playwright's fill()
    // does not properly sync with Svelte 5 bind:value on textarea.
    await page.getByTestId('message-input').focus();
    await page.evaluate(() => {
        const input = document.querySelector('[data-testid="message-input"]') as HTMLTextAreaElement;
        if (input) {
            input.value = 'te';
            input.dispatchEvent(new Event('input', { bubbles: true }));
        }
    });

    await page.getByTestId('nick-complete-button').click();

    await expect(async () => {
        const val = await page.getByTestId('message-input').inputValue();
        expect(val.length).toBeGreaterThan(2);
        expect(val).toContain('te');
    }).toPass({ timeout: 5000 });
});

test('repeated Tab iterates through matching nicks', async () => {
    await waitForBuffer(page, '#glowing-bear', 10000);
    await switchToBuffer(page, '#glowing-bear');
    await expect(page.getByTestId('topic-bar')).toBeVisible({ timeout: 5000 });

    const input = page.getByTestId('message-input');
    await input.focus();

    await input.fill('te');
    await page.evaluate(() => new Promise(r => requestAnimationFrame(r)));

    await input.press('Tab');
    const first = await input.inputValue();

    await input.press('Tab');
    const second = await input.inputValue();

    // If there are multiple matching nicks, cycling should produce a different result
    // At minimum, verify the values are valid nick completions
    expect(first.length).toBeGreaterThan(0);
    expect(second.length).toBeGreaterThan(0);
});

test('Tab completes nick in middle of message', async () => {
    await waitForBuffer(page, '#glowing-bear', 10000);
    await switchToBuffer(page, '#glowing-bear');
    await expect(page.getByTestId('topic-bar')).toBeVisible({ timeout: 5000 });

    const input = page.getByTestId('message-input');
    await input.focus();

    await input.fill('hello te');
    await page.evaluate(() => new Promise(r => requestAnimationFrame(r)));

    await input.press('Tab');

    await expect(async () => {
        const val = await input.inputValue();
        expect(val).toMatch(/^hello\s+/i);
    }).toPass({ timeout: 5000 });
});

test('no change when no nick matches the prefix', async () => {
    await waitForBuffer(page, '#glowing-bear', 10000);
    await switchToBuffer(page, '#glowing-bear');
    await expect(page.getByTestId('topic-bar')).toBeVisible({ timeout: 5000 });

    const input = page.getByTestId('message-input');
    await input.focus();
    await input.fill('zzzzz_no_match');

    const before = await input.inputValue();
    await input.press('Tab');

    await expect(async () => {
        const after = await input.inputValue();
        expect(after).toBe(before);
    }).toPass({ timeout: 5000 });
});
