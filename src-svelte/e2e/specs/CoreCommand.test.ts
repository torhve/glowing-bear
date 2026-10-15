import { test, expect } from '@playwright/test';
import { createConnectedPage } from '../fixtures/auth';
import { waitForTransport, sendWeechatCommand } from '../helpers/connection';
import { waitForBuffer, switchToBuffer } from '../helpers/buffers';
import { rowWithText, waitForRow, waitForRowCountAtLeast } from '../helpers/waits';
import { irc } from '../helpers/irc-control';

/**
 * Commands the user did not aim at a buffer still have to reach WeeChat.
 *
 * The relay resolves an `input` target by pointer or by full buffer name, so a
 * command with no target has to name the core buffer. It used to send the
 * pointer `0x0`, which is neither, and WeeChat dropped the frame without telling
 * the client — every targetless command on the legacy transport was lost in
 * silence. `/buffer clear` is the other half of the same problem: with no
 * argument it clears the buffer it is executed on, so it has to be aimed at the
 * buffer Enter was pressed in, not at core.
 */

const ALIAS = 'zzzgb';
const CHANNEL = '#glowing-bear';

async function typeIntoInput(page: import('@playwright/test').Page, text: string) {
    const input = page.getByTestId('message-input');
    await input.focus();
    // bind:value on a textarea is synced by an input event; fill() does not
    // reliably reach Svelte 5's binding, so the event is dispatched directly.
    await page.evaluate((t) => {
        const el = document.querySelector("[data-testid=\"message-input\"]") as HTMLTextAreaElement;
        el.value = t;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.setSelectionRange(t.length, t.length);
    }, text);
    await page.evaluate(() => new Promise(r => requestAnimationFrame(r)));
}

async function inputValue(page: import('@playwright/test').Page) {
    return page.getByTestId('message-input').inputValue();
}

test.describe.configure({ mode: 'serial' });

test('a targetless command reaches WeeChat on the legacy transport', async ({ browser }) => {
    const page = await createConnectedPage(browser, { port: '9001', settings: { protocol: 'legacy' } });
    try {
        await waitForTransport(page, 'legacy');
        await waitForBuffer(page, CHANNEL, 10000);
        await switchToBuffer(page, CHANNEL);

        // No buffer id: this is the frame that used to go out as `input 0x0 …`.
        await sendWeechatCommand(page, `/alias add ${ALIAS} echo custom-hit`);
        // The client cannot observe that a new command exists yet, so this paces
        // WeeChat's alias registration rather than any app state.
        await new Promise(r => setTimeout(r, 1200));

        // Completion is the observable, because only WeeChat knows the alias exists.
        await typeIntoInput(page, `/${ALIAS.slice(0, 4)}`);
        await page.getByTestId('message-input').press('Tab');
        await expect(async () => {
            expect(await inputValue(page)).toBe(`/${ALIAS} `);
        }).toPass({ timeout: 8000 });
    } finally {
        await sendWeechatCommand(page, `/alias del ${ALIAS}`).catch(() => undefined);
        await page.close();
    }
});

test('/buffer clear clears the buffer it was typed in, not the core buffer', async ({ browser }) => {
    const page = await createConnectedPage(browser, { port: '9010' });
    try {
        await waitForTransport(page, 'api');
        await waitForBuffer(page, CHANNEL, 10000);
        await switchToBuffer(page, CHANNEL);

        const marker = `clear-target-${Date.now()}`;
        await irc.sendMessage(CHANNEL, marker);
        await waitForRow(page, marker);

        await typeIntoInput(page, '/buffer clear');
        await page.getByTestId('message-input').press('Enter');
        await expect(page.getByTestId('message-input')).toHaveValue('', { timeout: 5000 });

        // The chat the command was typed in lost that line…
        await expect(rowWithText(page, marker), 'the cleared buffer still shows the line').not.toBeVisible();

        // …and the core buffer kept its own lines. Aimed at core, this command
        // emptied the one buffer the user was not asking about instead.
        await switchToBuffer(page, 'weechat');
        await waitForRowCountAtLeast(page, 1);
    } finally {
        await page.close();
    }
});
