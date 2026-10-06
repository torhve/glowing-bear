import { test, expect } from '@playwright/test';
import { setSettings, reconnect } from '../helpers/connection';
import { waitForBuffer, switchToBuffer } from '../helpers/buffers';
import { expectInputFocused, rawInputValue, resetInputState, waitForInputCaret, waitForInputValue } from '../helpers/input';
import { createConnectedPage } from '../fixtures/auth';

let page: import('@playwright/test').Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
    page = await createConnectedPage(browser, {
        settings: { savepassword: false, autoconnect: false, enableEmojify: true, enableFormatting: true },
    });
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
});

test.afterAll(async () => {
    await page.close();
});

// The toolbar and the color picker are {#if}-rendered, so "closed" means the
// node is gone — toBeHidden() covers both detached and hidden.
const toolbar = () => page.locator('[role="toolbar"]');
const colorPicker = () => page.locator('.color-picker-popover');

// Bold button tests

test('Bold button inserts bold control char on click', async () => {
    const input = page.getByTestId('message-input');
    await input.focus();
    await expectInputFocused(page);
    await resetInputState(page);

    // Click toggle to show toolbar, then click bold button
    await page.getByTestId('format-toggle').click();
    await expect(toolbar()).toBeVisible();
    await page.getByTestId('format-bold').click();
    await waitForInputValue(page, /\u0002/);
    await expect(toolbar()).toBeHidden();
    // The app restores the caret past the char it inserted in a deferred task.
    // Typing before that lands splits the typed text around the caret restore.
    await waitForInputCaret(page, 1);
    await input.pressSequentially('bold text');
    await waitForInputValue(page, /\u0002bold text/);

    const value = await rawInputValue(page);
    expect(value).toContain('\u0002');
    expect(value).toContain('bold text');
    expect(value).not.toContain('\u000f');
});

// Bold shortcut test

test('Ctrl+B inserts bold control char via shortcut', async () => {
    const input = page.getByTestId('message-input');
    await input.focus();
    await expectInputFocused(page);
    await resetInputState(page);

    await page.keyboard.down('Control');
    await page.keyboard.press('b');
    await page.keyboard.up('Control');
    await waitForInputValue(page, /\u0002/);
    // The caret sits past the inserted char before the next keystroke is dispatched.
    await waitForInputCaret(page, 1);
    await input.pressSequentially('bold text');
    await waitForInputValue(page, /\u0002bold text/);

    const value = await rawInputValue(page);
    expect(value).toContain('\u0002');
    expect(value).toContain('bold text');
    expect(value).not.toContain('\u000f');
});

// Italic button tests

test('Italic button inserts italic control char on click', async () => {
    const input = page.getByTestId('message-input');
    await input.focus();
    await expectInputFocused(page);
    await resetInputState(page);

    await page.getByTestId('format-toggle').click();
    await expect(toolbar()).toBeVisible();
    await page.getByTestId('format-italic').click();
    await waitForInputValue(page, /\u001d/);
    await waitForInputCaret(page, 1);
    await input.pressSequentially('italic');
    await waitForInputValue(page, /\u001ditalic/);

    const value = await rawInputValue(page);
    expect(value).toContain('\u001d');
    expect(value).not.toContain('\u000f');
});

// Italic shortcut test

test('Ctrl+I inserts italic control char via shortcut', async () => {
    const input = page.getByTestId('message-input');
    await input.focus();
    await expectInputFocused(page);
    await resetInputState(page);

    await page.keyboard.down('Control');
    await page.keyboard.press('i');
    await page.keyboard.up('Control');
    await waitForInputValue(page, /\u001d/);
    await waitForInputCaret(page, 1);
    await input.pressSequentially('italic text');
    await waitForInputValue(page, /\u001ditalic text/);

    const value = await rawInputValue(page);
    expect(value).toContain('\u001d');
    expect(value).toContain('italic text');
    expect(value).not.toContain('\u000f');
});

