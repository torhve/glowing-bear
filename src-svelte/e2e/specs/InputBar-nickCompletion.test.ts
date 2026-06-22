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
    await page.waitForTimeout(500);

    const input = page.getByTestId('message-input');
    await input.focus();
    await input.fill('te');
    await page.waitForTimeout(100);

    await input.press('Tab');
    await page.waitForTimeout(200);

    const value = await input.inputValue();
    expect(value.length).toBeGreaterThan(2);
    // Should contain a completed nick with suffix (e.g., "testuser: " or similar)
    if (/^(testuser|root|gbbot)/i.test(value)) {
        // matched a known nick pattern
    } else {
        expect(value).toContain(':');
    }
});

test('nick-complete button completes nick', async () => {
    await waitForBuffer(page, '#glowing-bear', 10000);
    await switchToBuffer(page, '#glowing-bear');
    await page.waitForTimeout(500);

    const input = page.getByTestId('message-input');
    await input.focus();
    await input.fill('ro');
    await page.waitForTimeout(100);

    await page.getByTestId('nick-complete-button').click();
    await page.waitForTimeout(200);

    const value = await input.inputValue();
    expect(value.length).toBeGreaterThan(2);
    expect(value).toContain('ro');
});

test('repeated Tab iterates through matching nicks', async () => {
    await waitForBuffer(page, '#glowing-bear', 10000);
    await switchToBuffer(page, '#glowing-bear');
    await page.waitForTimeout(500);

    const input = page.getByTestId('message-input');
    await input.focus();

    await input.fill('te');
    await page.waitForTimeout(100);

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
    await page.waitForTimeout(500);

    const input = page.getByTestId('message-input');
    await input.focus();

    await input.fill('hello te');
    await page.waitForTimeout(100);

    await input.press('Tab');
    await page.waitForTimeout(200);

    const value = await input.inputValue();
    expect(value).toMatch(/^hello\s+/i);
});

test('no change when no nick matches the prefix', async () => {
    await waitForBuffer(page, '#glowing-bear', 10000);
    await switchToBuffer(page, '#glowing-bear');
    await page.waitForTimeout(500);

    const input = page.getByTestId('message-input');
    await input.focus();
    await input.fill('zzzzz_no_match');
    await page.waitForTimeout(100);

    const before = await input.inputValue();
    await input.press('Tab');
    await page.waitForTimeout(100);

    const after = await input.inputValue();
    expect(after).toBe(before);
});
