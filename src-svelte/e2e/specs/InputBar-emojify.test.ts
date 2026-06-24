import { test, expect } from '@playwright/test';
import { connectToWeechat, clearSettings, setSettings, waitForAppReady, reconnect, fillPortInput } from '../helpers/connection';
import { waitForBuffer, switchToBuffer } from '../helpers/buffers';

let page: import('@playwright/test').Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await page.route('**/cdnjs.cloudflare.com/**', (route) => route.abort());
    await page.goto('http://localhost:8001/');
    await waitForAppReady(page);
    await clearSettings(page);
    await setSettings(page, {
        savepassword: false,
        autoconnect: false,
        enableEmojify: true,
    });
    page.on('pageerror', (error) => {
        if (error.message?.includes('effect_orphan')) return;
    });
    await connectToWeechat(page);
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
});

test.afterAll(async () => {
    await page.close();
});

test.beforeEach(async () => {
    page.on('pageerror', (error) => {
        if (error.message?.includes('effect_orphan')) return;
    });
});



test('emoji shortcode converts to unicode while typing', async () => {
    const input = page.getByTestId('message-input');
    await input.focus();

    // Type emoji shortcode character by character to trigger incremental conversion
    await input.pressSequentially(':smi');
    await page.evaluate(() => new Promise(requestAnimationFrame));

    // Partial should not convert yet (must be complete :shortcode:)
    let value = await input.inputValue();
    expect(value).toContain(':smi');

    // Complete the shortcode
    await input.pressSequentially('le:');

    await expect(async () => {
        const val = await input.inputValue();
        expect(val).not.toContain(':smile:');
        expect(val).toContain('\u{1F604}');
    }).toPass({ timeout: 2000, intervals: [50] });
});

test('no conversion when emojify is disabled', async () => {
    await setSettings(page, { enableEmojify: false });
    await reconnect(page);

    await waitForBuffer(page, '#glowing-bear', 10000);
    await switchToBuffer(page, '#glowing-bear');

    const input = page.getByTestId('message-input');
    await input.focus();
    await input.fill(':heart:');
    await page.evaluate(() => new Promise(requestAnimationFrame));

    const value = await input.inputValue();
    expect(value).toBe(':heart:');
});

test('multiple emoji shortcodes in one message all convert', async () => {
    const input = page.getByTestId('message-input');
    await input.focus();
    await input.pressSequentially('Hello :smile: world :rocket:');

    await expect(async () => {
        const val = await input.inputValue();
        expect(val).toContain('\u{1F604}');
        expect(val).toContain('\u{1F680}');
        expect(val).not.toContain(':smile:');
        expect(val).not.toContain(':rocket:');
    }).toPass({ timeout: 3000, intervals: [100] });
});

test('emojify setting toggle persists', async () => {
    await page.getByTestId('settings-button').click();
    await expect(page.getByTestId('settings-modal')).toBeVisible({ timeout: 5000 });

    const checkbox = page.getByTestId('enableEmojify-checkbox');
    await expect(checkbox).toBeChecked();

    await checkbox.uncheck();
    await expect(checkbox).not.toBeChecked();

    await page.getByTestId('settings-modal-close').click();
    await expect(page.getByTestId('settings-modal')).not.toBeVisible({ timeout: 5000 });

    // Reopen and verify it stayed unchecked
    await page.getByTestId('settings-button').click();
    await expect(page.getByTestId('settings-modal')).toBeVisible({ timeout: 5000 });
    await expect(checkbox).not.toBeChecked();
    await page.getByTestId('settings-modal-close').click();
});
