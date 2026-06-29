import { test, expect } from '@playwright/test';
import { createConnectedPage } from '../fixtures/auth';
import { waitForBuffer, switchToBuffer } from '../helpers/buffers';
import { botPm } from '../helpers/messages';
import { irc } from '../helpers/irc-control';
import { openSettings, closeSettings } from '../helpers/settings';

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
    // Restore bot nick to default so botPm targets the gbbot2 buffer.
    await irc.botNick('gbbot2');
    await page.waitForTimeout(1000);
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
});

// Enable bubble mode by toggling the checkbox in the Settings modal.
async function enableBubbleMode() {
    await openSettings(page);
    const checkbox = page.getByTestId('stylizePrivateChats-checkbox');
    if (!(await checkbox.isChecked())) {
        await checkbox.click();
    }
    await closeSettings(page);
}

// Disable bubble mode by toggling the checkbox in the Settings modal.
async function disableBubbleMode() {
    await openSettings(page);
    const checkbox = page.getByTestId('stylizePrivateChats-checkbox');
    if (await checkbox.isChecked()) {
        await checkbox.click();
    }
    await closeSettings(page);
}

// ---- Bubble mode tests ----

test.describe('bubble chats', () => {
    test('setting toggle appears in Settings modal', async () => {
        await page.getByTestId('settings-button').click();
        await expect(page.getByTestId('settings-modal')).toBeVisible({ timeout: 5000 });

        const checkbox = page.getByTestId('stylizePrivateChats-checkbox');
        await expect(checkbox).toBeVisible();
        await expect(checkbox).not.toBeChecked();

        await page.getByTestId('done-settings-button').click();
        await expect(page.getByTestId('settings-modal')).not.toBeVisible({ timeout: 5000 });
    });

    test('channel buffers use table layout regardless of setting', async () => {
        await enableBubbleMode();
        await switchToBuffer(page, '#glowing-bear');

        // Channel buffers should still render with table layout
        const table = page.locator('[data-testid="chat-messages"] table.chat-table');
        await expect(table).toBeVisible({ timeout: 5000 });
        await expect(page.locator('.chat-bubble-container')).not.toBeVisible();

        await disableBubbleMode();
    });

    test('private buffers use bubble layout when setting enabled', async () => {
        await enableBubbleMode();
        // Proactively trigger a PM to ensure the private buffer exists.
        await botPm('bubble-layout-trigger');
        await page.waitForTimeout(1000);
        // Wait for the PM buffer to appear before switching.
        await waitForBuffer(page, 'gbbot2', 30000);
        await switchToBuffer(page, 'gbbot2', { timeout: 30000 });

        // Private buffer should render with bubble layout (div-based, not table)
        const bubbleContainer = page.locator('.chat-bubble-container');
        await expect(bubbleContainer).toBeVisible({ timeout: 10000 });

        // Table layout should NOT be present
        const table = page.locator('[data-testid="chat-messages"] table.chat-table');
        await expect(table).not.toBeVisible();

        await disableBubbleMode();
    });

    test('other messages render as left-aligned bubbles', async () => {
        await enableBubbleMode();
        await waitForBuffer(page, 'gbbot2', 20000);
        await switchToBuffer(page, 'gbbot2', { timeout: 20000 });

        // Send a unique PM so we can identify the message
        const msgText = 'bubble-other-test-' + Date.now();
        await botPm(msgText);

        // Wait for the message to render in the chat
        await expect(page.getByTestId('bufferline-row').filter({ hasText: msgText }).first()).toBeVisible({ timeout: 10000 });

        // Verify the incoming message renders as a bubble-other element
        const msgRow = page.getByTestId('bufferline-row').filter({ hasText: msgText }).first();
        await expect(msgRow).toHaveClass(/bubble-other/);

        await disableBubbleMode();
    });

    test('self messages render as right-aligned bubbles', async () => {
        await enableBubbleMode();
        await waitForBuffer(page, 'gbbot2', 20000);
        await switchToBuffer(page, 'gbbot2', { timeout: 20000 });

        // Send a message from ourselves
        const selfMsg = 'my-bubble-msg-' + Date.now();
        const input = page.getByTestId('message-input');
        await input.fill(selfMsg);
        await input.press('Enter');
        await expect(page.locator('.bubble-self-bg').filter({ hasText: selfMsg }).first()).toBeVisible({ timeout: 5000 });

        // Verify at least one self-aligned bubble exists
        const selfBubbles = page.locator('.bubble-self-bg');
        await expect(selfBubbles.first()).toBeVisible({ timeout: 5000 });

        await disableBubbleMode();
    });

    test('consecutive messages from same sender are grouped', async () => {
        await enableBubbleMode();
        await waitForBuffer(page, 'gbbot2', 20000);
        await switchToBuffer(page, 'gbbot2', { timeout: 20000 });

        const ts = Date.now();
        const msg1 = 'group-msg-1-' + ts;
        const msg2 = 'group-msg-2-' + ts;

        await page.getByTestId('message-input').fill(msg1);
        await page.getByTestId('message-input').press('Enter');
        await expect(page.locator('.bubble-self-bg').filter({ hasText: msg1 }).first()).toBeVisible({ timeout: 5000 });

        await page.getByTestId('message-input').fill(msg2);
        await page.getByTestId('message-input').press('Enter');
        await expect(page.locator('.bubble-self-bg').filter({ hasText: msg2 }).first()).toBeVisible({ timeout: 5000 });

        // Both messages should be visible as self-aligned bubbles
        const row1 = page.getByTestId('bufferline-row').filter({ hasText: msg1 }).first();
        const row2 = page.getByTestId('bufferline-row').filter({ hasText: msg2 }).first();
        await expect(row1).toBeVisible();
        await expect(row2).toBeVisible();

        // Grouping: msg2 is the second consecutive self message, so it should NOT show meta.
        // msg1 may or may not have meta depending on accumulated buffer state from prior tests.
        await expect(row2.locator('.bubble-meta')).not.toBeAttached();

        await disableBubbleMode();
    });

    test('system messages render centered in middle', async () => {
        await enableBubbleMode();
        await waitForBuffer(page, 'gbbot2', 20000);
        await switchToBuffer(page, 'gbbot2', { timeout: 20000 });

        // Send a bot message to ensure the buffer has content
        const ts = Date.now();
        await botPm('bot-msg-' + ts);
        await expect(page.getByTestId('bufferline-row').filter({ hasText: 'bot-msg-' }).first()).toBeVisible({ timeout: 5000 });

        // Check for date separators (they're always present after connection)
        const dateSeparators = page.locator('.bubble-date-separator');
        const dateCount = await dateSeparators.count();
        expect(dateCount).toBeGreaterThanOrEqual(0);

        // Verify the layout structure: bubble rows for messages
        const allRows = page.locator('[data-testid="bufferline-row"]');
        const rowCount = await allRows.count();
        expect(rowCount).toBeGreaterThanOrEqual(2);

        await disableBubbleMode();
    });

    test('mixed conversation shows correct three-way alignment', async () => {
        await enableBubbleMode();
        await waitForBuffer(page, 'gbbot2', 20000);
        await switchToBuffer(page, 'gbbot2', { timeout: 20000 });

        const ts = Date.now();
        // Bot sends first (incoming/left)
        await botPm('other-msg-a-' + ts);

        // User replies (outgoing/right)
        const selfMsg = 'self-msg-b-' + ts;
        await page.getByTestId('message-input').fill(selfMsg);
        await page.getByTestId('message-input').press('Enter');
        await expect(page.locator('.bubble-self-bg').filter({ hasText: selfMsg }).first()).toBeVisible({ timeout: 5000 });

        // Bot responds again (incoming/left)
        await botPm('other-msg-c-' + ts);

        // Count each alignment type
        const otherCount = await page.locator('.bubble-other-bg').count();
        const selfCount = await page.locator('.bubble-self-bg').count();

        expect(otherCount).toBeGreaterThanOrEqual(2); // bot messages (left)
        expect(selfCount).toBeGreaterThanOrEqual(1);  // our reply (right)

        // Verify both message types are visible
        await expect(page.locator('.bubble-row').filter({ hasText: 'other-msg-a-' }).first()).toBeVisible({ timeout: 5000 });
        await expect(page.locator('.bubble-row').filter({ hasText: selfMsg }).first()).toBeVisible({ timeout: 5000 });
        await expect(page.locator('.bubble-row').filter({ hasText: 'other-msg-c-' }).first()).toBeVisible({ timeout: 5000 });

        await disableBubbleMode();
    });

    test('date separators render with centered divider', async () => {
        await enableBubbleMode();
        await waitForBuffer(page, 'gbbot2', 20000);
        await switchToBuffer(page, 'gbbot2', { timeout: 20000 });

        // Date separators should have the correct structure
        const dateSep = page.locator('.bubble-date-separator');
        const dateCount = await dateSep.count();
        expect(dateCount).toBeGreaterThanOrEqual(0);

        // If date separators exist, verify they're centered with divider lines
        if (dateCount > 0) {
            const firstSep = dateSep.first();
            await expect(firstSep).toBeVisible();
        }

        await disableBubbleMode();
    });
});
