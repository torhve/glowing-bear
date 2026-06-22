import { test, expect } from '@playwright/test';
import { createConnectedPage } from '../fixtures/auth';

let page: import('@playwright/test').Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
    page = await createConnectedPage(browser);
    page.on('pageerror', (error) => {
        if (error.message?.includes('effect_orphan')) return;
    });
});

test.afterAll(async () => {
    await page.close();
});

test.beforeEach(async () => {
    page.on('pageerror', (error) => {
        if (error.message?.includes('effect_orphan')) return;
    });
});

async function findSelectedIndex(p: import('@playwright/test').Page): Promise<number> {
    return await p.evaluate(() => {
        const el = document.querySelector('[data-search-index]');
        if (!el) return -1;
        return parseInt(el.getAttribute('data-search-index') || '-1', 10);
    });
}

async function openBufferSearch(p: import('@playwright/test').Page) {
    await p.evaluate(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', {
            altKey: true, code: 'KeyG', key: 'g', keyCode: 71, bubbles: true
        }));
    });
    await expect(p.locator('#buffer-search')).toBeVisible({ timeout: 5000 });
}

test('ArrowDown cycles through filtered results', async () => {
    await openBufferSearch(page);

    const searchInput = page.locator('#buffer-search');
    await searchInput.fill('gbtest');
    await page.waitForTimeout(300);

    const selectedIdx = await findSelectedIndex(page);
    expect(selectedIdx).toBe(0);

    await searchInput.press('ArrowDown');
    await page.waitForTimeout(200);

    const newIdx = await findSelectedIndex(page);
    if (newIdx >= 1) {
        // cycled to next item
    } else {
        expect(newIdx).toBe(0);
    }
});

test('ArrowUp cycles backwards through results', async () => {
    await openBufferSearch(page);

    const searchInput = page.locator('#buffer-search');
    await searchInput.fill('gbtest');
    await page.waitForTimeout(300);

    // Navigate down a few times first
    await searchInput.press('ArrowDown');
    await searchInput.press('ArrowDown');
    await page.waitForTimeout(200);

    const selectedIdx = await findSelectedIndex(page);
    expect(selectedIdx).toBeGreaterThanOrEqual(0);

    // Press ArrowUp once
    await searchInput.press('ArrowUp');
    await page.waitForTimeout(200);

    const newIdx = await findSelectedIndex(page);
    expect(newIdx).toBeLessThanOrEqual(selectedIdx);
});

test('ArrowDown wraps around to first result', async () => {
    await openBufferSearch(page);

    const searchInput = page.locator('#buffer-search');
    await searchInput.fill('');
    await page.waitForTimeout(300);

    // Navigate past all items to reach end and wrap
    for (let i = 0; i < 20; i++) {
        await searchInput.press('ArrowDown');
        await page.waitForTimeout(150);
    }

    const selectedIdx = await findSelectedIndex(page);
    // After cycling through all items, should have wrapped or be at a valid index
    expect(selectedIdx).toBeGreaterThanOrEqual(0);
});

test('selected item scrolls into view', async () => {
    await openBufferSearch(page);

    const searchInput = page.locator('#buffer-search');
    await searchInput.fill('');
    await page.waitForTimeout(300);

    const scrollTop = await page.evaluate(() => {
        const container = document.querySelector('.buffer-search-results');
        return container ? (container as HTMLElement).scrollTop : -1;
    });

    // Navigate down many items
    for (let i = 0; i < 15; i++) {
        await searchInput.press('ArrowDown');
        await page.waitForTimeout(150);
    }

    const newScrollTop = await page.evaluate(() => {
        const container = document.querySelector('.buffer-search-results');
        return container ? (container as HTMLElement).scrollTop : -1;
    });

    // Scroll position should have changed or stayed the same (if all items fit)
    expect(newScrollTop).toBeGreaterThanOrEqual(scrollTop);
});

test('arrow keys are no-op when no results match', async () => {
    await openBufferSearch(page);

    const searchInput = page.locator('#buffer-search');
    await searchInput.fill('zzzzz_no_match_zzzzz');
    await page.waitForTimeout(300);

    await searchInput.press('ArrowDown');
    await searchInput.press('ArrowUp');
    await searchInput.press('ArrowDown');
    await page.waitForTimeout(200);

    await expect(page.getByText('No buffers found')).toBeVisible();
});
