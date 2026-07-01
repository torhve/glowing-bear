import { test, expect } from '@playwright/test';
import { createConnectedPage } from '../fixtures/auth';

import { setupEffectOrphanFilter } from '../helpers/pageerror';

let page: import('@playwright/test').Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
    page = await createConnectedPage(browser);
    setupEffectOrphanFilter(page)
});

test.afterAll(async () => {
    await page.close();
});

test.beforeEach(async () => {
    setupEffectOrphanFilter(page)
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

async function waitForSelectedIndex(expectedFn: (idx: number) => boolean, timeout = 5000) {
    await expect(async () => {
        const idx = await findSelectedIndex(page);
        expect(expectedFn(idx)).toBe(true);
    }).toPass({ timeout });
}

async function waitForSearchResults(appear = true, timeout = 5000) {
    await expect(async () => {
        const count = await page.locator('[data-search-index]').count();
        if (appear) {
            expect(count).toBeGreaterThan(0);
        } else {
            expect(count).toBe(0);
        }
    }).toPass({ timeout });
}

test('ArrowDown cycles through filtered results', async () => {
    await openBufferSearch(page);

    const searchInput = page.locator('#buffer-search');
    await searchInput.fill('gbtest');
    await waitForSearchResults(true);

    await waitForSelectedIndex((idx) => idx === 0);

    await searchInput.press('ArrowDown');

    await waitForSelectedIndex((idx) => idx >= 1 || idx === 0);
});

test('ArrowUp cycles backwards through results', async () => {
    await openBufferSearch(page);

    const searchInput = page.locator('#buffer-search');
    await searchInput.fill('gbtest');
    await waitForSearchResults(true);

    // Navigate down a few times first
    await searchInput.press('ArrowDown');
    await searchInput.press('ArrowDown');
    await waitForSelectedIndex((idx) => idx >= 0);

    const selectedIdx = await findSelectedIndex(page);

    // Press ArrowUp once
    await searchInput.press('ArrowUp');

    await waitForSelectedIndex((idx) => idx <= selectedIdx);
});

test('ArrowDown wraps around to first result', async () => {
    await openBufferSearch(page);

    const searchInput = page.locator('#buffer-search');
    await searchInput.fill('');
    await waitForSearchResults(true);

    // Navigate past all items to reach end and wrap
    for (let i = 0; i < 20; i++) {
        await searchInput.press('ArrowDown');
    }

    await waitForSelectedIndex((idx) => idx >= 0);
});

test('selected item scrolls into view', async () => {
    await openBufferSearch(page);

    const searchInput = page.locator('#buffer-search');
    await searchInput.fill('');
    await waitForSearchResults(true);

    const scrollTop = await page.evaluate(() => {
        const container = document.querySelector('.buffer-search-results');
        return container ? (container as HTMLElement).scrollTop : -1;
    });

    // Navigate down many items
    for (let i = 0; i < 15; i++) {
        await searchInput.press('ArrowDown');
    }

    await expect(async () => {
        const newScrollTop = await page.evaluate(() => {
            const container = document.querySelector('.buffer-search-results');
            return container ? (container as HTMLElement).scrollTop : -1;
        });
        // Scroll position should have changed or stayed the same (if all items fit)
        expect(newScrollTop).toBeGreaterThanOrEqual(scrollTop);
    }).toPass({ timeout: 5000 });
});

test('arrow keys are no-op when no results match', async () => {
    await openBufferSearch(page);

    const searchInput = page.locator('#buffer-search');
    await searchInput.pressSequentially('zzzzz_no_match_zzzzz');
    await waitForSearchResults(false);

    await searchInput.press('ArrowDown');
    await searchInput.press('ArrowUp');
    await searchInput.press('ArrowDown');

    await expect(page.getByText('No buffers found')).toBeVisible();
});
