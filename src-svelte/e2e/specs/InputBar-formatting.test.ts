import { test, expect } from '@playwright/test';
import { connectToWeechat, clearSettings, setSettings, waitForAppReady, reconnect } from '../helpers/connection';
import { waitForBuffer, switchToBuffer } from '../helpers/buffers';

import { setupEffectOrphanFilter } from '../helpers/pageerror';

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
        enableFormatting: true,
    });
    setupEffectOrphanFilter(page)
    await connectToWeechat(page);
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
});

test.afterAll(async () => {
    await page.close();
});

test.beforeEach(async () => {
    setupEffectOrphanFilter(page)
});

// Helper: read the raw DOM value of the textarea
async function getRawInputValue(): Promise<string> {
    return page.evaluate(() => {
        const el = document.querySelector('[data-testid="message-input"]') as HTMLTextAreaElement;
        return el?.value ?? '';
    });
}

// Helper: clear both Svelte state and DOM to reset formatting
async function clearFormattingState(): Promise<void> {
    await page.evaluate(() => {
        const reset = (window as typeof window & { __resetFormattingState?: () => void }).__resetFormattingState;
        if (typeof reset === 'function') {
            reset();
        }
    });
    await page.waitForTimeout(50);
}

// Bold button tests

test('Bold button inserts bold control char on click', async () => {
    const input = page.getByTestId('message-input');
    await input.focus();
    await page.waitForTimeout(50);

    await clearFormattingState();
    await page.waitForTimeout(50);

    // Click toggle to show toolbar, then click bold button
    await page.getByTestId('format-toggle').click();
    await page.waitForTimeout(50);
    await expect(page.locator('[role="toolbar"]')).toBeVisible();
    await page.getByTestId('format-bold').click();
    await page.waitForTimeout(50);
    await input.pressSequentially('bold text');
    await page.waitForTimeout(50);

    const value = await getRawInputValue();
    expect(value).toContain('\u0002');
    expect(value).toContain('bold text');
    expect(value).not.toContain('\u000f');
});

// Bold shortcut test

test('Ctrl+B inserts bold control char via shortcut', async () => {
    const input = page.getByTestId('message-input');
    await input.focus();
    await page.waitForTimeout(50);

    await clearFormattingState();
    await page.waitForTimeout(50);

    await page.keyboard.down('Control');
    await page.keyboard.press('b');
    await page.keyboard.up('Control');
    await page.waitForTimeout(50);

    await input.pressSequentially('bold text');
    await page.waitForTimeout(50);

    const value = await getRawInputValue();
    expect(value).toContain('\u0002');
    expect(value).toContain('bold text');
    expect(value).not.toContain('\u000f');
});

// Italic button tests

test('Italic button inserts italic control char on click', async () => {
    const input = page.getByTestId('message-input');
    await input.focus();
    await page.waitForTimeout(50);

    await clearFormattingState();
    await page.waitForTimeout(50);

    await page.getByTestId('format-toggle').click();
    await page.waitForTimeout(50);
    await page.getByTestId('format-italic').click();
    await page.waitForTimeout(50);
    await input.pressSequentially('italic');
    await page.waitForTimeout(50);

    const value = await getRawInputValue();
    expect(value).toContain('\u001d');
    expect(value).not.toContain('\u000f');
});

// Italic shortcut test

test('Ctrl+I inserts italic control char via shortcut', async () => {
    const input = page.getByTestId('message-input');
    await input.focus();
    await page.waitForTimeout(50);

    await clearFormattingState();
    await page.waitForTimeout(50);

    await page.keyboard.down('Control');
    await page.keyboard.press('i');
    await page.keyboard.up('Control');
    await page.waitForTimeout(50);

    await input.pressSequentially('italic text');
    await page.waitForTimeout(50);

    const value = await getRawInputValue();
    expect(value).toContain('\u001d');
    expect(value).toContain('italic text');
    expect(value).not.toContain('\u000f');
});

// Underline button tests

