import { test, expect } from '@playwright/test';
import { createConnectedPage } from '../fixtures/auth';
import {
    switchToBuffer,
    closeMobileOverlay,
    bufferItemForName,
    waitForBuffer,
} from '../helpers/buffers';
import { irc } from '../helpers/irc-control';
import { closeSpecPrivateBuffer, openSpecPrivateBuffer } from '../helpers/spec-chat-channel';
import { setupEffectOrphanFilter } from '../helpers/pageerror';
import { waitForRow } from '../helpers/waits';

let page: import('@playwright/test').Page;

test.describe.configure({ mode: 'serial' });

/**
 * The private buffer this spec asserts on is `irc.gbtest.<nick>`, and WeeChat fixes that name when
 * the first PM creates the buffer — renaming the peer afterwards does not rename the buffer
 * (measured: bot renamed, change confirmed in the chat, PM sent under the new nick, sidebar still
 * holding the row named for the old one). So the nick is pinned and the buffer is created here, by
 * this spec, rather than inherited from whichever spec last touched the shared bot — this file used
 * to assume the name while `BufferLineRow.test.ts` and `Irc-integration.test.ts` renamed the same
 * bot to other things.
 */
const BOT_NICK = 'gbbot2';

test.beforeAll(async ({ browser }) => {
    page = await createConnectedPage(browser);
    setupEffectOrphanFilter(page);
    await switchToBuffer(page, '#glowing-bear');
    // Drops whatever private buffer the fixture still holds, pins the nick, and sends the PM that
    // makes WeeChat create the buffer under it. The name asserted below is arranged by this spec.
    await openSpecPrivateBuffer(page, BOT_NICK, 'pm');
});

test.afterAll(async () => {
    // Leave nothing for the next spec or run to inherit. This spec used to recreate the buffer as
    // a courtesy — which is what decided its name for everybody that came after it — and now closes
    // it instead, because a spec that needs a private buffer arranges its own.
    closeSpecPrivateBuffer(BOT_NICK);
    await page.close();
});

test.beforeEach(async () => {
    setupEffectOrphanFilter(page);
    await closeMobileOverlay(page);
    await switchToBuffer(page, '#glowing-bear');
});

/** Whether the sidebar currently has a row named exactly the bot's nick. */
function pmRowPresent(): Promise<boolean> {
    return page.evaluate((nick) => {
        const names = [...document.querySelectorAll('[data-testid="buffer-item"] .buffer-name')];
        return names.some((el) => (el.textContent ?? '').trim() === nick);
    }, BOT_NICK);
}

/**
 * The unread number the sidebar shows on the PM row: 0 when the row carries no badge, and -1
 * when the row is gone, so a missing buffer reads as a failure naming itself instead of a
 * timeout. Polling this exact number is what makes a badge assertion attributable: "at least
 * one" is also satisfied by a line that was still travelling when the baseline was taken.
 */
function pmUnread(): Promise<number> {
    return page.evaluate((nick) => {
        const rows = [...document.querySelectorAll('[data-testid="buffer-item"]')];
        const row = rows.find((el) => {
            const name = el.querySelector('.buffer-name');
            return (name?.textContent ?? '').trim() === nick;
        });
        if (!row) return -1;
        const badge = row.querySelector('[data-testid="unread-badge"]');
        const value = badge ? Number.parseInt(badge.textContent ?? '', 10) : 0;
        return Number.isNaN(value) ? 0 : value;
    }, BOT_NICK);
}

async function expectPmUnread(value: number): Promise<void> {
    await expect.poll(pmUnread, { timeout: 15000, intervals: [250] }).toBe(value);
}

