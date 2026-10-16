import { test, expect, type Page } from '@playwright/test';
import { createConnectedPage } from '../fixtures/auth';
import { waitForTransport } from '../helpers/connection';
import { setupEffectOrphanFilter } from '../helpers/pageerror';
import { waitForBuffer, switchToBuffer } from '../helpers/buffers';
import { waitForChatSettled } from '../helpers/waits';
import { irc, sendSequence } from '../helpers/irc-control';

/**
 * Older content keeps arriving.
 *
 * A buffer holds a screen-sized window, and each deliberate page upward raises
 * that buffer's own window toward a ceiling. The wall this spec guards is the one
 * a reader reported: paging stopped after a few hundred lines because each page
 * was smaller than the window the buffer was trimmed back to, so a page
 * re-delivered lines the buffer already held and the client concluded there was
 * no older history.
 *
 * Both ways a reader pages are covered — reaching the top of the view, and the
 * explicit control — and so is the other way this could break: a page that
 * quietly drops content the reader was already looking at.
 *
 * It pages in its own channel. #glowing-bear is shared with every other spec and
 * is cleared and refilled by them, which made this spec's premises depend on
 * which specs ran before it; a channel only this spec writes to is history it
 * controls. Assertions still count stamped rows, because the channel persists in
 * the fixture across runs.
 */

const CHANNEL = '#scrollback-depth';
/** Deeper than two doublings of a screen window, so paging has room to prove it works. */
const SEED = 1000;
/** Fixed for the whole file so every test talks about the same planted lines. */
const STAMP = `scrollback-${Date.now()}`;

let page: Page;

test.beforeAll(async ({ browser }) => {
    // The bot joins first so the channel exists, then the app joins it: the
    // planted lines have to arrive while WeeChat is in the channel, or they are
    // not in its history at all.
    await irc.botJoin(CHANNEL);
    page = await createConnectedPage(browser, { port: '9010' });
    setupEffectOrphanFilter(page);
    // `/join` is an IRC command: WeeChat refuses it on core ("command "join"
    // must be executed on irc buffer"), so it goes through the composer while a
    // channel buffer is active, which aims it at that buffer's server.
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
    await sendComposerLine(page, `/join ${CHANNEL}`);
    await waitForBuffer(page, CHANNEL, 15000);
    await switchToBuffer(page, CHANNEL);

    await waitForChatSettled(page);
});

/** Type a line into the composer and press Enter, so WeeChat runs it in the active buffer. */
async function sendComposerLine(target: Page, text: string): Promise<void> {
    const input = target.getByTestId('message-input');
    await input.fill(text);
    await input.press('Enter');
    await expect(input, `the composer kept "${text}" instead of sending it`).toHaveValue('', { timeout: 5000 });
}


function rowWith(text: string, target: Page = page) {
    return target.getByTestId('bufferline-row').filter({ hasText: text }).first();
}

function rowCount(target: Page = page): Promise<number> {
    return target.locator('[data-testid="bufferline-row"]').count();
}



function stampedRows(stamp: string, target: Page = page): Promise<number> {
    return target.getByTestId('bufferline-row').filter({ hasText: stamp }).count();
}

/** Press the explicit control. Returns false once the relay has nothing older. */
async function pageUpWithButton(target: Page = page): Promise<boolean> {
    const button = target.getByTestId('fetch-more-lines');
    if (await button.count() === 0) return false;
    await button.click();
    await waitForChatSettled(target);
    return true;
}

/** Reach the top of the view, which is what a scrolling reader does. */
async function scrollToTop(target: Page = page) {
    // A reader arrives from the other end: jump to the bottom, then up to the
    // top. Setting 0 on a view already at 0 fires no scroll event at all.
    await target.locator('[data-testid="chat-messages"]').evaluate(async (el) => {
        el.scrollTop = el.scrollHeight;
        await new Promise((r) => requestAnimationFrame(r));
        el.scrollTop = 0;
    });
    await waitForChatSettled(target);
}

/** Re-enter the buffer so the window starts at the newest lines. */
async function reenter(target: Page = page) {
    await switchToBuffer(target, 'gbtest');
    await switchToBuffer(target, CHANNEL);
    await waitForChatSettled(target);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
    await sendSequence(CHANNEL, Array.from({ length: SEED }, (_, i) => `${STAMP} older ${i}`));
    await reenter();
});

test('reaching the top of the view keeps fetching without being asked', async () => {
    const before = await stampedRows(STAMP);
    // The premise: the planted history is deeper than the window on screen.
    expect(before, 'the initial window should not already hold everything planted').toBeLessThan(SEED);

    await scrollToTop();

    await expect
        .poll(() => stampedRows(STAMP), { timeout: 15000 })
        .toBeGreaterThan(before);
});

test('the explicit control reaches the oldest planted line without dropping the newest', async () => {
    for (let i = 0; i < 6; i++) {
        if (await rowWith(`${STAMP} older 0`).count() > 0) break;
        const before = await rowCount();
        const fetched = await pageUpWithButton();
        expect(fetched, 'paging stopped before the planted history ran out').toBe(true);
        const after = await rowCount();
        expect(after, `page ${i + 1} brought in no older content`).toBeGreaterThan(before);
    }

    await expect(
        rowWith(`${STAMP} older 0`),
        'the oldest planted line should be reachable by paging upward',
    ).toBeVisible();
    // Paging upward must not throw away what the reader was already looking at.
    await expect(rowWith(`${STAMP} older ${SEED - 1}`), 'the newest planted line went away').toBeVisible();
});

test('the legacy transport pages deeper without dropping what it already showed', async ({ browser }) => {
    // This transport answers a history request by replacing the buffer's window,
    // so it is the path where a page can shrink the view instead of deepening it.
    const stamp = `scrollback-legacy-${Date.now()}`;
    await sendSequence(CHANNEL, Array.from({ length: SEED }, (_, i) => `${stamp} deep ${i}`));

    const legacy = await createConnectedPage(browser, { port: '9001', settings: { protocol: 'legacy' } });
    try {
        await waitForTransport(legacy, 'legacy', 30000);
        await waitForBuffer(legacy, CHANNEL, 15000);
        await switchToBuffer(legacy, CHANNEL);
        await waitForChatSettled(legacy);

        const before = await stampedRows(stamp, legacy);
        expect(before, 'the initial window should not already hold everything planted').toBeLessThan(SEED);

        for (let i = 0; i < 6; i++) {
            if (await rowWith(`${stamp} deep 0`, legacy).count() > 0) break;
            const before = await rowCount(legacy);
            const fetched = await pageUpWithButton(legacy);
            expect(fetched, 'paging stopped before the planted history ran out').toBe(true);
            const after = await rowCount(legacy);
            expect(after, `page ${i + 1} brought in no older content`).toBeGreaterThan(before);
        }

        await expect(
            rowWith(`${stamp} deep 0`, legacy),
            'the oldest planted line should be reachable on the legacy transport too',
        ).toBeVisible();
        await expect(
            rowWith(`${stamp} deep ${SEED - 1}`, legacy),
            'the newest planted line went away while paging upward',
        ).toBeVisible();
    } finally {
        await legacy.close();
    }
});