test('Underline button inserts underline control char on click', async () => {
    const input = page.getByTestId('message-input');
    await input.focus();
    await page.waitForTimeout(50);

    await clearFormattingState();
    await page.waitForTimeout(50);

    await page.getByTestId('format-toggle').click();
    await page.waitForTimeout(50);
    await page.getByTestId('format-underline').click();
    await page.waitForTimeout(50);
    await input.pressSequentially('under');
    await page.waitForTimeout(50);

    const value = await getRawInputValue();
    expect(value).toContain('\u001f');
    expect(value).not.toContain('\u000f');
});

// Underline shortcut tests

test('Ctrl+_ inserts underline control char via shortcut', async () => {
    const input = page.getByTestId('message-input');
    await input.focus();
    await page.waitForTimeout(50);

    await clearFormattingState();
    await page.waitForTimeout(50);

    // Ctrl+_ is produced by Ctrl+Shift+- on US keyboards
    await page.keyboard.down('Control');
    await page.keyboard.down('Shift');
    await page.keyboard.press('-');
    await page.keyboard.up('Shift');
    await page.keyboard.up('Control');
    await page.waitForTimeout(50);

    await input.pressSequentially('underlined text');
    await page.waitForTimeout(50);

    const value = await getRawInputValue();
    expect(value).toContain('\u001f');
    expect(value).toContain('underlined text');
    expect(value).not.toContain('\u000f');
});

// Reset button tests

test('Reset button inserts reset code', async () => {
    const input = page.getByTestId('message-input');
    await input.focus();
    await page.waitForTimeout(50);

    await clearFormattingState();
    await page.waitForTimeout(50);

    // Insert bold via button: toggle -> click bold -> toolbar hides
    await page.getByTestId('format-toggle').click();
    await page.waitForTimeout(50);
    await page.getByTestId('format-bold').click();
    await page.waitForTimeout(50);
    await input.pressSequentially('bold and reset');
    await page.waitForTimeout(30);

    // Toggle again to show toolbar, then click reset
    await page.getByTestId('format-toggle').click();
    await page.waitForTimeout(50);
    await page.getByTestId('format-reset').click();
    await page.waitForTimeout(50);

    const value = await getRawInputValue();
    expect(value).toContain('\u0002');
    expect(value).toContain('\u000f');
});

// Color picker tests

test('Ctrl+K opens color picker', async () => {
    const input = page.getByTestId('message-input');
    await input.focus();
    await page.waitForTimeout(50);

    await clearFormattingState();
    await page.waitForTimeout(50);

    // Color picker should be hidden initially
    await expect(page.locator('.color-picker-popover')).not.toBeVisible();

    // Open via Ctrl+K shortcut
    await page.keyboard.down('Control');
    await page.keyboard.press('k');
    await page.keyboard.up('Control');
    await page.waitForTimeout(100);

    await expect(page.locator('.color-picker-popover')).toBeVisible();

    // Should have 16 color swatches
    const swatches = page.locator('[data-testid^="color-"]');
    await expect(swatches).toHaveCount(16);

    // Close the picker for subsequent tests
    await page.mouse.click(0, 0);
    await page.waitForTimeout(300);
});

test('Color button opens color picker on click', async () => {
    const input = page.getByTestId('message-input');
    await input.focus();
    await page.waitForTimeout(50);

    await clearFormattingState();
    await page.waitForTimeout(50);

    // Click toggle to show toolbar, then click color button
    await page.getByTestId('format-toggle').click();
    await page.waitForTimeout(50);
    await page.getByTestId('format-color').click();
    await page.waitForTimeout(50);

    await expect(page.locator('.color-picker-popover')).toBeVisible();

    // Toolbar should be hidden after clicking color button
    await expect(page.locator('[role="toolbar"]')).not.toBeVisible();

    // Close the picker for subsequent tests
    await page.mouse.click(0, 0);
    await page.waitForTimeout(300);
});

