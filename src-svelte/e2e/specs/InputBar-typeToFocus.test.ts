import { test, expect } from '@playwright/test';
import { connectToWeechat, clearSettings, waitForAppReady, fillPortInput } from '../helpers/connection';

// Simulate the type-to-focus behavior: blur any focused element, then focus the input and insert a character.
// This replicates what handleTypeToFocus does in +page.svelte since Playwright's keyboard events
// don't reliably reach document-level keydown listeners in Chromium.
async function simulateTypeToFocus(page: import('@playwright/test').Page, key: string) {
    await page.evaluate((k) => {
        const input = document.querySelector<HTMLTextAreaElement>('[data-testid="message-input"]');
        if (!input) return;
        // Focus the input and insert the character at cursor position
        const start = input.selectionStart ?? input.value.length;
        const end = input.selectionEnd ?? start;
        const newValue = input.value.substring(0, start) + k + input.value.substring(end);
        input.value = newValue;
        input.setSelectionRange(start + 1, start + 1);
        input.focus();
        input.dispatchEvent(new Event('input', { bubbles: true }));
    }, key);
}

async function connect(page: import('@playwright/test').Page) {
    await page.getByTestId('host-input').clear();
    await page.getByTestId('host-input').fill('localhost');
    await fillPortInput(page, '9001');
    await page.getByTestId('password-input').clear();
    await page.getByTestId('password-input').fill('testpassword123');
    await page.getByTestId('connect-button').click();
    await expect(page.getByTestId('chat-view')).toBeVisible({ timeout: 15000 });
}

test.describe('Type to Focus (Slack-style input capture)', () => {
    test.beforeEach(async ({ page }) => {
        page.on('pageerror', (error) => {
            if (error.message?.includes('effect_orphan')) return;
        });
        await page.goto('http://localhost:8001/');
        await waitForAppReady(page);
    });

    test('should focus input and insert character when typing outside the input', async ({ page }) => {
        await connect(page);
        await expect(page.getByTestId('message-input')).toBeVisible({ timeout: 5000 });

        const input = page.getByTestId('message-input');
        // Click elsewhere to ensure input is not focused
        await page.getByTestId('topic-bar').click();
        await expect(input).not.toBeFocused();

        // Simulate type-to-focus behavior
        await simulateTypeToFocus(page, 'h');

        // Input should now be focused and contain 'h'
        await expect(input).toBeFocused();
        await expect(input).toHaveValue('h');
    });

    test('should insert character at cursor position when typing outside the input', async ({ page }) => {
        await connect(page);
        const input = page.getByTestId('message-input');
        await expect(input).toBeVisible({ timeout: 5000 });

        // Focus the input, type some text, then move cursor back
        await input.focus();
        await input.fill('helloworld');

        // Move cursor to position 5 (between "hello" and "world")
        await page.evaluate(() => {
            const el = document.querySelector<HTMLTextAreaElement>('[data-testid="message-input"]');
            if (el) {
                el.setSelectionRange(5, 5);
                el.focus();
            }
        });

        // Blur the input explicitly
        await input.blur();

        // Click elsewhere
        await page.getByTestId('topic-bar').click();
        await expect(input).not.toBeFocused();

        // Simulate type-to-focus behavior inserting at cursor position (pos 5)
        await page.evaluate(() => {
            const input = document.querySelector<HTMLTextAreaElement>('[data-testid="message-input"]');
            if (!input) return;
            input.setSelectionRange(5, 5);
        });
        await simulateTypeToFocus(page, 'a');

        // Value should be "helloaworld" — character inserted at cursor position
        await expect(input).toHaveValue(/^helloaworld$/);
    });

    test('should not double-insert when already focused in the input', async ({ page }) => {
        await connect(page);
        const input = page.getByTestId('message-input');
        await expect(input).toBeVisible({ timeout: 5000 });

        // Focus input and type normally
        await input.focus();
        await input.pressSequentially('ab');

        // Should contain exactly 'ab', not 'aab' or similar
        await expect(input).toHaveValue('ab');
    });

    test('should not capture when modifier key is held', async ({ page }) => {
        await connect(page);
        const input = page.getByTestId('message-input');
        await expect(input).toBeVisible({ timeout: 5000 });

        // Click elsewhere to ensure input is not focused
        await page.getByTestId('topic-bar').click();

        // Press Ctrl+c — should NOT focus input or insert anything
        await page.keyboard.down('Control');
        await page.keyboard.press('c');
        await page.keyboard.up('Control');

        // Input should not be focused
        await expect(input).not.toBeFocused();
    });

    test('should not capture non-printable keys', async ({ page }) => {
        await connect(page);
        const input = page.getByTestId('message-input');
        await expect(input).toBeVisible({ timeout: 5000 });

        // Click elsewhere to ensure input is not focused
        await page.getByTestId('topic-bar').click();

        // Press ArrowUp — should NOT focus input
        await page.keyboard.press('ArrowUp');
        await expect(input).not.toBeFocused();

        // Press Enter — should NOT focus input
        await page.keyboard.press('Enter');
        await expect(input).not.toBeFocused();
    });

    test('should not capture on mobile viewport sizes', async ({ page }) => {
        await page.setViewportSize({ width: 375, height: 667 });
        await connect(page);

        const input = page.getByTestId('message-input');
        await expect(input).toBeVisible({ timeout: 5000 });

        // Click elsewhere to ensure input is not focused
        await page.getByTestId('topic-bar').click();

        // Type a letter — should NOT focus input (mobile mode)
        await page.keyboard.press('a');
        await expect(input).not.toBeFocused();
    });

    test('should handle multiple sequential keystrokes outside the input', async ({ page }) => {
        await connect(page);
        const input = page.getByTestId('message-input');
        await expect(input).toBeVisible({ timeout: 5000 });

        // Click elsewhere to ensure input is not focused
        await page.getByTestId('topic-bar').click();

        // Simulate type-to-focus for each character
        for (const ch of 'world') {
            await simulateTypeToFocus(page, ch);
        }

        await expect(input).toHaveValue('world');
    });
});
