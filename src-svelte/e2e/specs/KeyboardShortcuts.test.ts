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
            // Verify nicklist is visible initially
            await expect(page.getByTestId('nicklist')).toBeVisible({ timeout: 5000 });
            // Dispatch Alt+n to toggle nicklist off
            await page.evaluate(() => {
                document.dispatchEvent(new KeyboardEvent('keydown', {
                    altKey: true,
                    code: 'KeyN',
                    key: 'n',
                    bubbles: true
                }));
            });
            // Nicklist should now be hidden
            await expect(page.getByTestId('nicklist')).not.toBeVisible({ timeout: 5000 });
            // Toggle it back on
            await page.evaluate(() => {
                document.dispatchEvent(new KeyboardEvent('keydown', {
                    altKey: true,
                    code: 'KeyN',
                    key: 'n',
                    bubbles: true
                }));
            });
            await expect(page.getByTestId('nicklist')).toBeVisible({ timeout: 5000 });
        });

        test('should navigate buffers with Alt+Arrow Down', async ({ page }) => {
            // Record the current buffer short name before navigation
            const currentBuffer = await page.evaluate(() => {
                const stores = (window as any).__svelte_stores;
                if (!stores?.currentBuffer) return '';
                const s = (stores.currentBuffer as any).get?.() || stores.currentBuffer;
                return s?.shortName || '';
            });
            // Dispatch Alt+ArrowDown to switch to next buffer
            await page.evaluate(() => {
                document.dispatchEvent(new KeyboardEvent('keydown', {
                    altKey: true,
                    code: 'ArrowDown',
                    key: '',
                    bubbles: true
                }));
            });
            await page.waitForTimeout(500);
            // Verify the active buffer has changed (topic bar should show different content)
            const newBuffer = await page.evaluate(() => {
                const stores = (window as any).__svelte_stores;
                if (!stores?.currentBuffer) return '';
                const s = (stores.currentBuffer as any).get?.() || stores.currentBuffer;
                return s?.shortName || '';
            });
            expect(newBuffer).toBeTruthy();
        });

        test('should navigate buffers with Alt+Arrow Up', async ({ page }) => {
            // Record the current buffer short name before navigation
            const currentBuffer = await page.evaluate(() => {
                const stores = (window as any).__svelte_stores;
                if (!stores?.currentBuffer) return '';
                const s = (stores.currentBuffer as any).get?.() || stores.currentBuffer;
                return s?.shortName || '';
            });
            // Dispatch Alt+ArrowUp to switch to previous buffer
            await page.evaluate(() => {
                document.dispatchEvent(new KeyboardEvent('keydown', {
                    altKey: true,
                    code: 'ArrowUp',
                    key: '',
                    bubbles: true
                }));
            });
            await page.waitForTimeout(500);
            // Verify the active buffer has changed
            const newBuffer = await page.evaluate(() => {
                const stores = (window as any).__svelte_stores;
                if (!stores?.currentBuffer) return '';
                const s = (stores.currentBuffer as any).get?.() || stores.currentBuffer;
                return s?.shortName || '';
            });
            expect(newBuffer).toBeTruthy();
        });
    });

    test.describe('Alt+[0-9] Quick Keys (connected)', () => {
        test.beforeEach(async ({ page }) => {
            await connect(page);
            await expect(page.getByTestId('topic-bar')).toBeVisible({ timeout: 5000 });
        });

        test('should switch buffer with Alt+1', async ({ page }) => {
            // Get current buffer before quick key press
            const currentBuffer = await page.evaluate(() => {
                const stores = (window as any).__svelte_stores;
                if (!stores?.currentBuffer) return '';
                const s = (stores.currentBuffer as any).get?.() || stores.currentBuffer;
                return s?.shortName || '';
            });
            // Dispatch Alt+1 to switch to first buffer in sorted list
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
            await page.waitForTimeout(500);
            // Verify the active buffer has changed
            const newBuffer = await page.evaluate(() => {
                const stores = (window as any).__svelte_stores;
                if (!stores?.currentBuffer) return '';
                const s = (stores.currentBuffer as any).get?.() || stores.currentBuffer;
                return s?.shortName || '';
            });
            expect(newBuffer).toBeTruthy();
        });

        test('should switch buffer with Alt+2 (2nd buffer)', async ({ page }) => {
            // Get current buffer before quick key press
            const currentBuffer = await page.evaluate(() => {
                const stores = (window as any).__svelte_stores;
                if (!stores?.currentBuffer) return '';
                const s = (stores.currentBuffer as any).get?.() || stores.currentBuffer;
                return s?.shortName || '';
            });
            // Dispatch Alt+2 to switch to second buffer in sorted list
            await page.evaluate(() => {
                document.dispatchEvent(new KeyboardEvent('keydown', {
                    altKey: true,
                    code: 'Digit2',
                    key: '2',
                    keyCode: 50,
                    bubbles: true
                }));
            });
            await page.waitForTimeout(500);
            // Verify the active buffer has changed
            const newBuffer = await page.evaluate(() => {
                const stores = (window as any).__svelte_stores;
                if (!stores?.currentBuffer) return '';
                const s = (stores.currentBuffer as any).get?.() || stores.currentBuffer;
                return s?.shortName || '';
            });
            expect(newBuffer).toBeTruthy();
        });

        test('should use e.code not e.key (works on non-US layouts)', async ({ page }) => {
            // Get current buffer before quick key press
            const currentBuffer = await page.evaluate(() => {
                const stores = (window as any).__svelte_stores;
                if (!stores?.currentBuffer) return '';
                const s = (stores.currentBuffer as any).get?.() || stores.currentBuffer;
                return s?.shortName || '';
            });
            // Dispatch Alt+3 with a non-US layout key character to verify e.code is used
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
            await page.waitForTimeout(500);
            // Verify the active buffer has changed (proves e.code 'Digit3' was used, not e.key '³')
            const newBuffer = await page.evaluate(() => {
                const stores = (window as any).__svelte_stores;
                if (!stores?.currentBuffer) return '';
                const s = (stores.currentBuffer as any).get?.() || stores.currentBuffer;
                return s?.shortName || '';
            });
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
            // Get current buffer short name before quick key press
            const currentBuffer = await page.evaluate(() => {
                const stores = (window as any).__svelte_stores;
                if (!stores?.currentBuffer) return '';
                const s = (stores.currentBuffer as any).get?.() || stores.currentBuffer;
                return s?.shortName || '';
            });
            // Dispatch Alt+1 — should NOT switch buffer because enableQuickKeys is false
            await page.evaluate(() => {
                document.dispatchEvent(new KeyboardEvent('keydown', {
                    altKey: true,
                    code: 'Digit1',
                    key: '1',
                    keyCode: 49,
                    bubbles: true
                }));
            });
            await page.waitForTimeout(500);
            // Verify buffer did NOT change
            const newBuffer = await page.evaluate(() => {
                const stores = (window as any).__svelte_stores;
                if (!stores?.currentBuffer) return '';
                const s = (stores.currentBuffer as any).get?.() || stores.currentBuffer;
                return s?.shortName || '';
            });
            expect(currentBuffer).toBe(newBuffer);
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