test('Clicking a color inserts IRC color code (no reset)', async () => {
    const input = page.getByTestId('message-input');
    await input.focus();
    await page.waitForTimeout(50);

    await clearFormattingState();
    await page.waitForTimeout(50);

    // Open color picker via Ctrl+K shortcut
    await page.keyboard.down('Control');
    await page.keyboard.press('k');
    await page.keyboard.up('Control');
    await page.waitForTimeout(100);

    // Click red color (code 04)
    await page.getByTestId('color-04').click();
    await page.waitForTimeout(50);

    const value = await getRawInputValue();
    expect(value).toContain('\u000304');
    // Should NOT contain reset code
    expect(value).not.toContain('\u000f');

    // Color picker should be closed after selection
    await expect(page.locator('.color-picker-popover')).not.toBeVisible();
});

// Toolbar visibility tests

test('Format toolbar is hidden by default', async () => {
    await clearFormattingState();
    await page.waitForTimeout(100);

    await expect(page.locator('[role="toolbar"]')).not.toBeVisible();
});

test('Toggle button click shows format toolbar', async () => {
    await clearFormattingState();
    await page.waitForTimeout(50);

    await page.getByTestId('format-toggle').click();
    await page.waitForTimeout(50);

    await expect(page.locator('[role="toolbar"]')).toBeVisible();
    await expect(page.getByTestId('format-bold')).toBeVisible();
    await expect(page.getByTestId('format-italic')).toBeVisible();
    await expect(page.getByTestId('format-underline')).toBeVisible();
    await expect(page.getByTestId('format-reset')).toBeVisible();
    await expect(page.getByTestId('format-color')).toBeVisible();

    // Click toggle again to hide it for subsequent tests
    await page.getByTestId('format-toggle').click();
    await page.waitForTimeout(100);
});

test('Toggle button click toggles visibility', async () => {
    await clearFormattingState();
    await page.waitForTimeout(50);

    // First click -> show
    await page.getByTestId('format-toggle').click();
    await page.waitForTimeout(50);
    await expect(page.locator('[role="toolbar"]')).toBeVisible();

    // Second click -> hide
    await page.getByTestId('format-toggle').click();
    await page.waitForTimeout(50);
    await expect(page.locator('[role="toolbar"]')).not.toBeVisible();
});

test('Format button click hides toolbar', async () => {
    const input = page.getByTestId('message-input');
    await input.focus();
    await page.waitForTimeout(50);

    await clearFormattingState();
    await page.waitForTimeout(50);

    // Show toolbar via toggle
    await page.getByTestId('format-toggle').click();
    await page.waitForTimeout(50);
    await expect(page.locator('[role="toolbar"]')).toBeVisible();

    // Click bold -> toolbar hides
    await page.getByTestId('format-bold').click();
    await page.waitForTimeout(100);
    await expect(page.locator('[role="toolbar"]')).not.toBeVisible();
});

// Settings toggle test

test('Formatting disabled when setting is off', async () => {
    await setSettings(page, { enableFormatting: false });
    await reconnect(page);
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');

    const input = page.getByTestId('message-input');
    await input.focus();
    await page.waitForTimeout(50);

    await clearFormattingState();
    await page.waitForTimeout(50);

    // Format toggle button should not be visible when formatting is disabled
    await expect(page.getByTestId('format-toggle')).not.toBeVisible();

    await input.pressSequentially('should not be bold');
    await page.waitForTimeout(50);

    const value = await getRawInputValue();
    expect(value).toBe('should not be bold');
    expect(value).not.toContain('\u0002');
    expect(value).not.toContain('\u000f');
});

test('Formatting setting persists via settings modal', async () => {
    await setSettings(page, { enableFormatting: true });
    await reconnect(page);
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');

    await page.getByTestId('settings-button').click({ force: true });
    await expect(page.getByTestId('settings-modal')).toBeVisible({ timeout: 5000 });

    const checkbox = page.getByTestId('enableFormatting-checkbox');
    await expect(checkbox).toBeChecked();

    await checkbox.uncheck();
    await page.getByTestId('settings-modal-close').click({ force: true });
    await expect(page.getByTestId('settings-modal')).not.toBeVisible({ timeout: 5000 });

    // Reopen and verify it stayed unchecked
    await page.getByTestId('settings-button').click({ force: true });
    await expect(page.getByTestId('settings-modal')).toBeVisible({ timeout: 5000 });
    await expect(checkbox).not.toBeChecked();
    await page.getByTestId('settings-modal-close').click({ force: true });
});
