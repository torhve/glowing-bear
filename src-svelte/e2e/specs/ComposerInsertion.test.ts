import { test, expect } from '@playwright/test';
import { createConnectedPage } from '../fixtures/auth';
import { waitForBuffer, switchToBuffer } from '../helpers/buffers';
import { irc } from '../helpers/irc-control';
import { fixtureCommand } from '../helpers/relay-admin';
import { expectInputFocused, rawInputValue, waitForInputValue } from '../helpers/input';
import { setupEffectOrphanFilter } from '../helpers/pageerror';

let page: import('@playwright/test').Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
    page = await createConnectedPage(browser);
    setupEffectOrphanFilter(page);
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
});

test.afterAll(async () => {
    await page.close();
});

test.beforeEach(async () => {
    setupEffectOrphanFilter(page);
    await resetComposer();
});

/**
 * Empty the composer through the UI, not by clearing state: both insertion paths
 * read the textarea's current value and caret, so a spec that left text behind
 * would be testing a different starting position than the one it claims.
 */
async function resetComposer(): Promise<void> {
    await page.getByTestId('message-input').fill('');
    await waitForInputValue(page, '');
}

/** The nick a row's prefix link carries, which is what an insertion inserts. */
async function prefixNick(locator: import('@playwright/test').Locator): Promise<string> {
    const title = await locator.getAttribute('title');
    // The tooltip shows the addressable nick (`@gbbot`); the composer takes the nick
    // itself, which is what the insertion actually puts in.
    return (title ?? '').replace(/^@/, '').trim();
}

/**
 * A row the bot sent, with its prefix link.
 *
 * The bot's nick is not fixed across a run — other specs rename it — so the nick
 * is read off the row rather than written into an expectation.
 */
async function botRow(tag: string): Promise<import('@playwright/test').Locator> {
    await irc.sendMessage('#glowing-bear', tag);
    const row = page.locator('[data-testid="bufferline-row"]').filter({ hasText: tag }).first();
    await expect(row).toBeVisible({ timeout: 15000 });
    return row;
}

test.describe('inserting a nick into the composer', () => {
    test("clicking a row's prefix puts that nick in the composer and focuses it", async () => {
        const row = await botRow(`insert-mention-${Date.now()}`);
        const link = row.locator('td.prefix .mention-link').first();
        const nick = await prefixNick(link);
        expect(nick.length).toBeGreaterThan(0);

        await link.click();

        // The mention path addresses a nick, so an empty composer becomes "nick: ".
        await waitForInputValue(page, `${nick}: `);
        await expectInputFocused(page);
    });

    test('keyboard-activating a nicklist entry puts that nick in the composer', async () => {
        // A click on a nick opens a query; Enter or Space is the insertion. This pins
        // which of the two writes to the composer, so a refactor cannot swap them.
        const nicklist = page.getByTestId('nicklist');
        await expect(nicklist).toBeVisible({ timeout: 10000 });
        const entry = nicklist.locator('[data-testid="nick-item"]').first();
        await expect(entry).toBeVisible({ timeout: 10000 });
        const nick = (await entry.locator('.nick-name').textContent())?.trim() ?? '';
        expect(nick.length).toBeGreaterThan(0);

        await entry.focus();
        await page.keyboard.press('Enter');

        // The nicklist path addresses a person, not a message addressee: no colon.
        await waitForInputValue(page, `${nick} `);
        await expectInputFocused(page);
    });

    test('an insertion keeps what the reader had typed and lands after it', async () => {
        const row = await botRow(`insert-append-${Date.now()}`);
        const link = row.locator('td.prefix .mention-link').first();
        const nick = await prefixNick(link);

        await page.getByTestId('message-input').fill('hello');
        await waitForInputValue(page, 'hello');
        await link.click();

        await waitForInputValue(page, `hello ${nick}`);
        // The caret is at the end of the inserted nick, which is where the reader
        // wants to keep typing.
        await expect
            .poll(() => page.evaluate(() => {
                const el = document.querySelector('[data-testid="message-input"]') as HTMLTextAreaElement | null;
                return el ? el.selectionStart : -1;
            }))
            .toBe((await rawInputValue(page)).length);
    });

    test('an insertion into a composer that already ends in a space does not add a second one', async () => {
        const row = await botRow(`insert-space-${Date.now()}`);
        const link = row.locator('td.prefix .mention-link').first();
        const nick = await prefixNick(link);

        await page.getByTestId('message-input').fill('hello ');
        await waitForInputValue(page, 'hello ');
        await link.click();

        await waitForInputValue(page, `hello ${nick}`);
    });

    test('clicking a nicklist entry opens a query and leaves the composer alone', async () => {
        const nicklist = page.getByTestId('nicklist');
        await expect(nicklist).toBeVisible({ timeout: 10000 });
        const entry = nicklist.locator('[data-testid="nick-item"]').first();
        await expect(entry).toBeVisible({ timeout: 10000 });
        const nick = (await entry.locator('.nick-name').textContent())?.trim() ?? '';

        await entry.click();
        await waitForBuffer(page, nick, 15000);

        // The query is what a click is for; the composer keeps whatever was in it —
        // here, nothing.
        await waitForInputValue(page, '');

        await switchToBuffer(page, '#glowing-bear');
        fixtureCommand(`buffer close irc.gbtest.${nick}`);
    });
});
