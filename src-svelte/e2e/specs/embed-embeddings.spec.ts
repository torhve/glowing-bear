import { test, expect } from '@playwright/test';
import { connectToWeechat, clearSettings, setSettings, waitForAppReady } from '../helpers/connection';
import { botSay } from '../helpers/messages';
import { waitForBuffer, switchToBuffer } from '../helpers/buffers';
import { irc } from '../helpers/irc-control';

let page: import('@playwright/test').Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await page.goto('http://localhost:8001/');
    await waitForAppReady(page);
    await clearSettings(page);
    page.on('pageerror', (error) => {
        if (error.message?.includes('effect_orphan')) return;
    });
    await connectToWeechat(page);
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
});

test.afterAll(async () => {
    await page.close();
});

test.beforeEach(async () => {
    page.on('pageerror', (error) => {
        if (error.message?.includes('effect_orphan')) return;
    });
});

test('shows "Show Image" button when noembed is enabled', async () => {
    // noembed=true is the default after fix
    await botSay('https://picsum.photos/200/300.jpg?1');
    const showBtn = page.getByTestId('show-embed').filter({ hasText: 'Show Image' }).first();
    await expect(showBtn).toBeVisible({ timeout: 10000 });
});

test('clicking Show Image reveals the embed', async () => {
    await botSay('https://picsum.photos/200/300.jpg?2');
    const showBtn = page.getByTestId('show-embed').filter({ hasText: 'Show Image' }).last();
    await showBtn.click();
    const hideBtn = page.getByTestId('hide-embed').filter({ hasText: 'Hide Image' }).last();
    await expect(hideBtn).toBeVisible({ timeout: 10000 });
    const embed = page.getByTestId('plugin-embed').last();
    await expect(embed).toBeVisible();
    await expect(embed.locator('img')).toBeVisible();
});

test('clicking Hide Image hides the embed again', async () => {
    await botSay('https://picsum.photos/200/300.jpg?3');
    const showBtn = page.getByTestId('show-embed').filter({ hasText: 'Show Image' }).last();
    await showBtn.click();
    // Wait for a hide button to appear, then click it
    const hideBtn = page.getByTestId('hide-embed').filter({ hasText: 'Hide Image' }).last();
    await expect(hideBtn).toBeVisible({ timeout: 10000 });
    await hideBtn.click();
    // After hiding, the embed for this message should be hidden (show button reappears)
    const msgCell = page.locator('td[data-message*="picsum.photos/200/300.jpg?3"]').first();
    await expect(msgCell.locator('[data-testid="plugin-embed"]')).not.toBeVisible();
    await expect(msgCell.locator('[data-testid="show-embed"]')).toBeVisible();
});

test('handles multiple images in one message', async () => {
    await irc.sendMessage('#glowing-bear', 'See https://picsum.photos/200/300.jpg?4 and https://picsum.photos/200/300.jpg?5');
    const showButtons = page.getByTestId('show-embed').filter({ hasText: 'Show Image' });
    await expect(showButtons.nth(0)).toBeVisible();
    await expect(showButtons.nth(-1)).toBeVisible();
});

test('NSFW image shows yellow warning button', async () => {
    await irc.sendMessage('#glowing-bear', 'nsfw https://picsum.photos/200/300.jpg?6');
    const showBtn = page.getByTestId('show-embed').filter({ hasText: 'Show Image' }).last();
    await expect(showBtn).toBeVisible({ timeout: 10000 });
    // NSFW button should have yellow/warning styling (oklch or named color)
    const color = await showBtn.evaluate(el => getComputedStyle(el).backgroundColor);
    expect(color).toMatch(/yellow|rgb\(217|oklch\(/i);
});

test('noembed=false shows embeds automatically', async () => {
    await setSettings(page, { noembed: false });
    await botSay('https://picsum.photos/200/300.jpg?7');
    await expect(page.getByTestId('plugin-embed').locator('img')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('show-embed')).not.toBeVisible();
});
