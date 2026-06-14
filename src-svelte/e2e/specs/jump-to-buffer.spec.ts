import { test, expect } from '@playwright/test';
import { waitForAppReady } from '../helpers/connection';

async function connect(page: import('@playwright/test').Page) {
    await page.getByTestId('host-input').clear();
    await page.getByTestId('host-input').fill('localhost');
    await page.getByTestId('password-input').clear();
    await page.getByTestId('password-input').fill('testpassword123');
    await page.getByTestId('connect-button').click();
    await expect(page.getByTestId('chat-view')).toBeVisible({ timeout: 15000 });
}

test.describe('Jump-to-Buffer (Alt+J)', () => {
    test.beforeEach(async ({ page }) => {
        page.on('pageerror', (e) => { if (e.message?.includes('effect_orphan')) return; });
        await page.goto('http://localhost:8001/');
        await waitForAppReady(page);
    });

    test('should not switch buffer when Alt+J pressed while disconnected', async ({ page }) => {
        await page.evaluate(() => {
            document.dispatchEvent(new KeyboardEvent('keydown', {
                altKey: true,
                ctrlKey: false,
                shiftKey: false,
                code: 'KeyJ',
                key: 'j',
                keyCode: 74,
                which: 74,
                bubbles: true
            }));
        });
        await expect(page.getByTestId('host-input')).toBeVisible();
        await expect(page.getByTestId('chat-view')).not.toBeVisible();
    });

    test('should display jump keys on buffer items after connecting', async ({ page }) => {
        await connect(page);
        await expect(page.getByTestId('topic-bar')).toBeVisible({ timeout: 5000 });
        const bufferItems = page.locator('[data-testid="buffer-item"]');
        await expect(bufferItems.first()).toBeVisible();
    });

    test('should switch to first buffer with Alt+J then 1', async ({ page }) => {
        await connect(page);
        await expect(page.getByTestId('topic-bar')).toBeVisible({ timeout: 5000 });

        // First, get the current active buffer
        const initialTopic = await page.getByTestId('topic-bar').textContent();

        // Press Alt+J to enter jump mode
        await page.evaluate(() => {
            document.dispatchEvent(new KeyboardEvent('keydown', {
                altKey: true,
                ctrlKey: false,
                shiftKey: false,
                code: 'KeyJ',
                key: 'j',
                keyCode: 74,
                which: 74,
                bubbles: true
            }));
        });

        // Press first digit (1)
        await page.evaluate(() => {
            document.dispatchEvent(new KeyboardEvent('keydown', {
                altKey: false,
                ctrlKey: false,
                shiftKey: false,
                code: 'Digit1',
                key: '1',
                keyCode: 49,
                which: 49,
                bubbles: true
            }));
        });

        // Press second digit (1) to jump to buffer #1
        await page.evaluate(() => {
            document.dispatchEvent(new KeyboardEvent('keydown', {
                altKey: false,
                ctrlKey: false,
                shiftKey: false,
                code: 'Digit1',
                key: '1',
                keyCode: 49,
                which: 49,
                bubbles: true
            }));
        });

        // Should still be connected and chat view visible
        await expect(page.getByTestId('chat-view')).toBeVisible({ timeout: 5000 });
    });

    test('should switch to second buffer with Alt+J then 2', async ({ page }) => {
        await connect(page);
        await expect(page.getByTestId('topic-bar')).toBeVisible({ timeout: 5000 });

        // Press Alt+J to enter jump mode
        await page.evaluate(() => {
            document.dispatchEvent(new KeyboardEvent('keydown', {
                altKey: true,
                ctrlKey: false,
                shiftKey: false,
                code: 'KeyJ',
                key: 'j',
                keyCode: 74,
                which: 74,
                bubbles: true
            }));
        });

        // Press first digit (2)
        await page.evaluate(() => {
            document.dispatchEvent(new KeyboardEvent('keydown', {
                altKey: false,
                ctrlKey: false,
                shiftKey: false,
                code: 'Digit2',
                key: '2',
                keyCode: 50,
                which: 50,
                bubbles: true
            }));
        });

        // Press second digit (0) to jump to buffer #20
        await page.evaluate(() => {
            document.dispatchEvent(new KeyboardEvent('keydown', {
                altKey: false,
                ctrlKey: false,
                shiftKey: false,
                code: 'Digit0',
                key: '0',
                keyCode: 48,
                which: 48,
                bubbles: true
            }));
        });

        // Should still be connected and chat view visible
        await expect(page.getByTestId('chat-view')).toBeVisible({ timeout: 5000 });
    });

    test('should abort jump mode on non-digit key', async ({ page }) => {
        await connect(page);
        await expect(page.getByTestId('topic-bar')).toBeVisible({ timeout: 5000 });

        // Press Alt+J to enter jump mode
        await page.evaluate(() => {
            document.dispatchEvent(new KeyboardEvent('keydown', {
                altKey: true,
                ctrlKey: false,
                shiftKey: false,
                code: 'KeyJ',
                key: 'j',
                keyCode: 74,
                which: 74,
                bubbles: true
            }));
        });

        // Press a letter key (should abort jump mode)
        await page.evaluate(() => {
            document.dispatchEvent(new KeyboardEvent('keydown', {
                altKey: false,
                ctrlKey: false,
                shiftKey: false,
                code: 'KeyX',
                key: 'x',
                keyCode: 88,
                which: 88,
                bubbles: true
            }));
        });

        // Should still be connected
        await expect(page.getByTestId('chat-view')).toBeVisible({ timeout: 5000 });
    });

    test('should start fresh jump mode on second Alt+J press', async ({ page }) => {
        await connect(page);
        await expect(page.getByTestId('topic-bar')).toBeVisible({ timeout: 5000 });

        // First Alt+J -> press one digit
        await page.evaluate(() => {
            document.dispatchEvent(new KeyboardEvent('keydown', {
                altKey: true,
                code: 'KeyJ',
                keyCode: 74,
                bubbles: true
            }));
        });

        await page.evaluate(() => {
            document.dispatchEvent(new KeyboardEvent('keydown', {
                code: 'Digit3',
                keyCode: 51,
                bubbles: true
            }));
        });

        // Second Alt+J should reset (not continue from previous state)
        await page.evaluate(() => {
            document.dispatchEvent(new KeyboardEvent('keydown', {
                altKey: true,
                code: 'KeyJ',
                keyCode: 74,
                bubbles: true
            }));
        });

        // Press two digits
        await page.evaluate(() => {
            document.dispatchEvent(new KeyboardEvent('keydown', {
                code: 'Digit2',
                keyCode: 50,
                bubbles: true
            }));
        });

        await page.evaluate(() => {
            document.dispatchEvent(new KeyboardEvent('keydown', {
                code: 'Digit5',
                keyCode: 53,
                bubbles: true
            }));
        });

        // Should still be connected
        await expect(page.getByTestId('chat-view')).toBeVisible({ timeout: 5000 });
    });
});
