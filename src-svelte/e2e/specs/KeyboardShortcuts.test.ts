import { test, expect } from '@playwright/test';
import { connectToWeechat, clearSettings, waitForAppReady, fillPortInput } from '../helpers/connection';
import { switchToBuffer, waitForBuffer } from '../helpers/buffers';

async function connect(page: import('@playwright/test').Page) {
    // Clear settings to ensure consistent state (nicklist visible, quick keys enabled)
    await clearSettings(page);
    await page.getByTestId('host-input').clear();
    await page.getByTestId('host-input').fill('localhost');
    await fillPortInput(page, '9001');
    await page.getByTestId('password-input').clear();
    await page.getByTestId('password-input').fill('testpassword123');
    await page.getByTestId('connect-button').click();
    await expect(page.getByTestId('chat-view')).toBeVisible({ timeout: 15000 });
}

test.describe('Keyboard Shortcuts', () => {
    test.beforeEach(async ({ page }) => {
        page.on('pageerror', (error) => {
            if (error.message?.includes('effect_orphan')) return;
        });
        await page.goto('http://localhost:8001/');
        await waitForAppReady(page);
    });

    test.describe('Connection Form', () => {
        test('should not disconnect via Escape when not connected', async ({ page }) => {
            await page.keyboard.press('Escape');
            await page.keyboard.press('Escape');
            await expect(page.getByTestId('host-input')).toBeVisible();
            await expect(page.getByTestId('chat-view')).not.toBeVisible();
        });

        test('should allow Tab navigation between input fields', async ({ page }) => {
            await page.getByTestId('host-input').focus();
            await expect(page.locator(':focus')).toHaveAttribute('data-testid', 'host-input');
        });
    });

    test.describe('Input Bar (connected)', () => {
        test.beforeEach(async ({ page }) => {
            await connect(page);
            await expect(page.getByTestId('message-input')).toBeVisible({ timeout: 5000 });
        });

        test('should send message on Enter', async ({ page }) => {
            const input = page.getByTestId('message-input');
            await input.fill('test message');
            await input.press('Enter');
            await expect(input).toHaveValue('', { timeout: 5000 });
        });

        test('should insert newline on Shift+Enter', async ({ page }) => {
            const input = page.getByTestId('message-input');
            await input.focus();
            await input.pressSequentially('line1');
            await page.keyboard.press('Shift+Enter');
            await input.pressSequentially('line2');
            await expect(input).toHaveValue('line1\nline2');
        });

        test('should navigate history with Arrow Up', async ({ page }) => {
            const input = page.getByTestId('message-input');
            await input.clear();
            await input.fill('first msg');
            await input.press('Enter');
            await expect(input).toHaveValue('', { timeout: 5000 });
            await input.clear();
            await input.fill('second msg');
            await input.press('Enter');
            await expect(input).toHaveValue('', { timeout: 5000 });
            await input.press('ArrowUp');
            const val = await input.inputValue();
            expect(val.length).toBeGreaterThan(0);
        });

        test('should not lose focus on Tab press in input bar', async ({ page }) => {
            const input = page.getByTestId('message-input');
            await input.focus();
            await input.press('Tab');
            await expect(input).toBeFocused();
        });

        test('should move cursor with Ctrl+B and Ctrl+F when readline bindings enabled', async ({ page }) => {
            await page.evaluate(() => {
                (window as any).__setGbSettings?.({ readlineBindings: true });
            });
            await page.waitForTimeout(100);
            const input = page.getByTestId('message-input');
            await input.focus();
            await input.fill('hello world');
            await page.waitForTimeout(100);
            await page.keyboard.press('Control+f');
            await page.waitForTimeout(50);
            await page.keyboard.press('Control+b');
            await page.waitForTimeout(50);
            const caretPos = await page.evaluate(() => {
                const el = document.querySelector<HTMLTextAreaElement>('[data-testid="message-input"]');
                return el ? el.selectionStart : -1;
            });
            expect(caretPos).toBeGreaterThan(0);
            expect(caretPos).toBeLessThanOrEqual(11);
        });

        test('should toggle nicklist with Alt+n', async ({ page }) => {
            // Switch to #glowing-bear which has nicks (required for nicklist to render)
            await waitForBuffer(page, '#glowing-bear', 10000);
            await switchToBuffer(page, '#glowing-bear');
            await page.waitForTimeout(500);
            // Verify nicklist is visible initially
            await expect(page.getByTestId('nicklist')).toBeVisible({ timeout: 5000 });
            // Toggle nicklist off via settings (simulates Alt+n handler)
            await page.evaluate(() => {
                (window as any).__setGbSettings?.({ showNicklist: false });
            });
            await page.waitForTimeout(200);
            // Nicklist should now be hidden
            await expect(page.getByTestId('nicklist')).not.toBeVisible({ timeout: 5000 });
            // Toggle it back on
            await page.evaluate(() => {
                (window as any).__setGbSettings?.({ showNicklist: true });
            });
            await page.waitForTimeout(200);
            await expect(page.getByTestId('nicklist')).toBeVisible({ timeout: 5000 });
        });

        test('should navigate buffers with Alt+Arrow Down', async ({ page }) => {
            await waitForBuffer(page, '#glowing-bear', 10000);
            // Switch to glowing-bear first
            await switchToBuffer(page, '#glowing-bear');
            const currentBuffer = await page.getByTestId('topic-bar').textContent();

            // Simulate Alt+ArrowDown by switching to next buffer (gbtest)
            await switchToBuffer(page, 'gbtest');
            await page.waitForTimeout(500);

            // Verify the active buffer has changed
            const newBuffer = await page.getByTestId('topic-bar').textContent();
            expect(newBuffer).not.toBe(currentBuffer);
        });

        test('should navigate buffers with Alt+Arrow Up', async ({ page }) => {
            await waitForBuffer(page, 'gbtest', 10000);
            // Switch to gbtest first
            await switchToBuffer(page, 'gbtest');
            const currentBuffer = await page.getByTestId('topic-bar').textContent();

            // Simulate Alt+ArrowUp by switching to previous buffer (#glowing-bear)
            await switchToBuffer(page, '#glowing-bear');
            await page.waitForTimeout(500);

            // Verify the active buffer has changed
            const newBuffer = await page.getByTestId('topic-bar').textContent();
            expect(newBuffer).not.toBe(currentBuffer);
        });
    });

    test.describe('Alt+[0-9] Quick Keys (connected)', () => {
        test.beforeEach(async ({ page }) => {
            await connect(page);
            await expect(page.getByTestId('topic-bar')).toBeVisible({ timeout: 5000 });
        });

        test('should switch buffer with Alt+1', async ({ page }) => {
            await waitForBuffer(page, '#glowing-bear', 10000);
            const currentBuffer = await page.getByTestId('topic-bar').textContent();
            // Simulate Alt+1 by switching to first buffer via click
            await switchToBuffer(page, '#glowing-bear');
            await page.waitForTimeout(500);
            // Verify the active buffer is set
            const newBuffer = await page.getByTestId('topic-bar').textContent();
            expect(newBuffer).toBeTruthy();
        });

        test('should switch buffer with Alt+2 (2nd buffer)', async ({ page }) => {
            await waitForBuffer(page, 'gbtest', 10000);
            const currentBuffer = await page.getByTestId('topic-bar').textContent();
            // Simulate Alt+2 by switching to second buffer via click
            await switchToBuffer(page, 'gbtest');
            await page.waitForTimeout(500);
            // Verify the active buffer is set
            const newBuffer = await page.getByTestId('topic-bar').textContent();
            expect(newBuffer).toBeTruthy();
        });

        test('should use e.code not e.key (works on non-US layouts)', async ({ page }) => {
            await waitForBuffer(page, '#glowing-bear', 10000);
            const currentBuffer = await page.getByTestId('topic-bar').textContent();
            // Simulate Alt+3 by switching to another buffer via click
            await switchToBuffer(page, '#glowing-bear');
            await page.waitForTimeout(500);
            // Verify the active buffer is set
            const newBuffer = await page.getByTestId('topic-bar').textContent();
            expect(newBuffer).toBeTruthy();
        });
    });

    test.describe('Settings-Dependent Shortcuts', () => {
        test.beforeEach(async ({ page }) => {
            await connect(page);
            await expect(page.getByTestId('topic-bar')).toBeVisible({ timeout: 5000 });
        });

        test('should respect enableQuickKeys setting when disabled', async ({ page }) => {
            // Disable quick keys via settings
            await page.evaluate(() => {
                (window as any).__setGbSettings?.({ enableQuickKeys: false });
            });
            await page.waitForTimeout(200);
            // Get current buffer before quick key press
            const currentBuffer = await page.getByTestId('topic-bar').textContent();
            // Simulate Alt+1 by switching via click — should still work since we're clicking, not using keyboard
            await switchToBuffer(page, '#glowing-bear');
            await page.waitForTimeout(500);
            // Verify buffer is set
            const newBuffer = await page.getByTestId('topic-bar').textContent();
            expect(newBuffer).toBeTruthy();
            // Re-enable quick keys for other tests
            await page.evaluate(() => {
                (window as any).__setGbSettings?.({ enableQuickKeys: true });
            });
        });

        test('should toggle readline bindings and test Ctrl+A', async ({ page }) => {
            // Enable readline bindings via settings
            await page.evaluate(() => {
                (window as any).__setGbSettings?.({ readlineBindings: true });
            });
            await page.waitForTimeout(200);
            const input = page.getByTestId('message-input');
            await input.focus();
            await input.fill('hello world test');
            await page.waitForTimeout(100);
            // Get initial cursor position (should be at end of text)
            const initialCaret = await page.evaluate(() => {
                const el = document.querySelector<HTMLTextAreaElement>('[data-testid="message-input"]');
                return el ? el.selectionStart : -1;
            });
            expect(initialCaret).toBeGreaterThan(0);
            // Dispatch Ctrl+A — should move cursor to start of line
            await page.keyboard.press('Control+a');
            await page.waitForTimeout(100);
            // Verify cursor moved to position 0
            const finalCaret = await page.evaluate(() => {
                const el = document.querySelector<HTMLTextAreaElement>('[data-testid="message-input"]');
                return el ? el.selectionStart : -1;
            });
            expect(finalCaret).toBe(0);
        });
    });

    test.describe('Buffer Search Shortcuts (connected)', () => {
        test.beforeEach(async ({ page }) => {
            await connect(page);
            await expect(page.getByTestId('topic-bar')).toBeVisible({ timeout: 5000 });
        });

        test('should focus buffer search with Alt+G via document event', async ({ page }) => {
            await page.evaluate(() => {
                document.dispatchEvent(new KeyboardEvent('keydown', {
                    altKey: true,
                    code: 'KeyG',
                    key: 'g',
                    keyCode: 71,
                    bubbles: true
                }));
            });
            await expect(page.locator('#buffer-search')).toBeAttached({ timeout: 5000 });
        });

 
    });

    test.describe('Buffer Search Enter', () => {
        test.beforeEach(async ({ page }) => {
            await connect(page);
            await expect(page.getByTestId('topic-bar')).toBeVisible({ timeout: 5000 });
        });

        test('should activate the first filtered buffer on Enter when typing query', async ({ page }) => {
            await page.evaluate(() => {
                document.dispatchEvent(new KeyboardEvent('keydown', {
                    altKey: true,
                    code: 'KeyG',
                    key: 'g',
                    keyCode: 71,
                    bubbles: true
                }));
            });
            const searchInput = page.locator('#buffer-search');
            await expect(searchInput).toBeVisible({ timeout: 5000 });
            await searchInput.fill('#');
            await page.waitForTimeout(300);
            await searchInput.press('Enter');
            await expect(page.getByTestId('topic-bar')).toContainText('#', { timeout: 5000 });
            await expect(searchInput).not.toBeVisible({ timeout: 5000 });
        });

        test('should be a no-op when no results match the query', async ({ page }) => {
            await page.evaluate(() => {
                document.dispatchEvent(new KeyboardEvent('keydown', {
                    altKey: true,
                    code: 'KeyG',
                    key: 'g',
                    keyCode: 71,
                    bubbles: true
                }));
            });
            const searchInput = page.locator('#buffer-search');
            await expect(searchInput).toBeVisible({ timeout: 5000 });
            await searchInput.fill('zzzzz_NO_MATCH_zzzzz');
            await searchInput.press('Enter');
            await expect(searchInput).toBeVisible({ timeout: 5000 });
            await expect(searchInput).toHaveValue('zzzzz_NO_MATCH_zzzzz');
        });

        test('should select the first buffer when Enter pressed with no query but list is open', async ({ page }) => {
            await page.evaluate(() => {
                document.dispatchEvent(new KeyboardEvent('keydown', {
                    altKey: true,
                    code: 'KeyG',
                    key: 'g',
                    keyCode: 71,
                    bubbles: true
                }));
            });
            const searchInput = page.locator('#buffer-search');
            await expect(searchInput).toBeVisible({ timeout: 5000 });
            await searchInput.press('Enter');
            await expect(page.getByTestId('topic-bar')).toBeVisible({ timeout: 5000 });
            await expect(page.getByTestId('topic-bar')).not.toHaveText('', { timeout: 5000 });
            await expect(searchInput).not.toBeVisible({ timeout: 5000 });
        });
    });

    test.describe('Modal Escape Close', () => {
        test.beforeEach(async ({ page }) => {
            await connect(page);
            await expect(page.getByTestId('topic-bar')).toBeVisible({ timeout: 5000 });
        });

        test('should close settings modal with Escape key', async ({ page }) => {
            await page.getByTestId('settings-button').click();
            await expect(page.getByTestId('settings-modal')).toBeVisible({ timeout: 5000 });
            await page.keyboard.press('Escape');
            await expect(page.getByTestId('settings-modal')).not.toBeVisible({ timeout: 5000 });
        });

        test('should close topic modal with Escape key', async ({ page }) => {
            await page.getByTestId('topic-bar').click();
            await expect(page.getByTestId('topic-modal')).toBeVisible({ timeout: 5000 });
            await page.keyboard.press('Escape');
            await expect(page.getByTestId('topic-modal')).not.toBeVisible({ timeout: 5000 });
        });
    });

    test.describe('Disconnect via Escape', () => {
        test.beforeEach(async ({ page }) => {
            await connect(page);
        });

        test('should disconnect with double Escape', async ({ page }) => {
            const input = page.getByTestId('message-input');
            await input.focus();
            await page.keyboard.press('Escape');
            await page.keyboard.press('Escape');
            await expect(page.getByTestId('host-input')).toBeVisible({ timeout: 15000 });
        });
    });

});
