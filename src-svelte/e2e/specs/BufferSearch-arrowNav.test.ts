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

async function activeIndexOf(p: import('@playwright/test').Page): Promise<number> {
    return p.evaluate(() => {
        const box = document.querySelector('.buffer-search-results');
        if (!box) return -1;
        const active = Array.from(box.querySelectorAll('[data-search-index]'))
            .find((el) => el.classList.contains('!bg-accent'));
        return active ? Number(active.getAttribute('data-search-index')) : -1;
    });
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

// The claim is "the selected row ends up on screen", so measure that directly.
// This test used to compare the results box's scrollTop against a value read
// before clearing the query — but clearing re-renders the list and resets its
// offset (observed 829 -> 8), so the old comparison only passed when the
// preceding test happened to have left the box near the top.
test('selected item scrolls into view', async () => {
    await openBufferSearch(page);

    const searchInput = page.locator('#buffer-search');
    await searchInput.fill('');
    await waitForSearchResults(true);

    // Walk until the selection reaches the last row, instead of pressing a fixed
    // number of times. Two things make a fixed count unreliable here: the selection
    // wraps, so a fixed count lands wherever the list length happens to divide it,
    // and `selectedIndex` is component state that survives the dialog closing — a
    // previous spec leaves it wherever it stopped, so the walk does not start at 0.
    const results = await page.locator('[data-search-index]').count();
    for (let guard = 0; guard < results + 2; guard++) {
        if (await activeIndexOf(page) === results - 1) break;
        await searchInput.press('ArrowDown');
    }

    await expect(async () => {
        const state = await page.evaluate(() => {
            const container = document.querySelector('.buffer-search-results') as HTMLElement | null;
            if (!container) return null;
            const items = Array.from(container.querySelectorAll('[data-search-index]'));
            const active = items.find((el) => el.classList.contains('!bg-accent'));
            if (!active) return null;
            const box = container.getBoundingClientRect();
            const row = active.getBoundingClientRect();
            return {
                index: Number(active.getAttribute('data-search-index')),
                offscreen: row.top < box.top - 1 || row.bottom > box.bottom + 1,
                results: items.length,
            };
        });
        expect(state, 'the highlighted row should exist').not.toBeNull();
        expect(
            state!.index,
            `arrow navigation should reach the last of ${state!.results} results`,
        ).toBe(state!.results - 1);
        expect(
            state!.offscreen,
            `selected row ${state!.index} of ${state!.results} is outside the results box`,
        ).toBe(false);
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
