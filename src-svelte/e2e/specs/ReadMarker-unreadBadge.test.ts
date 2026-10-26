import { test, expect } from '@playwright/test';
import { createConnectedPage } from '../fixtures/auth';
import { waitForBuffer, switchToBuffer } from '../helpers/buffers';
import { disconnect, reconnect } from '../helpers/connection';
import { irc } from '../helpers/irc-control';
import { closeSpecChatChannel, openSpecChatChannel } from '../helpers/spec-chat-channel';
import { readUnreadBadge, waitForBotNickApplied, waitForNoUnread } from '../helpers/waits';

import { setupEffectOrphanFilter } from '../helpers/pageerror';

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
    // The status lines this file plants are real `PART` lines and WeeChat honours them, so the
    // shared bot leaves `#glowing-bear`'s nicklist: measured afterwards the legacy transport's
    // nicklist held only `testuser` and `testuser5`, and `Dual-protocol`'s nick completion produced
    // no replacement at all. Put the bot back and prove it, or every later spec in the pass runs
    // against a channel this file emptied.
    await irc.botJoin('#glowing-bear');
    const members = await irc.channelMembers('#glowing-bear');
    if (!members.some((nick) => nick.startsWith('gbb'))) {
        throw new Error(
            `afterAll could not return the fixture bot to #glowing-bear; members are ${members.join(', ') || '(none)'}`,
        );
    }
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

async function waitForConsoleLog(pattern: string, timeout = 10000) {
    await expect(async () => {
        const found = consoleLogs.some(l => l.includes(pattern));
        expect(found).toBe(true);
    }).toPass({ timeout });
}

test.beforeEach(async () => {
    consoleLogs.length = 0;
    setupEffectOrphanFilter(page)
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

    // Wait for the unread badge on #glowing-bear (messages arrived and tallied)
    const gbItem = page.getByTestId('buffer-item').filter({ has: page.locator('.buffer-name').filter({ hasText: /^glowing-bear$/ }) }).first();
    await expect(gbItem.getByTestId('unread-badge')).toBeVisible({ timeout: 10000 });

    // Switch back to #glowing-bear — readmarker should appear
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');

    // Wait for setActiveBuffer console log
    await waitForConsoleLog('[setActiveBuffer]');

    // Console should show the buffer state with unread/localUnread values
    const activeBufferLog = consoleLogs.find(l => l.includes('[setActiveBuffer]') && l.includes('#glowing-bear'));
    expect(activeBufferLog).toBeDefined();

    // Readmarker should be visible
    const readmarker = page.getByTestId('readmarker');
    await expect(readmarker).toBeVisible();
});