/** A PM sent from the fixture bot to the app's own user, with text unique to this call. */
async function sendUniquePm(): Promise<string> {
    const text = `pm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await irc.sendPm('testuser', text);
    return text;
}

/** Open the PM buffer and wait until the app is showing it. */
async function openPmBuffer(): Promise<void> {
    await bufferItemForName(page, BOT_NICK).first().click();
    await expect(page.locator('.topic-channel-name').first()).toHaveText(BOT_NICK);
}

/**
 * Arrange the buffer this spec asserts on, and arrange it *delivered*: send a PM, wait for the
 * query buffer to exist, open it, and wait until that PM's line is on screen.
 *
 * Measured here: the sidebar row and the chat line are not simultaneous — opening the buffer as
 * soon as the row appears still reported the line as not rendered. Waiting for the row alone
 * therefore leaves a PM in flight, and a line landing after a "no unread" baseline re-creates
 * the badge a later assertion is trying to attribute to its own message. That is how this file's
 * badge spec passed for a while without sending the message it claimed to test.
 *
 * Creating the buffer by sending to it is also what replaces the two `test.skip()` guards
 * removed from this file: they skipped whenever no earlier run had happened to leave a PM buffer
 * behind, so the spec ran on a warm fixture and silently did nothing on a cold one. A closed
 * query buffer is re-created by the next PM (measured).
 */
/** Send a PM and wait for the query buffer row, leaving the chat where it was. */
async function sendPmUntilBufferExists(): Promise<string> {
    const text = await sendUniquePm();
    await waitForBuffer(page, BOT_NICK, 20000);
    return text;
}

async function ensurePmBuffer(): Promise<string> {
    const text = await sendPmUntilBufferExists();
    await openPmBuffer();
    await waitForRow(page, text, 15000);
    return text;
}

/**
 * Move the chat back to the channel with the PM buffer read and showing no badge, so the only
 * thing that can put a number on that row afterwards is a message sent after this point.
 */
async function parkOnChannelWithCleanBadge(): Promise<void> {
    await switchToBuffer(page, '#glowing-bear');
    await expectPmUnread(0);
}

test('a PM from the bot creates the query buffer the message lands in', async () => {
    // Arrange the absence first: without this, "creates" would be true only because the buffer
    // happened to already exist.
    closeSpecPrivateBuffer(BOT_NICK);
    await expect.poll(pmRowPresent, { timeout: 15000, intervals: [250] }).toBe(false);

    const text = await sendPmUntilBufferExists();
    await openPmBuffer();
    await waitForRow(page, text, 15000);
});

test('clicking the PM row switches the chat to that buffer', async () => {
    // The chat sits on the channel (beforeEach) and the buffer is only known to exist; the row
    // click is the one thing that can move the chat, so the message has to turn up in the buffer
    // the topic bar names afterwards.
    const text = await sendPmUntilBufferExists();
    await openPmBuffer();
    await waitForRow(page, text, 15000);
    await expect(page.locator('.topic-channel-name').first()).toContainText(BOT_NICK);
});

test('an unread badge appears on a PM buffer the chat is not looking at', async () => {
    await ensurePmBuffer();
    await parkOnChannelWithCleanBadge();

    // The chat is on the channel and the row reads zero: this PM is the only candidate.
    await sendUniquePm();
    await expectPmUnread(1);
});

test('switching to the PM buffer clears its unread, and a later PM starts a new count', async () => {
    await ensurePmBuffer();
    await parkOnChannelWithCleanBadge();

    await sendUniquePm();
    await expectPmUnread(1);

    // Reading the buffer is what removes the badge...
    await openPmBuffer();
    await expectPmUnread(0);

    // ...and the buffer counts unread again afterwards instead of staying permanently read.
    await switchToBuffer(page, '#glowing-bear');
    await sendUniquePm();
    await expectPmUnread(1);
});

test('closing the PM buffer from the topic bar removes it and leaves the app working', async () => {
    await ensurePmBuffer();

    const closeBtn = page.getByTestId('topic-bar-container').getByTestId('close-buffer');
    await expect(closeBtn).toBeVisible();
    await closeBtn.click();

    // Measured on this relay a query buffer really does close: the row goes away and stays away,
    // and the chat keeps working instead of pointing at a closed buffer.
    await expect.poll(pmRowPresent, { timeout: 15000, intervals: [250] }).toBe(false);
    await expect(page.getByTestId('chat-view')).toBeVisible();
});
