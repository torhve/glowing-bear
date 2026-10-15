import { test, expect } from '@playwright/test';
import { createConnectedPage } from '../fixtures/auth';
import { waitForTransport } from '../helpers/connection';
import { waitForBuffer, switchToBuffer } from '../helpers/buffers';

/**
 * Command completion, on both transports.
 *
 * WeeChat owns the command list — custom aliases included — so completing a
 * command is a question for the relay, not for the client. The API transport
 * asks POST /api/completion; the legacy transport asks the relay's `completion`
 * command. Both must complete a command the user defined themselves, because a
 * composer that only knows the built-in commands is useless for aliases.
 */

const ALIAS = 'zzzgb';
const ALIAS_EXPANSION = 'echo custom-hit';

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

async function pressTab(page: import('@playwright/test').Page) {
    await page.getByTestId('message-input').press('Tab');
}

async function inputText(page: import('@playwright/test').Page) {
    return page.getByTestId('message-input').inputValue();
}

/**
 * Define the custom command through the app's own transport, so the fixture
 * never reaches WeeChat through a channel the app is not using.
 */
/**
 * Send a line the way a user does — type it into the composer and press Enter.
 * The composer sends through the active transport, so the fixture never reaches
 * WeeChat through a channel the app is not using.
 */
async function sendComposerLine(page: import('@playwright/test').Page, text: string) {
    await typeIntoInput(page, text);
    await page.getByTestId('message-input').press('Enter');
    await expect(page.getByTestId('message-input')).toHaveValue('', { timeout: 5000 });
}

async function defineAlias(page: import('@playwright/test').Page) {
    await sendComposerLine(page, `/alias add ${ALIAS} ${ALIAS_EXPANSION}`);
    // The client cannot observe that a new command exists yet, so this paces
    // WeeChat's alias registration rather than any app state.
    await new Promise(r => setTimeout(r, 1200));
}

async function removeAlias(page: import('@playwright/test').Page) {
    await sendComposerLine(page, `/alias del ${ALIAS}`).catch(() => undefined);
}


test.describe.configure({ mode: 'serial' });

test('legacy transport completes a custom command', async ({ browser }) => {
    const page = await createConnectedPage(browser, { port: '9001', settings: { protocol: 'legacy' } });
    try {
        await waitForTransport(page, 'legacy');
        await waitForBuffer(page, '#glowing-bear', 10000);
        await switchToBuffer(page, '#glowing-bear');
        await defineAlias(page);

        await typeIntoInput(page, `/${ALIAS.slice(0, 4)}`);
        await pressTab(page);
        await expect(async () => {
            expect(await inputText(page)).toBe(`/${ALIAS} `);
        }).toPass({ timeout: 8000 });
    } finally {
        await removeAlias(page);
        await page.close();
    }
});

test('legacy transport completes a built-in command', async ({ browser }) => {
    const page = await createConnectedPage(browser, { port: '9001', settings: { protocol: 'legacy' } });
    try {
        await waitForTransport(page, 'legacy');
        await waitForBuffer(page, '#glowing-bear', 10000);
        await switchToBuffer(page, '#glowing-bear');

        await typeIntoInput(page, '/ver');
        await pressTab(page);
        await expect(async () => {
            expect(await inputText(page)).toBe('/version ');
        }).toPass({ timeout: 8000 });
    } finally {
        await page.close();
    }
});

test('API transport completes a custom command', async ({ browser }) => {
    const page = await createConnectedPage(browser, { port: '9010' });
    try {
        await waitForTransport(page, 'api');
        await waitForBuffer(page, '#glowing-bear', 10000);
        await switchToBuffer(page, '#glowing-bear');
        await defineAlias(page);

        await typeIntoInput(page, `/${ALIAS.slice(0, 4)}`);
        await pressTab(page);
        await expect(async () => {
            expect(await inputText(page)).toBe(`/${ALIAS} `);
        }).toPass({ timeout: 8000 });
    } finally {
        await removeAlias(page);
        await page.close();
    }
});