// Status lines are deliberately interleaved with user messages. The readmarker must
// follow the displayed unread boundary, while the badge counts only actual user lines.
test('places the marker before interleaved unread status lines and counts six messages', async () => {
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');

    // WeeChat renders a JOIN/PART line only for the nick it currently holds, and this test plants
    // them under a hardcoded `gbbot` prefix, so the nick is pinned here rather than inherited.
    // Measured with a scratch probe: with the bot left renamed to `gbbot2` by an earlier spec, 12
    // of the 18 planted markers never reached the chat (45 rows, `waitForFunction` timing out at
    // 2000 ms); renaming the bot to `gbbot` first landed all 18 (64 rows, nothing missing). The
    // file passed inside the serial prefix only because a spec before it happened to rename the
    // bot back, and failed every time the file ran alone.
    await irc.botNick('gbbot');
    await waitForBotNickApplied(page, 'gbbot', '#glowing-bear', 'readmarker-nick');
    const chatContainer = page.locator('[data-testid="chat-messages"]');
    await chatContainer.evaluate((el) => {
        (el as HTMLElement).scrollTop = (el as HTMLElement).scrollHeight;
    });
    await waitForBuffer(page, 'gbtest', 10000);
    await switchToBuffer(page, 'gbtest');

    const runId = Date.now();
    const statusBefore = Array.from({ length: 4 }, (_, i) => `readmarker-status-before-${runId}-${i}`);
    const userMessages = Array.from({ length: 6 }, (_, i) => `readmarker-user-message-${runId}-${i}`);
    const statusAfter = Array.from({ length: 8 }, (_, i) => `readmarker-status-after-${runId}-${i}`);

    // The status line the separator is located against. Array.from made four of them and the loop
    // above sends them all; the index type has not read that, and a missing first marker would
    // mean the test had nothing to wait for.
    const firstStatusMarker = statusBefore[0];
    if (firstStatusMarker === undefined) {
        throw new Error('no first status marker to locate the readmarker against');
    }

    for (const text of statusBefore) {
        await irc.raw(`:gbbot!gbbot@localhost JOIN #glowing-bear :${text}`);
    }
    for (const text of userMessages) {
        await irc.sendMessage('#glowing-bear', text);
    }
    for (const text of statusAfter) {
        await irc.raw(`:gbbot!gbbot@localhost PART #glowing-bear :${text}`);
    }

    await switchToBuffer(page, '#glowing-bear');
    await page.waitForFunction(({ statusBefore, userMessages, statusAfter }) => {
        const text = document.querySelector('[data-testid="chat-messages"]')?.textContent ?? '';
        return [...statusBefore, ...userMessages, ...statusAfter].every(marker => text.includes(marker));
    }, { statusBefore, userMessages, statusAfter });

    const state = await page.evaluate((statusMarker) => {
        const container = document.querySelector('[data-testid="chat-messages"]');
        const marker = container?.querySelector('.readmarker');
        const rows = container ? Array.from(container.querySelectorAll('[data-testid="bufferline-row"]')) : [];
        const firstUnreadStatus = rows.find(row => row.textContent?.includes(statusMarker));
        const ordered = container ? Array.from(container.querySelectorAll('[data-testid="bufferline-row"], .readmarker')) : [];
        return {
            markerBeforeFirstStatus: !!marker && !!firstUnreadStatus && ordered.indexOf(marker) < ordered.indexOf(firstUnreadStatus),
            badge: marker?.querySelector('.readmarker-badge')?.textContent?.trim() ?? null,
        };
    }, firstStatusMarker);

    expect(state.markerBeforeFirstStatus).toBe(true);
    expect(state.badge).toBe('6 new');
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

    // Wait for the unread badge on #glowing-bear (messages arrived and tallied)
    const gbItem = page.getByTestId('buffer-item').filter({ has: page.locator('.buffer-name').filter({ hasText: /^glowing-bear$/ }) }).first();
    await expect(gbItem.getByTestId('unread-badge')).toBeVisible({ timeout: 10000 });

    // Switch back — readmarker should appear again
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');

    // Wait for setActiveBuffer console log
    await waitForConsoleLog('[setActiveBuffer]');

    const readmarker = page.getByTestId('readmarker');
    await expect(readmarker).toBeVisible();

    // Verify there are unread lines below the readmarker
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
// Verify that a buffer nobody is looking at keeps its unread count while the active buffer moves.
test('a buffer keeps its unread count when the active buffer moves on', async () => {
    await waitForBuffer(page, '#glowing-bear', 15000);

    // Arrange the baseline the assertion needs: read the target first, so the only unread it can
    // hold afterwards is the unread this test sends.
    await switchToBuffer(page, '#glowing-bear');
    await waitForNoUnread(page, '#glowing-bear');

    // The buffer this test moves to is one it created and will close. It used to move to
    // `buffer-item` index 1 of "anything that is not glowing-bear" — whichever fixture buffer
    // happened to sit there — and skipped outright when fewer than two rows existed, so on a cold
    // fixture the assertion never ran at all.
    const away = await openSpecChatChannel(page, 'rmaway');

    await waitForBuffer(page, 'gbtest', 10000);
    await switchToBuffer(page, 'gbtest');
    await waitForNoUnread(page, '#glowing-bear');

    const runId = Date.now();
    await irc.sendMessage('#glowing-bear', `other-buffer-count-${runId}-1`);
    await irc.sendMessage('#glowing-bear', `other-buffer-count-${runId}-2`);
    await expect
        .poll(() => readUnreadBadge(page, '#glowing-bear'), { timeout: 20000, intervals: [250] })
        .toBe(2);

    // Moving the active buffer again must not touch a buffer nobody is looking at. Read it once,
    // immediately: a polled assertion of an unchanged number can pass on DOM that has not updated
    // yet, which proves nothing.
    await switchToBuffer(page, away);
    expect(await readUnreadBadge(page, '#glowing-bear')).toBe(2);
    await expect
        .poll(() => readUnreadBadge(page, '#glowing-bear'), { timeout: 10000, intervals: [250] })
        .toBe(2);

    closeSpecChatChannel(away);
    await switchToBuffer(page, '#glowing-bear');
});

test('keeps the new-message separator fixed for the active viewing session', async () => {
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
    await waitForBuffer(page, 'gbtest', 10000);
    await switchToBuffer(page, 'gbtest');

    const runId = Date.now();
    const firstUnread = `fixed-readmarker-first-${runId}`;
    const secondUnread = `fixed-readmarker-second-${runId}`;
    const liveMessage = `fixed-readmarker-live-${runId}`;
    await irc.sendMessage('#glowing-bear', firstUnread);
    await irc.sendMessage('#glowing-bear', secondUnread);
    await switchToBuffer(page, '#glowing-bear');

    // Read marker state relative to the first line in this viewing session.
    const getMarkerState = async () => page.evaluate((firstUnreadText) => {
        const container = document.querySelector('[data-testid="chat-messages"]') as HTMLElement | null;
        const marker = container?.querySelector('.readmarker');
        const rows = container ? Array.from(container.querySelectorAll('[data-testid="bufferline-row"]')) : [];
        const firstUnreadRow = rows.find(row => row.textContent?.includes(firstUnreadText));
        const ordered = container ? Array.from(container.querySelectorAll('[data-testid="bufferline-row"], .readmarker')) : [];
        const markerIndex = marker ? ordered.indexOf(marker) : -1;
        const firstUnreadIndex = firstUnreadRow ? ordered.indexOf(firstUnreadRow) : -1;
        return {
            markerImmediatelyBeforeFirstUnread: markerIndex >= 0 && firstUnreadIndex === markerIndex + 1,
            markerAtEnd: markerIndex >= 0 && markerIndex === ordered.length - 1,
            badge: marker?.querySelector('.readmarker-badge')?.textContent?.trim() ?? null,
            atBottom: !!container && container.scrollTop >= container.scrollHeight - container.clientHeight - 10,
        };
    }, firstUnread);

    await expect.poll(getMarkerState).toMatchObject({
        markerImmediatelyBeforeFirstUnread: true,
        markerAtEnd: false,
        badge: '2 new',
    });

    const chatContainer = page.locator('[data-testid="chat-messages"]');
    await chatContainer.evaluate(async (el) => {
        el.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true }));
        (el as HTMLElement).scrollTop = (el as HTMLElement).scrollHeight;
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    });
    expect(await getMarkerState()).toEqual({
        markerImmediatelyBeforeFirstUnread: true,
        markerAtEnd: false,
        badge: '2 new',
        atBottom: true,
    });

    // Auto-following a newly arrived line must not erase or relocate this session's marker.
    await irc.sendMessage('#glowing-bear', liveMessage);
    await page.waitForFunction((text) =>
        document.querySelector('[data-testid="chat-messages"]')?.textContent?.includes(text),
    liveMessage);
    await expect.poll(getMarkerState).toEqual({
        markerImmediatelyBeforeFirstUnread: true,
        markerAtEnd: false,
        badge: '3 new',
        atBottom: true,
    });

    // Leaving ends the viewing session; returning with no new lines shows the committed end boundary.
    await switchToBuffer(page, 'gbtest');
    await switchToBuffer(page, '#glowing-bear');
    await expect.poll(getMarkerState).toMatchObject({
        markerImmediatelyBeforeFirstUnread: false,
        markerAtEnd: true,
        badge: null,
    });
});

