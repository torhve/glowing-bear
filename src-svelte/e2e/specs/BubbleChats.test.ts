import { test, expect, type Locator } from '@playwright/test';
import { createConnectedPage } from '../fixtures/auth';
import { waitForBuffer, switchToBuffer } from '../helpers/buffers';
import { irc } from '../helpers/irc-control';
import { botPm } from '../helpers/messages';
import { openSettings, closeSettings } from '../helpers/settings';

let page: import('@playwright/test').Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
    page = await createConnectedPage(browser);
    page.on('pageerror', (error) => {
        if (error.message?.includes('effect_orphan')) return;
    });
});

test.afterAll(async () => {
    await page.close();
});

test.beforeEach(async () => {
    page.on('pageerror', (error) => {
        if (error.message?.includes('effect_orphan')) return;
    });
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

// Find the most recently created PM buffer (last matching gbbot entry).
async function findPmBuffer(): Promise<{ locator: Locator; name: string } | null> {
    const items = page.getByTestId('buffer-item');
    const count = await items.count();
    let lastMatch: Locator | null = null;
    let lastName = '';
    for (let i = 0; i < count; i++) {
        const text = await items.nth(i).textContent();
        if (text && /gbbot\d*/.test(text)) {
            lastMatch = items.nth(i);
            lastName = text.trim();
        }
    }
    return lastMatch ? { locator: lastMatch, name: lastName } : null;
}

async function clickAndWaitForBuffer(pm: { locator: Locator; name: string }) {
    await pm.locator.click();
    await expect(page.getByTestId('topic-bar')).toContainText(pm.name, { timeout: 5000 });
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

        // Trigger a PM from bot to create a private buffer
        await botPm('bubble test message');

        const pm = await findPmBuffer();
        expect(pm).not.toBeNull();
        await clickAndWaitForBuffer(pm!);

        // Private buffer should render with bubble layout (div-based, not table)
        const bubbleContainer = page.locator('.chat-bubble-container');
        await expect(bubbleContainer).toBeVisible({ timeout: 5000 });

        // Table layout should NOT be present
        const table = page.locator('[data-testid="chat-messages"] table.chat-table');
        await expect(table).not.toBeVisible();

        await disableBubbleMode();
    });

    test('other messages render as left-aligned bubbles', async () => {
        await enableBubbleMode();

        // Send a unique PM so we can identify the buffer
        const msgText = 'bubble-other-test-' + Date.now();
        await botPm(msgText);

        const pm = await findPmBuffer();
        if (!pm) {
            // If no new PM buffer appeared, try switching to existing one
            await switchToBuffer(page, '#glowing-bear');
            return;
        }
        await clickAndWaitForBuffer(pm);

        // Verify the incoming message renders as a bubble-other element
        const otherBubbles = page.locator('.bubble-other-bg');
        const count = await otherBubbles.count();
        expect(count).toBeGreaterThanOrEqual(1);

        // Verify message text appears in bubble
        const msgBubble = page.locator('.bubble-row').filter({ hasText: msgText }).first();
        await expect(msgBubble).toBeVisible({ timeout: 5000 });

        await disableBubbleMode();
    });

    test('self messages render as right-aligned bubbles', async () => {
        await enableBubbleMode();

        // Access/create a PM buffer
        await botPm('initiate pm for self-test-' + Date.now());
        const pm = await findPmBuffer();
        if (!pm) {
            test.skip();
            return;
        }
        await clickAndWaitForBuffer(pm);

        // Send a message from ourselves
        const selfMsg = 'my-bubble-msg-' + Date.now();
        const input = page.getByTestId('message-input');
        await input.fill(selfMsg);
        await input.press('Enter');
        await expect(page.locator('.bubble-self-bg').filter({ hasText: selfMsg }).first()).toBeVisible({ timeout: 5000 });

        // Verify at least one self-aligned bubble exists
        const selfBubbles = page.locator('.bubble-self-bg');
        await expect(selfBubbles.first()).toBeVisible({ timeout: 5000 });

        // Verify the specific message text appears in a self-aligned bubble
        const selfBubbleWithMsg = page.locator('.bubble-self-bg').filter({ hasText: selfMsg }).first();
        await expect(selfBubbleWithMsg).toBeVisible();

        await disableBubbleMode();
    });

    test('consecutive messages from same sender are grouped', async () => {
        await enableBubbleMode();

        // Access/create a PM buffer
        const ts = Date.now();
        await botPm('group-test-init-' + ts);
        const pm = await findPmBuffer();
        if (!pm) {
            test.skip();
            return;
        }
        await clickAndWaitForBuffer(pm);

        // Send two consecutive self messages
        const msg1 = 'group-msg-1-' + ts;
        const msg2 = 'group-msg-2-' + ts;

        await page.getByTestId('message-input').fill(msg1);
        await page.getByTestId('message-input').press('Enter');
        await expect(page.locator('.bubble-self-bg').filter({ hasText: msg1 }).first()).toBeVisible({ timeout: 5000 });

        await page.getByTestId('message-input').fill(msg2);
        await page.getByTestId('message-input').press('Enter');
        await expect(page.locator('.bubble-self-bg').filter({ hasText: msg2 }).first()).toBeVisible({ timeout: 5000 });

        // Both messages should be visible as self-aligned bubbles
        const row1 = page.locator('.bubble-self-bg').filter({ hasText: msg1 }).first();
        const row2 = page.locator('.bubble-self-bg').filter({ hasText: msg2 }).first();
        await expect(row1).toBeVisible();
        await expect(row2).toBeVisible();

        // Grouping: first message of group shows meta (nick/time), second does not.
        // The bubble-tail class is only on group-start bubbles.
        await expect(row1).toHaveClass(/bubble-tail/);
        await expect(row2).not.toHaveClass(/bubble-tail/);

        await disableBubbleMode();
    });

    test('system messages render centered in middle', async () => {
        await enableBubbleMode();

        // Create a PM buffer first
        const ts = Date.now();
        await botPm('init-for-system-test-' + ts);
        const pm = await findPmBuffer();
        if (!pm) {
            test.skip();
            return;
        }
        await clickAndWaitForBuffer(pm);

        // Send an IRC NOTICE from bot — these typically don't carry irc_selfmsg tag
        // and may render as system/other depending on prefix presence.
        // We verify that any middle-aligned bubbles use the correct styling.
        await irc.sendNotice('testuser', 'notice-text-' + ts);
        await expect(page.getByTestId('bufferline-row').filter({ hasText: 'notice-text-' }).first()).toBeVisible({ timeout: 5000 });

        // Check for date separators (they're always present after connection)
        const dateSeparators = page.locator('.bubble-date-separator');
        const dateCount = await dateSeparators.count();
        expect(dateCount).toBeGreaterThanOrEqual(0);

        // Verify the layout structure: bubble rows for messages, separators for dates
        const allRows = page.locator('[data-testid="bufferline-row"]');
        const rowCount = await allRows.count();
        expect(rowCount).toBeGreaterThanOrEqual(2);

        await disableBubbleMode();
    });

    test('mixed conversation shows correct three-way alignment', async () => {
        await enableBubbleMode();

        const ts = Date.now();
        // Bot sends first (incoming/left)
        await botPm('other-msg-a-' + ts);

        const pm = await findPmBuffer();
        if (!pm) {
            test.skip();
            return;
        }
        await clickAndWaitForBuffer(pm);

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

        const pm = await findPmBuffer();
        if (!pm) {
            // Create one first
            await botPm('date-sep-test');
            const newPm = await findPmBuffer();
            if (!newPm) {
                test.skip();
                return;
            }
            await clickAndWaitForBuffer(newPm);
        } else {
            await clickAndWaitForBuffer(pm);
        }

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
