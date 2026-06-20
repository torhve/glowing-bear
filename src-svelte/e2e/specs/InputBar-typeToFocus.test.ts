import { test, expect } from '@playwright/test';
import { connectToWeechat, clearSettings, waitForAppReady } from '../helpers/connection';

async function connect(page: import('@playwright/test').Page) {
    await page.getByTestId('host-input').clear();
    await page.getByTestId('host-input').fill('localhost');
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

        // Click somewhere else to ensure input is not focused
        await page.getByTestId('topic-bar').click();
        const input = page.getByTestId('message-input');
        await expect(input).not.toBeFocused();

        // Type a letter outside the input
        await page.keyboard.press('h');
        await page.waitForTimeout(100);

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
        await page.waitForTimeout(100);

        // Move cursor to position 5 (between "hello" and "world")
        await page.evaluate(() => {
            const el = document.querySelector<HTMLTextAreaElement>('[data-testid="message-input"]');
            if (el) {
                el.setSelectionRange(5, 5);
                el.focus();
            }
        });

        // Blur the input by clicking elsewhere
        await page.getByTestId('topic-bar').click();
        await expect(input).not.toBeFocused();

        // Type a letter outside — should insert at cursor position (pos 5)
        await page.keyboard.press('a');
        await page.waitForTimeout(100);

        // Value should be "helloaworld" — character inserted at cursor position
        const value = await input.inputValue();
        expect(value.length).toBe(11); // original length + 1 inserted char
        expect(value.substring(0, 5)).toBe('hello');
        expect(value.substring(6)).toBe('world');
    });

    test('should not double-insert when already focused in the input', async ({ page }) => {
        await connect(page);
        const input = page.getByTestId('message-input');
        await expect(input).toBeVisible({ timeout: 5000 });

        // Focus input and type normally
        await input.focus();
        await input.pressSequentially('ab');
        await page.waitForTimeout(100);

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
        await page.waitForTimeout(100);

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
        await page.waitForTimeout(100);

        await expect(input).not.toBeFocused();

        // Press Enter — should NOT focus input
        await page.keyboard.press('Enter');
        await page.waitForTimeout(100);

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
        await page.waitForTimeout(100);

        await expect(input).not.toBeFocused();
    });

    test('should handle multiple sequential keystrokes outside the input', async ({ page }) => {
        await connect(page);
        const input = page.getByTestId('message-input');
        await expect(input).toBeVisible({ timeout: 5000 });

        // Click elsewhere to ensure input is not focused
        await page.getByTestId('topic-bar').click();

        // Type multiple characters one by one
        await page.keyboard.press('w');
        await page.waitForTimeout(50);
        await page.keyboard.press('o');
        await page.waitForTimeout(50);
        await page.keyboard.press('r');
        await page.waitForTimeout(50);
        await page.keyboard.press('l');
        await page.waitForTimeout(50);
        await page.keyboard.press('d');
        await page.waitForTimeout(100);

        await expect(input).toHaveValue('world');
    });
});