// Underline button tests

test('Underline button inserts underline control char on click', async () => {
    const input = page.getByTestId('message-input');
    await input.focus();
    await expectInputFocused(page);
    await resetInputState(page);

    await page.getByTestId('format-toggle').click();
    await expect(toolbar()).toBeVisible();
    await page.getByTestId('format-underline').click();
    await waitForInputValue(page, /\u001f/);
    await waitForInputCaret(page, 1);
    await input.pressSequentially('under');
    await waitForInputValue(page, /\u001funder/);

    const value = await rawInputValue(page);
    expect(value).toContain('\u001f');
    expect(value).not.toContain('\u000f');
});

// Underline shortcut tests

test('Ctrl+_ inserts underline control char via shortcut', async () => {
    const input = page.getByTestId('message-input');
    await input.focus();
    await expectInputFocused(page);
    await resetInputState(page);

    // Ctrl+_ is produced by Ctrl+Shift+- on US keyboards
    await page.keyboard.down('Control');
    await page.keyboard.down('Shift');
    await page.keyboard.press('-');
    await page.keyboard.up('Shift');
    await page.keyboard.up('Control');
    await waitForInputValue(page, /\u001f/);
    await waitForInputCaret(page, 1);
    await input.pressSequentially('underlined text');
    await waitForInputValue(page, /\u001funderlined text/);

    const value = await rawInputValue(page);
    expect(value).toContain('\u001f');
    expect(value).toContain('underlined text');
    expect(value).not.toContain('\u000f');
});

// Reset button tests

test('Reset button inserts reset code', async () => {
    const input = page.getByTestId('message-input');
    await input.focus();
    await expectInputFocused(page);
    await resetInputState(page);

    // Insert bold via button: toggle -> click bold -> toolbar hides
    await page.getByTestId('format-toggle').click();
    await expect(toolbar()).toBeVisible();
    await page.getByTestId('format-bold').click();
    await waitForInputValue(page, /\u0002/);
    await waitForInputCaret(page, 1);
    await input.pressSequentially('bold and reset');
    await waitForInputValue(page, /\u0002bold and reset/);

    // Toggle again to show toolbar, then click reset
    await page.getByTestId('format-toggle').click();
    await expect(toolbar()).toBeVisible();
    await page.getByTestId('format-reset').click();
    // Position is deliberately not asserted. Clicking a toolbar button blurs the
    // textarea and the app restores a stale caret, so the reset code lands mid-text
    // rather than at the end of what was typed — a product bug recorded under
    // Discovered Tasks in plan-e2e-real-waits.md. Asserting the position here would
    // lock that bug in as expected behavior.
    await waitForInputValue(page, /\u000f/);

    const value = await rawInputValue(page);
    expect(value).toContain('\u0002');
    expect(value).toContain('\u000f');
});

// Color picker tests

test('Ctrl+K opens color picker', async () => {
    const input = page.getByTestId('message-input');
    await input.focus();
    await expectInputFocused(page);
    await resetInputState(page);

    // Color picker should be hidden initially
    await expect(colorPicker()).toBeHidden();

    // Open via Ctrl+K shortcut
    await page.keyboard.down('Control');
    await page.keyboard.press('k');
    await page.keyboard.up('Control');
    await expect(colorPicker()).toBeVisible();

    // Should have 16 color swatches
    const swatches = page.locator('[data-testid^="color-"]');
    await expect(swatches).toHaveCount(16);

    // Close the picker for subsequent tests by clicking outside the input bar. The
    // outside handler is keyed on pointerdown and installed as soon as the picker
    // opens, so the next press outside the bar closes it.
    await page.getByTestId('chat-view').click();
    await expect(colorPicker()).toBeHidden();
});

