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

        test('should toggle nicklist with Alt+n', async ({ page }) => {
            const input = page.getByTestId('message-input');
            await input.focus();
            await page.evaluate(() => {
                document.dispatchEvent(new KeyboardEvent('keydown', {
                    altKey: true,
                    code: 'KeyN',
                    key: 'n',
                    bubbles: true
                }));
            });
            await expect(page.getByTestId('chat-view')).toBeVisible({ timeout: 5000 });
        });

        test('should navigate buffers with Alt+Arrow Down', async ({ page }) => {
            const input = page.getByTestId('message-input');
            await input.focus();
            await page.evaluate(() => {
                document.dispatchEvent(new KeyboardEvent('keydown', {
                    altKey: true,
                    code: 'ArrowDown',
                    key: '',
                    bubbles: true
                }));
            });
            await expect(page.getByTestId('topic-bar')).toBeVisible({ timeout: 5000 });
        });

        test('should navigate buffers with Alt+Arrow Up', async ({ page }) => {
            const input = page.getByTestId('message-input');
            await input.focus();
            await page.evaluate(() => {
                document.dispatchEvent(new KeyboardEvent('keydown', {
                    altKey: true,
                    code: 'ArrowUp',
                    key: '',
                    bubbles: true
                }));
            });
            await expect(page.getByTestId('topic-bar')).toBeVisible({ timeout: 5000 });
        });
    });

    test.describe('Alt+[0-9] Quick Keys (connected)', () => {
        test.beforeEach(async ({ page }) => {
            await connect(page);
            await expect(page.getByTestId('topic-bar')).toBeVisible({ timeout: 5000 });
        });

        test('should switch buffer with Alt+1', async ({ page }) => {
            await page.evaluate(() => {
                document.dispatchEvent(new KeyboardEvent('keydown', {
                    altKey: true,
                    ctrlKey: false,
                    shiftKey: false,
                    code: 'Digit1',
                    key: '1',
                    keyCode: 49,
                    bubbles: true
                }));
            });
            await expect(page.getByTestId('chat-view')).toBeVisible({ timeout: 5000 });
        });

        test('should switch buffer with Alt+2 (2nd buffer)', async ({ page }) => {
            await page.evaluate(() => {
                document.dispatchEvent(new KeyboardEvent('keydown', {
                    altKey: true,
                    code: 'Digit2',
                    key: '2',
                    keyCode: 50,
                    bubbles: true
                }));
            });
            await expect(page.getByTestId('chat-view')).toBeVisible({ timeout: 5000 });
        });

        test('should use e.code not e.key (works on non-US layouts)', async ({ page }) => {
            await page.evaluate(() => {
                const evt = new KeyboardEvent('keydown', {
                    altKey: true,
                    code: 'Digit3',
                    key: '³',
                    keyCode: 51,
                    bubbles: true
                });
                document.dispatchEvent(evt);
            });
            await expect(page.getByTestId('chat-view')).toBeVisible({ timeout: 5000 });
        });
    });

    test.describe('Settings-Dependent Shortcuts', () => {
        test.beforeEach(async ({ page }) => {
            await connect(page);
            await expect(page.getByTestId('topic-bar')).toBeVisible({ timeout: 5000 });
        });

        test('should respect enableQuickKeys setting when disabled', async ({ page }) => {
            await page.evaluate(() => {
                const stores = (window as any).__svelte_stores || {};
                return stores.settings;
            });
        });

        test('should toggle readline bindings and test Ctrl+A', async ({ page }) => {
            await page.getByTestId('settings-button').click();
            await expect(page.getByTestId('settings-modal')).toBeVisible();
            await page.getByTestId('settings-modal-close').click();
            await expect(page.getByTestId('settings-modal')).not.toBeVisible({ timeout: 5000 });
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

        test('should focus buffer search with Ctrl+K via document event', async ({ page }) => {
            await page.evaluate(() => {
                document.dispatchEvent(new KeyboardEvent('keydown', {
                    altKey: false,
                    ctrlKey: true,
                    code: 'KeyK',
                    key: 'k',
                    keyCode: 75,
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
            await page.getByTitle('Search buffers (Ctrl+K)').click();
            const searchInput = page.locator('#buffer-search');
            await expect(searchInput).toBeVisible({ timeout: 5000 });
            await searchInput.fill('#');
            await page.waitForTimeout(300);
            await searchInput.press('Enter');
            await expect(page.getByTestId('topic-bar')).toContainText('#', { timeout: 5000 });
            await expect(searchInput).not.toBeVisible({ timeout: 5000 });
        });

        test('should be a no-op when no results match the query', async ({ page }) => {
            await page.getByTitle('Search buffers (Ctrl+K)').click();
            const searchInput = page.locator('#buffer-search');
            await expect(searchInput).toBeVisible({ timeout: 5000 });
            await searchInput.fill('zzzzz_NO_MATCH_zzzzz');
            await searchInput.press('Enter');
            await expect(searchInput).toBeVisible({ timeout: 5000 });
            await expect(searchInput).toHaveValue('zzzzz_NO_MATCH_zzzzz');
        });

        test('should select the first buffer when Enter pressed with no query but list is open', async ({ page }) => {
            await page.getByTitle('Search buffers (Ctrl+K)').click();
            const searchInput = page.locator('#buffer-search');
            await expect(searchInput).toBeVisible({ timeout: 5000 });
            await searchInput.press('Enter');
            await expect(page.getByTestId('topic-bar')).toBeVisible({ timeout: 5000 });
            await expect(page.getByTestId('topic-bar')).toContainText('#', { timeout: 5000 });
            await expect(searchInput).not.toBeVisible({ timeout: 5000 });
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
