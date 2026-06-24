import { test, expect } from '@playwright/test';
import { connectToWeechat, clearSettings, setSettings, waitForAppReady, reconnect } from '../helpers/connection';
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
        enableFormatting: true,
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

// Helper: read the raw DOM value of the textarea
async function getRawInputValue(): Promise<string> {
    return page.evaluate(() => {
        const el = document.querySelector('[data-testid="message-input"]') as HTMLTextAreaElement;
        return el?.value ?? '';
    });
}

// Helper: programmatically set the message state and update the textarea DOM
async function setMessage(text: string): Promise<void> {
    await page.evaluate((msg) => {
        const el = document.querySelector('[data-testid="message-input"]') as HTMLTextAreaElement;
        if (el) {
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
            nativeInputValueSetter?.call(el, msg);
            el.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }, text);
    await page.waitForTimeout(30);
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

// Bold insertion tests

test('Ctrl+B inserts bold control char at cursor', async () => {
    const input = page.getByTestId('message-input');
    await input.focus();
    await page.waitForTimeout(50);

    await clearFormattingState();
    await page.waitForTimeout(50);

    // Press Ctrl+B to insert bold code, then type text
    await input.press('Control+b');
    await page.waitForTimeout(50);
    await input.pressSequentially('hello');
    await page.waitForTimeout(50);

    // Should have bold open code (\x02 = \u0002)
    const value = await getRawInputValue();
    expect(value).toContain('\u0002');
    expect(value.startsWith('\u0002')).toBe(true);
});

test('Bold button inserts bold control char on click', async () => {
    const input = page.getByTestId('message-input');
    await input.focus();
    await page.waitForTimeout(50);

    await clearFormattingState();
    await page.waitForTimeout(50);

    // Click the bold button, then type
    await page.getByTestId('format-bold').click();
    await page.waitForTimeout(50);
    await input.pressSequentially('bold text');
    await page.waitForTimeout(50);

    const value = await getRawInputValue();
    expect(value).toContain('\u0002');
    expect(value).toContain('bold text');
    expect(value).not.toContain('\u000f');
});

// Italic insertion tests

test('Ctrl+I inserts italic control char at cursor', async () => {
    const input = page.getByTestId('message-input');
    await input.focus();
    await page.waitForTimeout(50);

    await clearFormattingState();
    await page.waitForTimeout(50);

    await input.press('Control+i');
    await page.waitForTimeout(50);
    await input.pressSequentially('italic text');
    await page.waitForTimeout(50);

    const value = await getRawInputValue();
    expect(value).toContain('\u001d');
    expect(value.startsWith('\u001d')).toBe(true);
});

test('Italic button inserts italic control char on click', async () => {
    const input = page.getByTestId('message-input');
    await input.focus();
    await page.waitForTimeout(50);

    await clearFormattingState();
    await page.waitForTimeout(50);

    await page.getByTestId('format-italic').click();
    await page.waitForTimeout(50);
    await input.pressSequentially('italic');
    await page.waitForTimeout(50);

    const value = await getRawInputValue();
    expect(value).toContain('\u001d');
    expect(value).not.toContain('\u000f');
});

// Underline insertion tests

test('Ctrl+U inserts underline control char at cursor', async () => {
    const input = page.getByTestId('message-input');
    await input.focus();
    await page.waitForTimeout(50);

    await clearFormattingState();
    await page.waitForTimeout(50);

    await input.press('Control+u');
    await page.waitForTimeout(50);
    await input.pressSequentially('underlined');
    await page.waitForTimeout(50);

    const value = await getRawInputValue();
    expect(value).toContain('\u001f');
    expect(value.startsWith('\u001f')).toBe(true);
});

test('Underline button inserts underline control char on click', async () => {
    const input = page.getByTestId('message-input');
    await input.focus();
    await page.waitForTimeout(50);

    await clearFormattingState();
    await page.waitForTimeout(50);

    await page.getByTestId('format-underline').click();
    await page.waitForTimeout(50);
    await input.pressSequentially('under');
    await page.waitForTimeout(50);

    const value = await getRawInputValue();
    expect(value).toContain('\u001f');
    expect(value).not.toContain('\u000f');
});

// Reset tests

test('Reset button inserts reset code', async () => {
    const input = page.getByTestId('message-input');
    await input.focus();
    await page.waitForTimeout(50);

    await clearFormattingState();
    await page.waitForTimeout(50);

    // Insert bold, type text, then reset
    await input.press('Control+b');
    await page.waitForTimeout(30);
    await input.pressSequentially('bold and reset');
    await page.waitForTimeout(30);
    await page.getByTestId('format-reset').click();
    await page.waitForTimeout(50);

    const value = await getRawInputValue();
    expect(value).toContain('\u0002');
    expect(value).toContain('\u000f');
});

test('Ctrl+Shift+R inserts reset code', async () => {
    const input = page.getByTestId('message-input');
    await input.focus();
    await page.waitForTimeout(50);

    await clearFormattingState();
    await page.waitForTimeout(50);

    await input.press('Control+b');
    await page.waitForTimeout(30);
    await input.pressSequentially('test');
    await page.waitForTimeout(30);
    await input.press('Control+Shift+r');
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

    // Press Ctrl+K to open
    await input.press('Control+k');
    await page.waitForTimeout(50);

    await expect(page.locator('.color-picker-popover')).toBeVisible();

    // Should have 16 color swatches
    const swatches = page.locator('[data-testid^="color-"]');
    await expect(swatches).toHaveCount(16);
});

test('Color picker toggle closes with Ctrl+K again', async () => {
    const input = page.getByTestId('message-input');
    await input.focus();
    await page.waitForTimeout(50);

    await clearFormattingState();
    await page.waitForTimeout(50);

    await input.press('Control+k');
    await page.waitForTimeout(50);
    await expect(page.locator('.color-picker-popover')).toBeVisible();

    await input.press('Control+k');
    await page.waitForTimeout(50);
    await expect(page.locator('.color-picker-popover')).not.toBeVisible();
});

test('Clicking a color inserts IRC color code (no reset)', async () => {
    const input = page.getByTestId('message-input');
    await input.focus();
    await page.waitForTimeout(50);

    await clearFormattingState();
    await page.waitForTimeout(50);

    await input.press('Control+k');
    await page.waitForTimeout(50);

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

test('Color button opens color picker on click', async () => {
    const input = page.getByTestId('message-input');
    await input.focus();
    await page.waitForTimeout(50);

    await clearFormattingState();
    await page.waitForTimeout(50);

    await page.getByTestId('format-color').click();
    await page.waitForTimeout(50);

    await expect(page.locator('.color-picker-popover')).toBeVisible();
});

// Toolbar visibility tests

test('Format toolbar is always visible', async () => {
    await expect(page.locator('.format-toolbar')).toBeVisible();
});

test('Format toolbar contains bold, italic, underline, reset and color buttons', async () => {
    await expect(page.getByTestId('format-bold')).toBeVisible();
    await expect(page.getByTestId('format-italic')).toBeVisible();
    await expect(page.getByTestId('format-underline')).toBeVisible();
    await expect(page.getByTestId('format-reset')).toBeVisible();
    await expect(page.getByTestId('format-color')).toBeVisible();
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

    await input.press('Control+b');
    await page.waitForTimeout(50);
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

    await page.getByTestId('settings-button').click();
    await expect(page.getByTestId('settings-modal')).toBeVisible({ timeout: 5000 });

    const checkbox = page.getByTestId('enableFormatting-checkbox');
    await expect(checkbox).toBeChecked();

    await checkbox.uncheck();
    await page.getByTestId('settings-modal-close').click();
    await expect(page.getByTestId('settings-modal')).not.toBeVisible({ timeout: 5000 });

    // Reopen and verify it stayed unchecked
    await page.getByTestId('settings-button').click();
    await expect(page.getByTestId('settings-modal')).toBeVisible({ timeout: 5000 });
    await expect(checkbox).not.toBeChecked();
    await page.getByTestId('settings-modal-close').click();
});
