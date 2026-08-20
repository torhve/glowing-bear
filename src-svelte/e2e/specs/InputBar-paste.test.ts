import { test, expect } from '@playwright/test';
import { waitForBuffer, switchToBuffer } from '../helpers/buffers';
import { createConnectedPage } from '../fixtures/auth';

let page: import('@playwright/test').Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
    page = await createConnectedPage(browser, {
        settings: { savepassword: false, autoconnect: false, enableEmojify: false },
    });
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
});

test.afterAll(async () => {
    await page.close();
});

// Helper: read the raw DOM value of the textarea
async function getRawInputValue(): Promise<string> {
    return page.evaluate(() => {
        const el = document.querySelector('[data-testid="message-input"]') as HTMLTextAreaElement;
        return el?.value ?? '';
    });
}

// Helper: clear both Svelte state and DOM to reset input between tests
async function clearInputState(): Promise<void> {
    await page.evaluate(() => {
        const reset = (window as typeof window & { __resetFormattingState?: () => void }).__resetFormattingState;
        if (typeof reset === 'function') {
            reset();
        }
    });
    await page.waitForTimeout(50);
}

// Helper: dispatch a paste event on the textarea with plain text data.
// Creates a DataTransfer with text/plain and a ClipboardEvent, then dispatches it.
async function simulatePaste(pastedText: string) {
    await page.evaluate((text) => {
        const textarea = document.querySelector('[data-testid="message-input"]') as HTMLTextAreaElement;
        if (!textarea) return;

        const dt = new DataTransfer();
        dt.setData('text/plain', text);

        const event = new ClipboardEvent('paste', { clipboardData: dt });
        textarea.dispatchEvent(event);
    }, pastedText);
    // Wait for async paste handler to complete (insertAtCursor uses setTimeout)
    await page.waitForTimeout(100);
}

// Helper: dispatch a paste event on the document (not the textarea).
// Tests the global paste handler that catches paste when focus is elsewhere.
async function simulateGlobalPaste(pastedText: string) {
    await page.evaluate((text) => {
        const dt = new DataTransfer();
        dt.setData('text/plain', text);

        const event = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true });
        document.dispatchEvent(event);
    }, pastedText);
    // Wait for async paste handler to complete (insertAtCursor uses setTimeout)
    await page.waitForTimeout(100);
}

test.beforeEach(async () => {
    await clearInputState();
});

test('pasting a plain URL inserts it into the input bar', async () => {
    const input = page.getByTestId('message-input');
    await input.focus();
    await page.waitForTimeout(50);

    await simulatePaste('https://example.com/test-link');

    const value = await getRawInputValue();
    expect(value).toBe('https://example.com/test-link');
});

test('pasting text at cursor position inserts mid-content', async () => {
    const input = page.getByTestId('message-input');
    await input.focus();
    await page.waitForTimeout(50);

    // Type "Hello " naturally so focus state stays consistent
    await input.pressSequentially('Hello ');
    await page.waitForTimeout(50);

    // Paste new text — cursor should be at end of "Hello " (position 6)
    await simulatePaste('[pasted]');

    // Then type "world" after the pasted text
    await input.pressSequentially('world');
    await page.waitForTimeout(50);

    const value = await getRawInputValue();
    expect(value).toBe('Hello [pasted]world');
});

test('pasting multi-line text under the threshold preserves newlines', async () => {
    const input = page.getByTestId('message-input');
    await input.focus();
    await page.waitForTimeout(50);

    // 2 lines is below the 3-line threshold — inserted as-is, no confirmation dialog
    await simulatePaste('line1\nline2');

    const value = await getRawInputValue();
    expect(value).toBe('line1\nline2');
    await expectMultiLineDialogVisible(false);
});

test('pasting when focus is NOT on input bar still inserts text', async () => {
    // Click on the chat view to move focus away from the textarea
    await page.getByTestId('chat-view').click();
    await page.waitForTimeout(100);

    // Verify the textarea is NOT focused
    await page.evaluate(() => {
        const el = document.querySelector('[data-testid="message-input"]') as HTMLTextAreaElement;
        if (document.activeElement === el) {
            throw new Error('textarea should not be focused');
        }
    });

    // Paste via global handler (dispatched on document, not textarea)
    await simulateGlobalPaste('https://example.com/global-paste');

    // Textarea should now have the pasted content
    const value = await getRawInputValue();
    expect(value).toBe('https://example.com/global-paste');

    // And the textarea should now be focused
    await page.evaluate(() => {
        const el = document.querySelector('[data-testid="message-input"]') as HTMLTextAreaElement;
        if (document.activeElement !== el) {
            throw new Error('textarea should be focused after paste');
        }
    });
});

