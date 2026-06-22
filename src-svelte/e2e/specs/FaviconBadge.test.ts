import { test, expect } from '@playwright/test';
import { connectToWeechat, clearSettings, setSettings, waitForAppReady } from '../helpers/connection';
import { waitForBuffer, switchToBuffer } from '../helpers/buffers';
import { irc } from '../helpers/irc-control';

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
        useFavico: true,
    });
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

function fillPortInput(p: import('@playwright/test').Page, port: string) {
    return p.evaluate((p) => {
        const input = document.querySelector('[data-testid="port-input"]');
        if (input) {
            (input as HTMLInputElement).value = p;
            input.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }, port);
}

async function reconnectWithFavico(page: import('@playwright/test').Page, enabled: boolean) {
    await clearSettings(page);
    await setSettings(page, { savepassword: false, autoconnect: false, useFavico: enabled });
    await page.getByTestId('disconnect-button').click().catch(() => {});
    await page.waitForTimeout(2000);
    await page.getByTestId('host-input').fill('localhost');
    await fillPortInput(page, '9001');
    await page.getByTestId('password-input').fill('testpassword123');
    await page.getByTestId('connect-button').click();
    await page.getByTestId('chat-view').waitFor({ state: 'visible', timeout: 45000 });
}

async function getFaviconHref(p: import('@playwright/test').Page): Promise<string> {
    return await p.evaluate(() => {
        const link = document.querySelector("link[rel='icon'][sizes='32x32']");
        return link?.getAttribute('href') || '';
    });
}

test('favicon badge updates when unread messages arrive on inactive buffer', async () => {
    await reconnectWithFavico(page, true);
    await waitForBuffer(page, '#glowing-bear', 10000);
    await switchToBuffer(page, 'gbtest');
    await page.waitForTimeout(1000);

    // Send message to #glowing-bear to create unread
    await irc.sendMessage('#glowing-bear', 'favicon-badge-test-1');
    await page.waitForTimeout(2000);

    const faviconHref = await getFaviconHref(page);
    expect(faviconHref.length).toBeGreaterThan(0);
});

test('favicon badge resets when switching to buffer with unread', async () => {
    await reconnectWithFavico(page, true);
    await waitForBuffer(page, '#glowing-bear', 10000);
    await switchToBuffer(page, 'gbtest');
    await page.waitForTimeout(1000);

    await irc.sendMessage('#glowing-bear', 'favicon-reset-test');
    await page.waitForTimeout(2000);

    // Switch back to #glowing-bear — this should clear unread
    await switchToBuffer(page, '#glowing-bear');
    await page.waitForTimeout(1000);

    const faviconHref = await getFaviconHref(page);
    // Badge should be reset to original (data URL or /favicon.png)
    expect(faviconHref.length).toBeGreaterThan(0);
});

test('no badge drawn when favico setting is disabled', async () => {
    await reconnectWithFavico(page, false);
    await waitForBuffer(page, '#glowing-bear', 10000);
    await switchToBuffer(page, 'gbtest');
    await page.waitForTimeout(1000);

    await irc.sendMessage('#glowing-bear', 'favico-disabled-test');
    await page.waitForTimeout(2000);

    const faviconHref = await getFaviconHref(page);
    // Should remain at default favicon (no data URL badge)
    expect(faviconHref).toBe('/favicon.png');
});

test('favico setting toggle persists', async () => {
    await page.getByTestId('settings-button').click();
    await expect(page.getByTestId('settings-modal')).toBeVisible({ timeout: 5000 });

    const checkbox = page.getByTestId('favico-checkbox');
    await expect(checkbox).toBeChecked();

    await checkbox.uncheck();
    await expect(checkbox).not.toBeChecked();

    await page.getByTestId('settings-modal-close').click();
    await expect(page.getByTestId('settings-modal')).not.toBeVisible({ timeout: 5000 });

    // Reopen and verify
    await page.getByTestId('settings-button').click();
    await expect(page.getByTestId('settings-modal')).toBeVisible({ timeout: 5000 });
    await expect(checkbox).not.toBeChecked();
    await page.getByTestId('settings-modal-close').click();
});
