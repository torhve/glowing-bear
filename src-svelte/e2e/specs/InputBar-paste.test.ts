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

test('pasting multi-line text preserves newlines', async () => {
    const input = page.getByTestId('message-input');
    await input.focus();
    await page.waitForTimeout(50);

    await simulatePaste('line1\nline2\nline3');

    const value = await getRawInputValue();
    expect(value).toBe('line1\nline2\nline3');
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
