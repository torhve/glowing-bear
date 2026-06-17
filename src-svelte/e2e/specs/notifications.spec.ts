import { test, expect } from '@playwright/test';
import { connectToWeechat, clearSettings, setSettings, waitForAppReady } from '../helpers/connection';
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
});

test.afterAll(async () => {
    await page.close();
});

test.beforeEach(async () => {
    page.on('pageerror', (error) => {
        if (error.message?.includes('effect_orphan')) return;
    });
});

async function openSettings() {
    await page.getByTestId('settings-button').click();
    await page.waitForTimeout(300);
}

async function closeSettings() {
    await page.getByTestId('settings-modal-close').click();
    await page.waitForTimeout(300);
}

test('notification settings section is visible in settings modal', async () => {
    await openSettings();
    const modal = page.getByTestId('settings-modal');
    await expect(modal).toBeVisible({ timeout: 5000 });
    await expect(modal.locator('text=Notifications')).toBeVisible();
    await expect(modal.locator('text=Display unread count in favicon')).toBeVisible();
    await expect(modal.locator('text=Play sound on notification')).toBeVisible();
    await closeSettings();
});

test('sound notification checkbox is checked by default', async () => {
    await openSettings();
    const checkbox = page.getByTestId('sound-checkbox');
    await expect(checkbox).toBeChecked();
    await closeSettings();
});

test('favico badge checkbox is checked by default', async () => {
    await openSettings();
    const checkbox = page.getByTestId('favico-checkbox');
    await expect(checkbox).toBeChecked();
    await closeSettings();
});

test('toggling sound notification setting persists', async () => {
    // Start with defaults
    await clearSettings(page);
    await page.reload();
    await connectToWeechat(page);

    await openSettings();
    const checkbox = page.getByTestId('sound-checkbox');
    await expect(checkbox).toBeChecked();

    // Uncheck
    await checkbox.uncheck();
    await expect(checkbox).not.toBeChecked();
    await closeSettings();

    // Re-open and verify it stayed unchecked
    await openSettings();
    await expect(checkbox).not.toBeChecked();
    await closeSettings();
});

test('toggling favico badge setting persists', async () => {
    await openSettings();
    const checkbox = page.getByTestId('favico-checkbox');
    await expect(checkbox).toBeChecked();

    await checkbox.uncheck();
    await expect(checkbox).not.toBeChecked();
    await closeSettings();

    await openSettings();
    await expect(checkbox).not.toBeChecked();
    await closeSettings();
});

test('document title updates with unread count on highlight', async () => {
    // Switch to the main channel buffer
    await page.getByTestId('buffer-item').first().click();
    await page.waitForTimeout(500);

    // Send a message that will trigger a notification (PM)
    await irc.sendPm('testuser', 'Highlight test message!');
    await page.waitForTimeout(2000);

    // Document title should include the unread count prefix
    const docTitle = await page.evaluate(() => document.title);
    expect(docTitle).toMatch(/\(\d+\)/);
    expect(docTitle).toContain('Glowing Bear');
});

test('sound plays when soundnotification is enabled', async () => {
    // Ensure soundnotification is enabled
    await setSettings(page, { soundnotification: true });
    await page.reload();
    await connectToWeechat(page);
    await page.waitForTimeout(1000);

    // Intercept Audio constructor calls
    await page.evaluate(() => {
        (window as any).__audioCalls = [];
        const OrigAudio = (window as any).Audio;
        (window as any).Audio = function (src: string) {
            (window as any).__audioCalls.push(src);
            return new OrigAudio(src);
        };
    });

    // Switch to channel buffer so PM triggers notification
    const firstItem = page.getByTestId('buffer-item').first();
    await firstItem.click();
    await page.waitForTimeout(500);

    // Send a PM (triggers notify_private → playNotificationSound)
    await irc.sendPm('testuser', 'Sound test message!');
    await page.waitForTimeout(2000);

    // Check that Audio was called with the sonar.mp3 path
    const audioCalls = await page.evaluate(() => (window as any).__audioCalls || []);
    expect(audioCalls).toContain('/assets/audio/sonar.mp3');
});

test('sound does NOT play when soundnotification is disabled', async () => {
    // Disable soundnotification via localStorage
    await setSettings(page, { soundnotification: false });
    await page.reload();
    await connectToWeechat(page);
    await page.waitForTimeout(1000);

    // Intercept Audio constructor calls
    await page.evaluate(() => {
        (window as any).__audioCalls = [];
        const OrigAudio = (window as any).Audio;
        (window as any).Audio = function (src: string) {
            (window as any).__audioCalls.push(src);
            return new OrigAudio(src);
        };
    });

    // Switch to channel buffer so PM triggers notification
    const firstItem = page.getByTestId('buffer-item').first();
    await firstItem.click();
    await page.waitForTimeout(500);

    // Send a PM (should NOT trigger playNotificationSound because setting is off)
    await irc.sendPm('testuser', 'No sound test message!');
    await page.waitForTimeout(2000);

    // Verify Audio was NOT called
    const audioCalls = await page.evaluate(() => (window as any).__audioCalls || []);
    expect(audioCalls).not.toContain('/assets/audio/sonar.mp3');
});

test('notification permission button exists and is clickable when default', async () => {
    await openSettings();
    const button = page.getByTestId('request-notification-permission-button');
    await expect(button).toBeVisible();
    await expect(button).toHaveText('Request Notification Permission');

    // Clicking should attempt to request permission (may be blocked in headless)
    await button.click();
    // Just verify the click doesn't throw an error
    await page.waitForTimeout(500);
    await closeSettings();
});

test('notification permission granted status displays correctly', async () => {
    await setSettings(page, { notificationPermission: 'granted' });
    await page.reload();
    await connectToWeechat(page);

    await openSettings();
    await expect(page.locator('text=✓ Granted')).toBeVisible();
    const button = page.getByTestId('request-notification-permission-button');
    await expect(button).not.toBeVisible();
    await closeSettings();
});

test('notification permission denied status displays helpful message', async () => {
    await setSettings(page, { notificationPermission: 'denied' });
    await page.reload();
    await connectToWeechat(page);

    await openSettings();
    await expect(page.locator('text=✕ Denied')).toBeVisible();
    await expect(page.locator('text=Please enable notifications in your browser settings')).toBeVisible();
    const button = page.getByTestId('request-notification-permission-button');
    await expect(button).not.toBeVisible();
    await closeSettings();
});

test('no notification toast when permission already granted', async () => {
    await setSettings(page, { notificationPermission: 'granted' });
    await page.reload();
    await connectToWeechat(page);
    await page.waitForTimeout(1000);

    const toasts = page.getByTestId('toast');
    const notificationToastCount = await toasts.filter({ hasText: /notification/i }).count();
    expect(notificationToastCount).toBe(0);
});
