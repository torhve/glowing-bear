import { test, expect } from '@playwright/test';
import { createConnectedPage } from '../fixtures/auth';
import { switchToBuffer, waitForBuffer } from '../helpers/buffers';
import { expectInputFocused, rawInputValue, waitForInputValue } from '../helpers/input';
import { setupEffectOrphanFilter } from '../helpers/pageerror';

let page: import('@playwright/test').Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
    page = await createConnectedPage(browser);
    setupEffectOrphanFilter(page);
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
});

test.afterAll(async () => {
    await switchToBuffer(page, '#glowing-bear');
    await page.close();
});

test.beforeEach(async () => {
    setupEffectOrphanFilter(page);
});

/** Take focus away from the composer without taking it off the page. */
async function focusSomethingElse(): Promise<void> {
    const bufferItem = page.getByTestId('buffer-item').first();
    await bufferItem.focus();
    await expect(bufferItem).toBeFocused();
}

test.describe('focus-composer (Alt+L)', () => {
    test('finds the composer after the chat has been re-rendered by a buffer switch', async () => {
        await switchToBuffer(page, 'grep');
        await focusSomethingElse();

        await page.keyboard.press('Alt+L');

        // The page reaches the composer through the reference the composer published, so
        // the chord has to work on the composer of the conversation now showing, not only
        // on the one it first saw.
        await expectInputFocused(page);
        await expect(page.getByTestId('message-input')).toBeFocused();
    });

    test('focuses the composer without disturbing what the reader had typed', async () => {
        await page.getByTestId('message-input').fill('draft text');
        await waitForInputValue(page, 'draft text');
        await focusSomethingElse();

        await page.keyboard.press('Alt+L');

        await expectInputFocused(page);
        expect(await rawInputValue(page)).toBe('draft text');
        await page.getByTestId('message-input').fill('');
        await waitForInputValue(page, '');
    });

    test('single Escape blurs the composer and keeps the session', async () => {
        await page.getByTestId('message-input').focus();
        await expectInputFocused(page);

        await page.keyboard.press('Escape');

        await expect(page.getByTestId('message-input')).not.toBeFocused();
        // Still connected: the same chord that blurs must not be the one that disconnects.
        await page.keyboard.press('Alt+L');
        await expectInputFocused(page);
    });
});
