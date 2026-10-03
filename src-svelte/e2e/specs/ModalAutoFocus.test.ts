import { test, expect } from '@playwright/test';
import { createConnectedPage } from '../fixtures/auth';
import { setupEffectOrphanFilter } from '../helpers/pageerror';

let page: import('@playwright/test').Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
    page = await createConnectedPage(browser);
    setupEffectOrphanFilter(page);
});

test.afterAll(async () => {
    await page.close();
});

test.beforeEach(async () => {
    setupEffectOrphanFilter(page);
});

function press(p: import('@playwright/test').Page, opts: KeyboardEventInit & { code: string; key: string; keyCode: number }) {
    return p.evaluate((o) => {
        document.dispatchEvent(new KeyboardEvent('keydown', { ...o, bubbles: true }));
    }, opts);
}

async function activeId(p: import('@playwright/test').Page) {
    return p.evaluate(() => (document.activeElement as HTMLElement)?.id ?? '');
}

async function openWith(p: import('@playwright/test').Page, modalId: string, key: KeyboardEventInit & { code: string; key: string; keyCode: number }) {
    // Close first so every test exercises a real open transition.
    await p.evaluate((id) => (document.getElementById(id) as HTMLElement)?.hidePopover(), modalId);
    await expect(p.locator(`#${modalId}`)).not.toBeVisible({ timeout: 5000 });
    await press(p, key);
    await expect(p.locator(`#${modalId}`)).toBeVisible({ timeout: 5000 });
}

const CTRL_F = { ctrlKey: true, code: 'KeyF', key: 'f', keyCode: 70 };
const ALT_G = { altKey: true, code: 'KeyG', key: 'g', keyCode: 71 };

// Regression guard: Chromium dispatches the popover `toggle` event a frame after
// the popover becomes visible, which used to leave the close button focused and
// swallow the first keystroke. Both modals now focus from `beforetoggle`.
test('Ctrl+F focuses the content search field', async () => {
    await openWith(page, 'content-search-modal', CTRL_F);
    expect(await activeId(page)).toBe('content-search-input');
});

test('Alt+G focuses the buffer search field', async () => {
    await openWith(page, 'buffer-search-modal', ALT_G);
    expect(await activeId(page)).toBe('buffer-search');
});

test('Escape dismisses the content search modal', async () => {
    await openWith(page, 'content-search-modal', CTRL_F);
    await page.keyboard.press('Escape');
    await expect(page.locator('#content-search-modal')).not.toBeVisible({ timeout: 5000 });
});

test('Escape dismisses the buffer search modal', async () => {
    await openWith(page, 'buffer-search-modal', ALT_G);
    await page.keyboard.press('Escape');
    await expect(page.locator('#buffer-search-modal')).not.toBeVisible({ timeout: 5000 });
});

test('reopening after Escape re-focuses the content search field', async () => {
    await openWith(page, 'content-search-modal', CTRL_F);
    await page.keyboard.press('Escape');
    await expect(page.locator('#content-search-modal')).not.toBeVisible({ timeout: 5000 });

    // The original regression: a reopen whose toggle event lands late left the
    // close button focused instead of the search field.
    await press(page, CTRL_F);
    await expect(page.locator('#content-search-modal')).toBeVisible({ timeout: 5000 });
    expect(await activeId(page)).toBe('content-search-input');
});