test('Color button opens color picker on click', async () => {
    const input = page.getByTestId('message-input');
    await input.focus();
    await expectInputFocused(page);
    await resetInputState(page);

    // Click toggle to show toolbar, then click color button
    await page.getByTestId('format-toggle').click();
    await expect(toolbar()).toBeVisible();
    await page.getByTestId('format-color').click();
    await expect(colorPicker()).toBeVisible();

    // Toolbar should be hidden after clicking color button
    await expect(toolbar()).toBeHidden();

    // Close the picker for subsequent tests (see the note above on outside clicks).
    await page.getByTestId('chat-view').click();
    await expect(colorPicker()).toBeHidden();
});

test('Clicking a color inserts IRC color code (no reset)', async () => {
    const input = page.getByTestId('message-input');
    await input.focus();
    await expectInputFocused(page);
    await resetInputState(page);

    // Open color picker via Ctrl+K shortcut
    await page.keyboard.down('Control');
    await page.keyboard.press('k');
    await page.keyboard.up('Control');
    await expect(colorPicker()).toBeVisible();

    // Click red color (code 04)
    await page.getByTestId('color-04').click();
    await waitForInputValue(page, /\u000304/);

    const value = await rawInputValue(page);
    expect(value).toContain('\u000304');
    // Should NOT contain reset code
    expect(value).not.toContain('\u000f');

    // Color picker should be closed after selection
    await expect(colorPicker()).toBeHidden();
});

// Toolbar visibility tests

test('Format toolbar is hidden by default', async () => {
    await resetInputState(page);
    await expect(toolbar()).toBeHidden();
});

test('Toggle button click shows format toolbar', async () => {
    await resetInputState(page);

    await page.getByTestId('format-toggle').click();
    await expect(toolbar()).toBeVisible();
    await expect(page.getByTestId('format-bold')).toBeVisible();
    await expect(page.getByTestId('format-italic')).toBeVisible();
    await expect(page.getByTestId('format-underline')).toBeVisible();
    await expect(page.getByTestId('format-reset')).toBeVisible();
    await expect(page.getByTestId('format-color')).toBeVisible();

    // Click toggle again to hide it for subsequent tests
    await page.getByTestId('format-toggle').click();
    await expect(toolbar()).toBeHidden();
});

test('Toggle button click toggles visibility', async () => {
    await resetInputState(page);

    // First click -> show
    await page.getByTestId('format-toggle').click();
    await expect(toolbar()).toBeVisible();

    // Second click -> hide
    await page.getByTestId('format-toggle').click();
    await expect(toolbar()).toBeHidden();
});

test('Format button click hides toolbar', async () => {
    const input = page.getByTestId('message-input');
    await input.focus();
    await expectInputFocused(page);
    await resetInputState(page);

    // Show toolbar via toggle
    await page.getByTestId('format-toggle').click();
    await expect(toolbar()).toBeVisible();

    // Click bold -> toolbar hides
    await page.getByTestId('format-bold').click();
    await expect(toolbar()).toBeHidden();
});

// Settings toggle test

test('Formatting disabled when setting is off', async () => {
    await setSettings(page, { enableFormatting: false });
    await reconnect(page);
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');

    const input = page.getByTestId('message-input');
    await input.focus();
    await expectInputFocused(page);
    await resetInputState(page);

    // Format toggle button should not be visible when formatting is disabled
    await expect(page.getByTestId('format-toggle')).toBeHidden();

    await input.pressSequentially('should not be bold');
    await waitForInputValue(page, 'should not be bold');

    const value = await rawInputValue(page);
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
    await expect(page.getByTestId('settings-modal')).toBeHidden({ timeout: 5000 });

    // Reopen and verify it stayed unchecked
    await page.getByTestId('settings-button').click({ force: true });
    await expect(page.getByTestId('settings-modal')).toBeVisible({ timeout: 5000 });
    await expect(checkbox).not.toBeChecked();
    await page.getByTestId('settings-modal-close').click({ force: true });
});
