import { test, expect } from '@playwright/test';
import { setSettings, reconnect, disconnect } from '../helpers/connection';
import { waitForBuffer, switchToBuffer } from '../helpers/buffers';
import { createConnectedPage } from '../fixtures/auth';

let page: import('@playwright/test').Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
    page = await createConnectedPage(browser, {
        settings: { savepassword: false, autoconnect: false },
    });
});

test.afterAll(async () => {
    await page.close();
});

test.beforeEach(async () => {
});

test('should restore last viewed buffer after reconnect', async () => {
    // Connect fresh (clearing gb-last-buffer to start clean)
    await reconnect(page);
    await waitForBuffer(page, '#glowing-bear', 15000);

    // Switch to #glowing-bear (non-default buffer — default is weechat core or first buffer)
    await switchToBuffer(page, '#glowing-bear');
    await expect(page.getByTestId('topic-bar')).toContainText('glowing-bear');

    // Verify gb-last-buffer was saved (stores fullName, e.g. "irc.gbtest.#glowing-bear")
    const savedBuffer = await page.evaluate(() => localStorage.getItem('gb-last-buffer'));
    expect(savedBuffer).not.toBeNull();
    expect(savedBuffer).toContain('glowing-bear');

    // Disconnect and reconnect, preserving gb-last-buffer
    await disconnect(page);
    await expect(page.getByTestId('host-input')).toBeVisible({ timeout: 15000 });

    // Reconnect while preserving the saved last buffer
    await setSettings(page, { savepassword: false, autoconnect: false });
    await page.getByTestId('host-input').fill('localhost');
    await page.getByTestId('port-input').fill('9001');
    await page.getByTestId('password-input').fill('testpassword123');
    await page.getByTestId('connect-button').click();
    await expect(page.getByTestId('chat-view')).toBeVisible({ timeout: 45000 });

    // The active buffer should be restored to #glowing-bear
    await waitForBuffer(page, '#glowing-bear', 15000);
    await expect(page.getByTestId('topic-bar')).toContainText('glowing-bear', { timeout: 10000 });

    // Verify the active buffer item is highlighted in the buffer list
    const activeItem = page.getByTestId('buffer-item')
        .filter({ hasText: 'glowing-bear' })
        .first();
    await expect(activeItem).toHaveClass(/border-s-accent/);
});

test('should restore last viewed buffer after disconnect/reconnect via helper', async () => {
    // Switch to gbtest server buffer (different from previous test's #glowing-bear)
    await switchToBuffer(page, 'gbtest');
    await expect(page.getByTestId('topic-bar')).toContainText('gbtest', { timeout: 10000 });

    // Use reconnect helper with preserveLastBuffer=true
    await reconnect(page, { preserveLastBuffer: true });
    await waitForBuffer(page, 'gbtest', 15000);

    // Should have restored to gbtest (the last viewed buffer before disconnect)
    await expect(page.getByTestId('topic-bar')).toContainText('gbtest', { timeout: 10000 });

    const activeItem = page.getByTestId('buffer-item')
        .filter({ hasText: 'gbtest' })
        .first();
    await expect(activeItem).toHaveClass(/border-s-accent/);
});

test('should fall back to weechat core when last viewed buffer no longer exists', async () => {
    // First do a clean reconnect (clearing saved last buffer) to establish known state
    await reconnect(page);
    await waitForBuffer(page, 'gbtest', 15000);

    // Switch to #glowing-bear and verify
    await switchToBuffer(page, '#glowing-bear');
    await expect(page.getByTestId('topic-bar')).toContainText('glowing-bear');

    // Manually set a non-existent fullName in localStorage to simulate
    // the case where the last-viewed buffer was closed/removed
    await page.evaluate(() => localStorage.setItem('gb-last-buffer', 'irc.nonexistent.#channel-12345'));

    // Disconnect and reconnect manually (not using helper, to preserve our fake value)
    await disconnect(page);
    await expect(page.getByTestId('host-input')).toBeVisible({ timeout: 15000 });
    await setSettings(page, { savepassword: false, autoconnect: false });
    await page.getByTestId('host-input').fill('localhost');
    await page.getByTestId('port-input').fill('9001');
    await page.getByTestId('password-input').fill('testpassword123');
    await page.getByTestId('connect-button').click();
    await expect(page.getByTestId('chat-view')).toBeVisible({ timeout: 45000 });

    // Should fall back to weechat core since saved buffer doesn't exist
    // Wait for topic bar to stabilize after buffer info + hotlist processing
    await waitForBuffer(page, 'weechat', 15000);
    await expect(page.getByTestId('topic-bar')).toContainText('weechat', { timeout: 10000 });
});
