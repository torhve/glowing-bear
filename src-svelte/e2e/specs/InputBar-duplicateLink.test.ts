import { test, expect, type Page } from '@playwright/test';
import { createConnectedPage } from '../fixtures/auth';
import { switchToBuffer } from '../helpers/buffers';
import { irc } from '../helpers/irc-control';
import { closeSettings, openSettings } from '../helpers/settings';
import { closeSpecChatChannel, openSpecChatChannel } from '../helpers/spec-chat-channel';
import { expectInputBlurred, expectInputFocused, resetInputState, waitForInputValue } from '../helpers/input';
import { rowWithText, waitForRow } from '../helpers/waits';

/**
 * The composer asks before posting a link this buffer already holds.
 *
 * The rule this file proves is user-visible: Enter on a duplicate opens a question that
 * names who posted the link, when, and with what text; **Edit** keeps the text; **Send
 * anyway** posts it once. A spec that only checked the matcher could not tell a warning
 * from a broken send, and the failure mode this feature risks is a message that never
 * reaches the channel.
 *
 * The channel belongs to this file. `openSpecChatChannel` gives it a run-unique name and
 * `afterAll` closes it by that name, because the planted link is channel state a later
 * spec would otherwise inherit. Each test uses its own path marker (`/gb-dup-1/`,
 * `/gb-dup-2/` …) and its own tracking parameter value, so one test's link can never be
 * another test's match and "my message got posted" is always countable.
 *
 * Every title contains the words "duplicate link" so the file can be run on its own:
 *   npm run test:e2e:serial -- --grep 'duplicate link'
 */

let page: Page;
let channel: string;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
    page = await createConnectedPage(browser);
    channel = await openSpecChatChannel(page, 'duplink');
});

test.afterAll(async () => {
    // `/part` leaves the buffer joined on this relay, so cleanup is an exact close.
    closeSpecChatChannel(channel);
    await page.close();
});

test.beforeEach(async () => {
    // A test that ends with the reader's text still in the composer (Edit) must not hand
    // that text to the next test, and a pending question must not survive either.
    await resetInputState(page);
    await switchToBuffer(page, channel);
});

const input = () => page.getByTestId('message-input');
const dialog = () => page.getByTestId('duplicate-link-dialog');
const dialogRows = () => page.getByTestId('duplicate-link-row');
const chatRowsWith = (text: string) => page.locator('[data-testid="bufferline-row"]').filter({ hasText: text });

/** The composer's own text, typed the way a reader types it. */
async function typeComposer(text: string): Promise<void> {
    await input().click();
    await input().fill(text);
    await waitForInputValue(page, text);
}

/**
 * Arrange the baseline, then plant the earlier post.
 *
 * The count before planting is the whole point: without it, "the dialog named the earlier
 * post" could be answered by whatever a previous spec left in this channel.
 */
async function plantEarlierPost(linkPath: string, note: string): Promise<string> {
    await expect(chatRowsWith(linkPath), `${linkPath} was already in ${channel} before this test planted it`)
        .toHaveCount(0);
    const text = `earlier look at https://example.dev${linkPath} ${note}`;
    await irc.sendMessage(channel, text);
    await waitForRow(page, note);
    return text;
}

/**
 * The nick the planted row landed under.
 *
 * Read from the row rather than hard-coded: the fixture bot's nick is arranged state that
 * other specs change, so `gbbot` in an assertion would be a claim about the previous test.
 */
async function nickOfPlantedRow(note: string): Promise<string> {
    // The prefix cell wraps the prefix in hidden brackets when the line carries
    // `showHiddenBrackets`, while the dialog row shows the line's own `prefixtext`. Strip the
    // brackets the way `BufferLineRow.extractNick` does, so both strings name the same nick.
    const cell = (await rowWithText(page, note).locator('td.prefix').textContent())?.trim() ?? '';
    const nick = cell.replace(/^<(.+)>$/, '$1');
    expect(nick, `the planted row in ${channel} carries no nick in its prefix cell`).not.toBe('');
    return nick;
}

/** Open the question and fail loudly if the composer sent instead of asking. */
async function pressEnterAndExpectTheQuestion(): Promise<void> {
    await input().press('Enter');
    await expect(dialog(), 'Enter sent a link this buffer already holds').toBeVisible();
    await expect(dialogRows()).toHaveCount(1);
}

test('duplicate link detection asks before the send and names the earlier post', async () => {
    const note = 'before you post it';
    await plantEarlierPost('/gb-dup-1/page', note);
    const nick = await nickOfPlantedRow(note);

    const text = 'see https://example.dev/gb-dup-1/page?utm_source=reddit';
    await typeComposer(text);
    await pressEnterAndExpectTheQuestion();

    const row = (await dialogRows().first().textContent()) ?? '';
    expect(row, 'the row must say who posted the link').toContain(nick);
    expect(row, 'the row must say when').toMatch(/\d{1,2}:\d{2}/);
    expect(row, 'the row must show the earlier line in full').toContain(`earlier look at https://example.dev/gb-dup-1/page ${note}`);
    expect(row, 'the row must show the URL as the buffer holds it').toContain('https://example.dev/gb-dup-1/page');
    // The bound sits in the line above the rows, not inside a row.
    await expect(dialog(), 'the dialog must bound its own claim to this buffer')
        .toContainText(channel);

    // Nothing was sent, and the reader's text is where they left it.
    await expect(chatRowsWith('utm_source=reddit'), 'the question must not post the message').toHaveCount(0);
    await waitForInputValue(page, text);

    // Focus sits on Edit, so the browser hands a second Enter to the dialog rather than to
    // the composer. Either answer — Edit, or a swallowed key — must add no row.
    await expect(page.getByTestId('duplicate-link-edit'), 'Enter must answer Edit by default').toBeFocused();
    await page.keyboard.press('Enter');
    await expect(chatRowsWith('utm_source=reddit'), 'a second Enter must not post the message either').toHaveCount(0);
    await waitForInputValue(page, text);
});

