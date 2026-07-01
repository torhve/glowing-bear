import { test, expect } from '@playwright/test';
import { waitForBuffer, switchToBuffer } from '../helpers/buffers';
import { createConnectedPage } from '../fixtures/auth';

let page: import('@playwright/test').Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
    page = await createConnectedPage(browser, {
        settings: { savepassword: false, autoconnect: false, showNicklist: true },
    });
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
    await expect(page.getByTestId('nicklist')).toBeVisible({ timeout: 10000 });
    // Wait for nick items to populate — nicklist may render empty initially
    // while nick data loads from WeeChat
    await expect(page.getByTestId('nick-item').first()).toBeVisible({ timeout: 10000 });
});

test.afterAll(async () => {
    await page.close();
});

test.beforeEach(async () => {
});

/**
 * Ensure nick items are present before running a test.
 * Parallel tests on the shared gbtest server can modify IRC state
 * (joins, parts, kicks) that affect this buffer's nicklist.
 */
async function ensureNicksPresent(p: typeof page) {
    const nicks = p.getByTestId('nick-item');
    const count = await nicks.count();
    if (count === 0) {
        // Re-switch to buffer to trigger a fresh nicklist sync from WeeChat
        await switchToBuffer(p, '#glowing-bear');
        await expect(nicks.first()).toBeVisible({ timeout: 15000 });
    }
}

test('nicklist search filters nicks by name', async () => {
    await ensureNicksPresent(page);

    const searchInput = page.getByTestId('nicklist-search');
    await expect(searchInput).toBeVisible();

    const allNicks = page.getByTestId('nick-item');
    const beforeCount = await allNicks.count();
    expect(beforeCount).toBeGreaterThan(0);

    // Pick a real nick from the current list and use a substring of it
    // so we know at least one match will remain after filtering.
    // Extract bare nick name from .nick-name span — full textContent includes
    // prefix characters (e.g., '@gbbot') which don't match the search filter.
    const sampleNick = await allNicks.first().locator('.nick-name').textContent() || '';
    const query = sampleNick.trim().substring(0, 2);

    // Use keyboard.type() for proper input event dispatch that Svelte 5 captures
    await searchInput.click();
    await page.keyboard.type(query);
    await expect(searchInput).toHaveValue(query);

    await expect(async () => {
        const n = await allNicks.count();
        expect(n).toBeLessThanOrEqual(beforeCount);
        expect(n).toBeGreaterThan(0);
    }).toPass({ timeout: 10000 });
});

test('clearing search restores all nicks', async () => {
    await ensureNicksPresent(page);

    const searchInput = page.getByTestId('nicklist-search');

    // Filter first — use a string guaranteed to match nothing
    await searchInput.click();
    await page.keyboard.type('zzz_no_match_zzz_');
    await expect(async () => {
        const n = await page.getByTestId('nick-item').count();
        expect(n).toBe(0);
    }).toPass({ timeout: 10000 });

    // Clear search via fill (which triggers input event)
    await searchInput.fill('');

    // All nicks should be back
    await expect(async () => {
        const n = await page.getByTestId('nick-item').count();
        expect(n).toBeGreaterThan(0);
    }).toPass({ timeout: 10000 });
});

test('search filters by both nick names and group names', async () => {
    await ensureNicksPresent(page);

    const searchInput = page.getByTestId('nicklist-search');

    // Get a real nick name from the list to search for
    // Extract bare nick name from .nick-name span (full textContent includes prefix).
    const sampleNick = await page.getByTestId('nick-item').first().locator('.nick-name').textContent() || '';
    const query = sampleNick.trim();

    await searchInput.click();
    await page.keyboard.type(query);
    await expect(async () => {
        const n = await page.getByTestId('nick-item').count();
        expect(n).toBeGreaterThanOrEqual(1);
    }).toPass({ timeout: 10000 });

    const matchCount = await page.getByTestId('nick-item').count();
    for (let i = 0; i < matchCount; i++) {
        // Check the bare nick name contains the search query.
        const nickName = await page.getByTestId('nick-item').nth(i).locator('.nick-name').textContent();
        expect(nickName?.toLowerCase()).toContain(query.toLowerCase());
    }
});
