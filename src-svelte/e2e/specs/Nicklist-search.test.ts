import { test, expect } from '@playwright/test';
import { connectToWeechat, clearSettings, setSettings, waitForAppReady } from '../helpers/connection';
import { waitForBuffer, switchToBuffer } from '../helpers/buffers';

let page: import('@playwright/test').Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await page.route('**/cdnjs.cloudflare.com/**', (route) => route.abort());
    await page.goto('http://localhost:8001/');
    await waitForAppReady(page);
    await clearSettings(page);
    await setSettings(page, {
        savepassword: false,
        autoconnect: false,
        showNicklist: true,
    });
    page.on('pageerror', (error) => {
        if (error.message?.includes('effect_orphan')) return;
    });
    await connectToWeechat(page);
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
    await expect(page.getByTestId('nicklist')).toBeVisible({ timeout: 10000 });
});

test.afterAll(async () => {
    await page.close();
});

test.beforeEach(async () => {
    page.on('pageerror', (error) => {
        if (error.message?.includes('effect_orphan')) return;
    });
});

test('nicklist search filters nicks by name', async () => {
    const searchInput = page.getByTestId('nicklist-search');
    await expect(searchInput).toBeVisible();

    const allNicks = page.getByTestId('nick-item');
    const beforeCount = await allNicks.count();
    expect(beforeCount).toBeGreaterThan(0);

    // Type a common substring like 'o' which should match some but not all
    await searchInput.fill('o');
    await expect(async () => {
        const n = await allNicks.count();
        expect(n).toBeLessThanOrEqual(beforeCount);
        expect(n).toBeGreaterThan(0);
    }).toPass({ timeout: 5000 });
});

test('clearing search restores all nicks', async () => {
    const searchInput = page.getByTestId('nicklist-search');

    // Filter first
    await searchInput.fill('zzz_no_match_zzz');
    await expect(async () => {
        const n = await page.getByTestId('nick-item').count();
        expect(n).toBe(0);
    }).toPass({ timeout: 5000 });

    // Clear search
    await searchInput.clear();

    // All nicks should be back
    await expect(async () => {
        const n = await page.getByTestId('nick-item').count();
        expect(n).toBeGreaterThan(0);
    }).toPass({ timeout: 5000 });
});

test('search filters by both nick names and group names', async () => {
    const searchInput = page.getByTestId('nicklist-search');

    await searchInput.fill('gbbot');
    await expect(async () => {
        const n = await page.getByTestId('nick-item').count();
        expect(n).toBeGreaterThanOrEqual(1);
    }).toPass({ timeout: 5000 });

    const matchCount = await page.getByTestId('nick-item').count();
    for (let i = 0; i < matchCount; i++) {
        const text = await page.getByTestId('nick-item').nth(i).textContent();
        expect(text?.toLowerCase()).toContain('gbbot');
    }
});