test('pasting empty text does nothing', async () => {
    const input = page.getByTestId('message-input');
    await input.focus();
    await page.waitForTimeout(50);

    // Type some text naturally
    await input.pressSequentially('original');
    await page.waitForTimeout(50);

    await simulatePaste('');

    const value = await getRawInputValue();
    expect(value).toBe('original');
});

// Helper: wait until the multi-line paste dialog is in the given visibility state
async function expectMultiLineDialogVisible(visible: boolean) {
    await page.waitForFunction((v) => {
        const el = document.querySelector('[data-testid="multiline-paste-dialog"]') as HTMLDialogElement | null;
        if (!el) return v === false;
        const isShown = getComputedStyle(el).display !== 'none';
        return isShown === v;
    }, visible, { timeout: 5000 });
}

test('pasting 3+ lines shows the confirmation dialog; Join merges into one message', async () => {
    const input = page.getByTestId('message-input');
    await input.focus();
    await page.waitForTimeout(50);

    await simulatePaste('line1\nline2\nline3');

    await expectMultiLineDialogVisible(true);
    await page.getByTestId('multiline-paste-join').click();

    const value = await getRawInputValue();
    expect(value).toBe('line1 line2 line3');
    await expectMultiLineDialogVisible(false);
});

test('pasting 3+ lines with "Paste each line separately" inserts text as-is', async () => {
    const input = page.getByTestId('message-input');
    await input.focus();
    await page.waitForTimeout(50);

    await simulatePaste('line1\nline2\nline3');

    await expectMultiLineDialogVisible(true);
    await page.getByTestId('multiline-paste-separate').click();

    const value = await getRawInputValue();
    expect(value).toBe('line1\nline2\nline3');
    await expectMultiLineDialogVisible(false);
});

test('pasting 3+ lines and clicking Cancel leaves the input unchanged', async () => {
    const input = page.getByTestId('message-input');
    await input.focus();
    await page.waitForTimeout(50);

    // Type some text naturally so we can verify it is left untouched
    await input.pressSequentially('keep ');
    await page.waitForTimeout(50);

    await simulatePaste('line1\nline2\nline3');

    await expectMultiLineDialogVisible(true);
    await page.getByTestId('multiline-paste-cancel').click();

    const value = await getRawInputValue();
    expect(value).toBe('keep ');
    await expectMultiLineDialogVisible(false);
});

test('pasting 3+ lines and pressing Enter uses the default action (paste separately)', async () => {
    const input = page.getByTestId('message-input');
    await input.focus();
    await page.waitForTimeout(50);

    await simulatePaste('line1\nline2\nline3');

    await expectMultiLineDialogVisible(true);

    // The default action (Paste each line separately) has initial focus, so Enter confirms it
    await page.keyboard.press('Enter');
    await page.waitForTimeout(100);

    const value = await getRawInputValue();
    expect(value).toBe('line1\nline2\nline3');
    await expectMultiLineDialogVisible(false);
});

test('pasting 3+ lines while unfocused shows the dialog (global paste handler)', async () => {
    // Click on the chat view to move focus away from the textarea
    await page.getByTestId('chat-view').click();
    await page.waitForTimeout(100);

    await simulateGlobalPaste('l1\nl2\nl3');

    await expectMultiLineDialogVisible(true);
    await page.getByTestId('multiline-paste-join').click();

    const value = await getRawInputValue();
    expect(value).toBe('l1 l2 l3');
    await expectMultiLineDialogVisible(false);

    // And the textarea should now be focused
    await page.evaluate(() => {
        const el = document.querySelector('[data-testid="message-input"]') as HTMLTextAreaElement;
        if (document.activeElement !== el) {
            throw new Error('textarea should be focused after paste');
        }
    });
});