test('uses the initial hotlist count for the first visit after connecting', async () => {
    await switchToBuffer(page, '#glowing-bear');
    await waitForBuffer(page, 'gbtest', 10000);
    await switchToBuffer(page, 'gbtest');

    const unreadMessage = `initial-hotlist-readmarker-${Date.now()}`;
    await irc.sendMessage('#glowing-bear', unreadMessage);
    const glowItem = page.getByTestId('buffer-item').filter({ hasText: 'glowing-bear' }).first();
    await expect(glowItem.getByTestId('unread-badge')).toHaveText('1', { timeout: 10000 });
    await disconnect(page);
    await reconnect(page, { preserveLastBuffer: true });
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
    await page.waitForFunction((text) =>
        document.querySelector('[data-testid="chat-messages"]')?.textContent?.includes(text),
    unreadMessage);

    // Locate the separator relative to the unread line loaded from the initial snapshot.
    const getInitialMarkerState = async () => page.evaluate((unreadText) => {
        const container = document.querySelector('[data-testid="chat-messages"]');
        const marker = container?.querySelector('.readmarker');
        const unreadRow = container
            ? Array.from(container.querySelectorAll('[data-testid="bufferline-row"]')).find(row => row.textContent?.includes(unreadText))
            : undefined;
        const ordered = container ? Array.from(container.querySelectorAll('[data-testid="bufferline-row"], .readmarker')) : [];
        const markerIndex = marker ? ordered.indexOf(marker) : -1;
        const unreadIndex = unreadRow ? ordered.indexOf(unreadRow) : -1;
        return {
            markerImmediatelyBeforeUnread: markerIndex >= 0 && unreadIndex === markerIndex + 1,
            badge: marker?.querySelector('.readmarker-badge')?.textContent?.trim() ?? null,
        };
    }, unreadMessage);

    await expect.poll(getInitialMarkerState).toEqual({
        markerImmediatelyBeforeUnread: true,
        badge: '1 new',
    });
});