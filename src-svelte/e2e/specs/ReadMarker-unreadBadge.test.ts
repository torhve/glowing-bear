import { test, expect } from '@playwright/test';
import { createConnectedPage } from '../fixtures/auth';
import { waitForBuffer, switchToBuffer } from '../helpers/buffers';
import { irc } from '../helpers/irc-control';

let page: import('@playwright/test').Page;
const consoleLogs: string[] = [];

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
    page = await createConnectedPage(browser);
    page.on('console', msg => {
        const text = `[${msg.type()}] ${msg.text()}`;
        consoleLogs.push(text);
    });
    page.on('pageerror', (error) => {
        if (error.message?.includes('effect_orphan')) return;
        consoleLogs.push(`[ERROR] ${error.message}`);
    });
});

test.afterAll(async () => {
    console.log('\n\n========== CONSOLE LOG SUMMARY ==========');
    console.log('Total console messages:', consoleLogs.length);
    const relevant = consoleLogs.filter(l =>
        l.includes('[setActiveBuffer]') ||
        l.includes('[buffer switch]') ||
        l.includes('unread=') ||
        l.includes('localUnread')
    );
    console.log(`\nRelevant protocol/model logs (${relevant.length}):`);
    relevant.forEach(l => console.log(l));
    await page.close();
});

test.beforeEach(async () => {
    consoleLogs.length = 0;
    page.on('pageerror', (error) => {
        if (error.message?.includes('effect_orphan')) return;
    });
});

// When switching to an inactive buffer that received messages while we were away,
// the readmarker should appear at the correct position. This tests that setActiveBuffer
// correctly calculates lastSeen using localUnread (real-time messages received while
// inactive). Previously, localUnread was ignored in totalUnread calculation.
test('readmarker appears when switching back after receiving messages elsewhere', async () => {
    // Wait for #glowing-bear to appear
    await waitForBuffer(page, '#glowing-bear', 15000);

    // Switch to gbtest so we're NOT on #glowing-bear when messages arrive
    await waitForBuffer(page, 'gbtest', 10000);
    await switchToBuffer(page, 'gbtest');

    // Bot sends messages to #glowing-bear while we're on another buffer
    await irc.sendMessage('#glowing-bear', 'unread-badge-test msg-1-' + Date.now());
    await irc.sendMessage('#glowing-bear', 'unread-badge-test msg-2-' + Date.now());
    await irc.sendMessage('#glowing-bear', 'testuser: and a highlight for good measure' + Date.now());

    // Wait for messages to be processed and console logs to appear
    await page.waitForTimeout(2000);

    // Verify console logged unread counts before switch
    const preSwitchLogs = consoleLogs.filter(l => l.includes('#glowing-bear'));
    expect(preSwitchLogs.length).toBeGreaterThan(0);

    // Switch back to #glowing-bear — readmarker should appear
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');

    // Wait for setActiveBuffer console log
    await page.waitForTimeout(500);

    const postSwitchLogs = consoleLogs.filter(l => l.includes('[setActiveBuffer]'));
    expect(postSwitchLogs.length).toBeGreaterThan(0);

    // Console should show the buffer state with unread/localUnread values
    const activeBufferLog = postSwitchLogs.find(l => l.includes('#glowing-bear'));
    expect(activeBufferLog).toBeDefined();

    // Readmarker should be visible
    const readmarker = page.getByTestId('readmarker');
    await expect(readmarker).toBeVisible();
});

