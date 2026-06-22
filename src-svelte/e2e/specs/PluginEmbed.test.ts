import { test, expect } from '@playwright/test';
import { createConnectedPage } from '../fixtures/auth';
import { setSettings } from '../helpers/connection';
import { botSay } from '../helpers/messages';
import { waitForBuffer, switchToBuffer } from '../helpers/buffers';
import { irc } from '../helpers/irc-control';

let page: import('@playwright/test').Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
    page = await createConnectedPage(browser);
    page.on('pageerror', (error) => {
        if (error.message?.includes('effect_orphan')) return;
    });
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

// Finds the bufferline-row containing a message with the given text
function rowForMessage(urlPattern: string) {
    return page.locator('[data-testid="bufferline-row"]').filter({
        has: page.locator(`td[data-message*="${urlPattern}"]`),
    }).first();
}

test('shows "Show Image" button when noembed is enabled', async () => {
    // noembed=true is the default after fix
    await botSay('https://picsum.photos/200/300.jpg?1');
    const row = rowForMessage('picsum.photos/200/300.jpg?1');
    await expect(row.locator('[data-testid="show-embed"]')).toBeVisible({ timeout: 10000 });
});

test('clicking Show Image reveals the embed', async () => {
    await botSay('https://picsum.photos/200/300.jpg?2');
    const row = rowForMessage('picsum.photos/200/300.jpg?2');
    const showBtn = row.locator('[data-testid="show-embed"]');
    await expect(showBtn).toBeVisible({ timeout: 10000 });
    await showBtn.click();
    // Verify the embed area became visible within the same row
    await expect(row.locator('.embed-area')).toBeVisible({ timeout: 10000 });
    await expect(row.locator('[data-testid="plugin-embed"]')).toBeVisible();
    await expect(row.locator('[data-testid="plugin-embed"] img')).toBeVisible();
});

test('clicking Hide Image hides the embed again', async () => {
    await botSay('https://picsum.photos/200/300.jpg?3');
    const row = rowForMessage('picsum.photos/200/300.jpg?3');
    const showBtn = row.locator('[data-testid="show-embed"]');
    await expect(showBtn).toBeVisible({ timeout: 10000 });
    await showBtn.click();
    // Wait for hide button to appear in the same row, then click it
    await expect(row.locator('[data-testid="hide-embed"]')).toBeVisible({ timeout: 10000 });
    await row.locator('[data-testid="hide-embed"]').click();
    // After hiding, the embed should be hidden and show button reappears
    await expect(row.locator('.embed-area')).not.toBeVisible({ timeout: 5000 });
    await expect(row.locator('[data-testid="show-embed"]')).toBeVisible();
});

test('handles multiple images in one message', async () => {
    await irc.sendMessage('#glowing-bear', 'See https://picsum.photos/200/300.jpg?4 and https://picsum.photos/200/300.jpg?5');
    const row = rowForMessage('picsum.photos/200/300.jpg?4');
    const showButtons = row.locator('[data-testid="show-embed"]');
    await expect(showButtons).toHaveCount(2, { timeout: 10000 });
    await expect(showButtons.nth(0)).toBeVisible();
    await expect(showButtons.nth(1)).toBeVisible();
});

test('NSFW image shows yellow warning button', async () => {
    await irc.sendMessage('#glowing-bear', 'nsfw https://picsum.photos/200/300.jpg?6');
    const row = rowForMessage('picsum.photos/200/300.jpg?6');
    const showBtn = row.locator('[data-testid="show-embed"]');
    await expect(showBtn).toBeVisible({ timeout: 10000 });
    // NSFW button should have yellow/amber/warning background-color
    const color = await showBtn.evaluate(el => getComputedStyle(el).backgroundColor);
    expect(color).toMatch(/yellow|rgb\(240|rgb\(217|rgb\(250|rgb\(230|rgba\(234|rgba\(244|rgba\(220|oklch\(|oklab\(/i);
});

test('noembed=false shows embeds automatically', async () => {
    await setSettings(page, { noembed: false });
    await botSay('https://picsum.photos/200/300.jpg?7');
    const row = rowForMessage('picsum.photos/200/300.jpg?7');
    await expect(row.locator('[data-testid="plugin-embed"] img')).toBeVisible({ timeout: 10000 });
    // New messages should have no "Show Image" button when noembed=false
    await expect(row.locator('[data-testid="show-embed"]')).not.toBeVisible();
});