test('duplicate link Send anyway posts the text exactly once and closes the dialog', async () => {
    const note = 'posted last week';
    await plantEarlierPost('/gb-dup-2/page', note);

    const text = 'posting https://example.dev/gb-dup-2/page?utm_source=twice on purpose';
    await typeComposer(text);
    await pressEnterAndExpectTheQuestion();
    await expect(chatRowsWith('utm_source=twice')).toHaveCount(0);

    await page.getByTestId('duplicate-link-send-anyway').click();

    await waitForRow(page, 'utm_source=twice');
    await expect(chatRowsWith('utm_source=twice'), 'the answer posts once, not twice')
        .toHaveCount(1);
    await expect(dialog()).toBeHidden();
    await expect(dialogRows()).toHaveCount(0);
    await waitForInputValue(page, '');
    // A finished send keeps the composer blurred exactly as a normal send does. Answering the
    // warning must not change the send's own focus rules.
    await expectInputBlurred(page);
});

test('duplicate link Edit keeps the exact text and posts nothing', async () => {
    const note = 'already in here';
    await plantEarlierPost('/gb-dup-3/page', note);

    const text = 'https://example.dev/gb-dup-3/page?utm_source=edited — I will reconsider';
    await typeComposer(text);
    await pressEnterAndExpectTheQuestion();

    await page.getByTestId('duplicate-link-edit').click();

    await waitForInputValue(page, text);
    await expectInputFocused(page);
    await expect(dialog()).toBeHidden();
    await expect(dialogRows()).toHaveCount(0);
    await expect(chatRowsWith('utm_source=edited'), 'Edit may not send a single character').toHaveCount(0);
});

/**
 * The stale half of plan task 5 — switch buffer while the question is open, then answer
 * **Send anyway**, and prove neither buffer gained a row — lives in
 * `src-svelte/test/unit/input-bar-duplicate-gate.test.ts` instead. It cannot be arranged
 * here: an auto popover light-dismisses on the outside click a buffer switch is made with,
 * so the sidebar click answers the question with Edit before any answer can be given. The
 * unit test arranges the switch through the store and asserts nothing reached either
 * buffer, which is the claim the plan asked for.
 */
test('duplicate link detection stays quiet about a different URL', async () => {
    const note = 'a different page entirely';
    await plantEarlierPost('/gb-dup-4/one', note);

    const text = 'this one is new https://example.dev/gb-dup-4/two';
    await typeComposer(text);
    await input().press('Enter');

    await expect(dialog(), 'a different link must not train the reader to dismiss the dialog').toBeHidden();
    await expect(dialogRows()).toHaveCount(0);
    await waitForRow(page, 'gb-dup-4/two');
    await expect(chatRowsWith('gb-dup-4/two')).toHaveCount(1);
    await waitForInputValue(page, '');
});

test('duplicate link warning posts immediately when the setting is off', async () => {
    const note = 'here since earlier';
    await plantEarlierPost('/gb-dup-5/page', note);

    await openSettings(page);
    const toggle = page.getByTestId('warn-duplicate-links');
    await expect(toggle, 'the warning is on by default').toBeChecked();
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await closeSettings(page);

    const text = 'no asking wanted https://example.dev/gb-dup-5/page';
    await typeComposer(text);
    await input().press('Enter');

    await expect(dialog(), 'the reader turned the check off, so Enter sends').toBeHidden();
    await waitForRow(page, 'gb-dup-5/page');
    await expect(chatRowsWith('no asking wanted')).toHaveCount(1);

    // Put the setting back: the relay session outlives this file, and so does its settings.
    await openSettings(page);
    await expect(page.getByTestId('warn-duplicate-links')).not.toBeChecked();
    await page.getByTestId('warn-duplicate-links').click();
    await expect(page.getByTestId('warn-duplicate-links')).toBeChecked();
    await closeSettings(page);
});

test('a closed duplicate link dialog is not a tab stop', async () => {
    // Rendered unconditionally, so the element is in the document and still takes no focus.
    await expect(dialog()).toHaveCount(1);
    await expect(dialog()).toBeHidden();

    await input().click();
    await expectInputFocused(page);

    const focusedInsideDialog = () => page.evaluate(() => {
        const active = document.activeElement as HTMLElement | null;
        return active !== null && active.closest('#duplicate-link-dialog') !== null;
    });

    // Tab across the composer's own controls. A closed popover is inert, so none of these
    // stops can land inside it.
    for (let stop = 1; stop <= 12; stop++) {
        await page.keyboard.press('Tab');
        expect(await focusedInsideDialog(), `Tab ${stop} landed inside the closed dialog`).toBe(false);
    }
});