// After scrolling to bottom (marking as fully read) and then receiving more messages
// while away, the readmarker should still appear correctly on return.
test('readmarker appears after scroll-to-bottom followed by new unreads', async () => {
    await waitForBuffer(page, '#glowing-bear', 15000);

    // Ensure we're on #glowing-bear and at bottom
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');

    // Scroll to bottom to mark as fully read
    const chatContainer = page.locator('[data-testid="chat-messages"]');
    await chatContainer.evaluate((el) => {
        (el as HTMLElement).scrollTop = (el as HTMLElement).scrollHeight;
    });

    // Switch away to receive messages elsewhere
    await waitForBuffer(page, 'gbtest', 10000);
    await switchToBuffer(page, 'gbtest');

    // Bot sends new messages to #glowing-bear
    await irc.sendMessage('#glowing-bear', 'unread-scroll-test msg-' + Date.now());

    // Wait for message processing
    await page.waitForTimeout(2000);

    // Verify console logged unread counts before switch
    const preSwitchLogs = consoleLogs.filter(l => l.includes('#glowing-bear'));
    expect(preSwitchLogs.length).toBeGreaterThan(0);

    // Switch back — readmarker should appear again
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');

    // Wait for setActiveBuffer console log
    await page.waitForTimeout(500);

    const postSwitchLogs = consoleLogs.filter(l => l.includes('[setActiveBuffer]'));
    expect(postSwitchLogs.length).toBeGreaterThan(0);

    const readmarker = page.getByTestId('readmarker');
    await expect(readmarker).toBeVisible();

    // Verify there are unread lines below the readmarker
    // Count bufferline-rows that appear AFTER the readmarker in DOM order.
    // Using nextElementSibling chain instead of index arithmetic, since the
    // tbody contains mixed row types (fetchmore, readmarker, bufferline) and
    // index-based formulas break when non-bufferline rows precede the readmarker.
    const state = await page.evaluate(() => {
        const el = document.querySelector('[data-testid="chat-messages"]') as HTMLElement;
        if (!el) return null;
        const rm = el.querySelector('.readmarker');
        if (!rm) return { hasReadmarker: false, linesBelowReadmarker: -1 };

        let count = 0;
        let sibling = rm.nextElementSibling;
        while (sibling) {
            if (sibling.hasAttribute('data-testid') && (sibling as HTMLElement).getAttribute('data-testid') === 'bufferline-row') {
                count++;
            }
            sibling = sibling.nextElementSibling;
        }
        return {
            hasReadmarker: true,
            linesBelowReadmarker: count,
        };
    });

    expect(state?.hasReadmarker).toBe(true);
    expect(state?.linesBelowReadmarker).toBeGreaterThan(0);
});

// Verify that unread counts on OTHER buffers (not the one we switched to)
// are not corrupted by the setActiveBuffer immutable update.
test('other buffer unread counts preserved when switching active buffer', async () => {
    await waitForBuffer(page, '#glowing-bear', 15000);

    // Switch to gbtest so #glowing-bear is inactive
    await waitForBuffer(page, 'gbtest', 10000);
    await switchToBuffer(page, 'gbtest');

    // Send messages to #glowing-bear (creates unread)
    await irc.sendMessage('#glowing-bear', 'other-buffer-count-test-' + Date.now());

    // Wait for message processing and hotlist sync
    await page.waitForTimeout(6000);

    // Verify console logged unread counts
    const preSwitchLogs = consoleLogs.filter(l => l.includes('#glowing-bear'));
    expect(preSwitchLogs.length).toBeGreaterThan(0);

    // Wait for the unread badge to actually appear in the buffer list
    const glowItem = page.getByTestId('buffer-item').filter({ hasText: 'glowing-bear' }).first();
    await expect(glowItem).toBeVisible({ timeout: 10000 });
    // Badge is positioned absolutely on the right edge of the buffer item
    // Wait up to 8s for hotlist sync (hotlist polls every 15s)
    await glowItem.getByTestId('unread-badge').waitFor({ state: 'visible', timeout: 8000 });

    // Read unread badge text for #glowing-bear from the DOM before second switch.
    const getUnreadBadge = async (name: string) => {
        return (await page.getByTestId('buffer-item').filter({ hasText: name }).first().getByTestId('unread-badge').textContent()) || '';
    };

    const beforeText = await getUnreadBadge('glowing-bear');
    const beforeTotal = parseInt(beforeText, 10) || 0;

    // Console should show matching unread count
    const unreadLog = preSwitchLogs.find(l => l.includes('unread=') && l.includes('#glowing-bear'));
    if (unreadLog) {
        console.log('[DIAG] Badge DOM shows:', beforeTotal, '| Console log:', unreadLog);
    }

    // Now switch to a different buffer (not #glowing-bear)
    const otherItems = page.locator('[data-testid="buffer-item"]').filter({ hasNotText: 'glowing-bear' });
    const otherCount = await otherItems.count();
    if (otherCount > 1) {
        await otherItems.nth(1).click();

        // Wait for setActiveBuffer console log
        await page.waitForTimeout(500);

        const postSwitchLogs = consoleLogs.filter(l => l.includes('[setActiveBuffer]'));
        expect(postSwitchLogs.length).toBeGreaterThan(0);

        // Read unread badge text for #glowing-bear after switching away
        const afterText = await getUnreadBadge('glowing-bear');
        const afterTotal = parseInt(afterText, 10) || 0;

        // The total unread should be preserved (not zeroed by setActiveBuffer for non-active buffers)
        expect(beforeTotal).toBeGreaterThan(0);
        expect(afterTotal).toBeGreaterThan(0);
    } else {
        test.skip(true, 'Need at least 2 non-glowing-bear buffers for this test');
    }
});
