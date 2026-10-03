import { test, expect } from '@playwright/test';
import { createConnectedPage } from '../fixtures/auth';
import { switchToBuffer } from '../helpers/buffers';
import { botSay, botPm } from '../helpers/messages';

let page: import('@playwright/test').Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
    page = await createConnectedPage(browser);
});

test.afterAll(async () => {
    await page.close();
});

// Helper: dispatch Alt+A keydown event at the document level (matches +page.svelte handler)
async function pressAltA() {
    await page.evaluate(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', {
            altKey: true,
            code: 'KeyA',
            key: 'a',
            keyCode: 97,
            bubbles: true
        }));
    });
}

// Helper: get current buffer name from topic bar
async function getCurrentBufferName(): Promise<string> {
    const topicBar = page.getByTestId('topic-bar');
    return await topicBar.textContent();
}

// Helper: find a PM buffer locator in the buffer list (gbbot PMs create buffers like "gbbot" or "gbbot1")
// Polls until found or timeout — relay propagation can take time.
async function waitForPmBuffer(timeoutMs = 15000): Promise<import('@playwright/test').Locator | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const items = page.getByTestId('buffer-item');
        const count = await items.count();
        for (let i = 0; i < count; i++) {
            const text = await items.nth(i).textContent();
            if (text && /gbbot/.test(text)) {
                return items.nth(i);
            }
        }
        await page.waitForTimeout(500);
    }
    return null;
}

// Test 1: Alt+A prioritizes notification buffers over plain unread buffers.
// Strategy: send a plain message to #glowing-bear (unread) and a PM from gbbot (notification).
// PMs generate notification counts because they're direct messages to the user.
test('Alt+A prioritizes notification buffers over plain unread buffers', async () => {
    // Start on server buffer so we don't accidentally clear any buffer's activity by switching
    await switchToBuffer(page, 'gbtest');

    // Send a plain message to #glowing-bear → generates unread count
    await botSay('plain-unread-message-' + Date.now());

    // Send a PM from gbbot to testuser → generates notification count (PMs are always highlights)
    await botPm('pm-notification-test-' + Date.now());

    // Wait for the PM buffer to appear in the buffer list (relay propagation can be very slow)
    const pmItem = await waitForPmBuffer(30000);
    expect(pmItem, 'PM buffer should appear').not.toBeNull();

    // Wait for hotlist sync (debounced at 2 s) to propagate counts — observable
    // as unread badges on both activity buffers in the buffer list.
    await expect(async () => {
        await expect(
            page.getByTestId('buffer-item').filter({ hasText: 'glowing-bear' }).getByTestId('unread-badge'),
        ).toBeVisible();
        // Any gbbot PM buffer with a badge (a fresh PM may open a numbered
        // buffer alongside a stale read one from earlier tests).
        await expect(
            page
                .getByTestId('buffer-item')
                .filter({ hasText: /gbbot/ })
                .filter({ has: page.getByTestId('unread-badge') })
                .first(),
        ).toBeVisible();
    }).toPass({ timeout: 15000 });

    // Stay on server buffer — both other buffers have activity and none is cleared

    // Press Alt+A — should jump to the PM buffer (notification > unread by priority)
    await pressAltA();
    await expect(page.getByTestId('topic-bar')).toContainText('gbbot', { timeout: 5000 });

    // Switch back to server so we don't clear #glowing-bear's unread
    await switchToBuffer(page, 'gbtest');

    // Press Alt+A again — should jump to #glowing-bear (next most urgent: plain unread)
    await pressAltA();
    await expect(page.getByTestId('topic-bar')).toContainText('glowing-bear', { timeout: 5000 });

    // Switch back to server so we don't clear remaining buffers
    await switchToBuffer(page, 'gbtest');

    // Press Alt+A a third time — no more active buffers, should stay on server
    await pressAltA();
    await page.waitForTimeout(500);
    const afterThirdPress = await getCurrentBufferName();
    expect(afterThirdPress).toContain('gbtest');
});

// Test 3: Alt+A works even when focus is in the input bar.
// On macOS, Alt+A produces dead key characters (e.g., "ä") if not intercepted.
// This test verifies the global handler catches Alt+A regardless of input focus
// and prevents the dead key character from being typed.
test('Alt+A works from the input bar without typing dead key characters', async () => {
    // Start on server buffer
    await switchToBuffer(page, 'gbtest');

    // Send a message to #glowing-bear to create unread activity — wait for the
    // unread badge to appear instead of a fixed sleep.
    await botSay('unread-from-inputbar-' + Date.now());
    await expect(
        page.getByTestId('buffer-item').filter({ hasText: 'glowing-bear' }).getByTestId('unread-badge'),
    ).toBeVisible({ timeout: 10000 });

    // Focus the input bar
    await page.getByTestId('message-input').focus();
    await page.waitForTimeout(100);

    // Verify input is focused
    const activeBefore = await page.evaluate(() => document.activeElement?.tagName || '');
    expect(activeBefore).toBe('TEXTAREA');

    // Verify input is empty before
    const valueBefore = await page.getByTestId('message-input').inputValue();
    expect(valueBefore).toBe('');

    // Press Alt+A while input is still focused
    await pressAltA();
    await expect(page.getByTestId('topic-bar')).toContainText('glowing-bear', { timeout: 5000 });

    // Input should still be empty — no dead key character typed
    const valueAfter = await page.getByTestId('message-input').inputValue();
    expect(valueAfter, 'No dead key character should be typed into the input').toBe('');
});

// Test 4: Alt+A is a no-op when no buffers have activity
test('Alt+A does nothing when no buffers have unread or notification counts', async () => {
    // Switch to each buffer that might have leftover activity from previous test, clearing counts
    await switchToBuffer(page, '#glowing-bear');
    await switchToBuffer(page, 'gbtest');

    // Also clear any PM buffers
    const pmItem = await waitForPmBuffer(5000);
    if (pmItem) {
        await pmItem.click();
        await expect(page.getByTestId('topic-bar')).toContainText('gbbot', { timeout: 5000 });
    }

    // Switch back to server buffer
    await switchToBuffer(page, 'gbtest');

    // Press Alt+A — should be a no-op since all buffers are read
    const beforeName = await getCurrentBufferName();
    await pressAltA();
    await page.waitForTimeout(500);
    const afterName = await getCurrentBufferName();
    expect(afterName).toEqual(beforeName);
});
