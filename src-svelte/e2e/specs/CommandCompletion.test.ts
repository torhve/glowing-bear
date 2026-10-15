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
 *
 * Tab walks the candidate list forward and Shift-Tab walks it back: a prefix
 * that matches three commands is only useful if all three are reachable.
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


/**
 * Press a completion key and return the composer text once it has moved.
 * The candidate order comes from WeeChat, so the tests assert the walk
 * (one step back, then wrap) rather than pinning an ordering.
 */
async function pressAndWait(page: import('@playwright/test').Page, key: 'Tab' | 'Shift+Tab', from: string) {
    await page.getByTestId('message-input').press(key);
    await expect.poll(async () => await inputText(page), { timeout: 8000 }).not.toBe(from);
    return inputText(page);
}

// Three aliases sharing a prefix, so the completion list has something to walk.
const CYCLE_ALIASES = ['zzza', 'zzzb', 'zzzc'];

async function defineCycleAliases(page: import('@playwright/test').Page) {
    for (const name of CYCLE_ALIASES) {
        await sendComposerLine(page, `/alias add ${name} echo cycle-hit`);
    }
    // The client cannot observe that new commands exist yet, so this paces
    // WeeChat's alias registration rather than any app state.
    await new Promise(r => setTimeout(r, 1200));
}

async function removeCycleAliases(page: import('@playwright/test').Page) {
    for (const name of CYCLE_ALIASES) {
        await sendComposerLine(page, `/alias del ${name}`).catch(() => undefined);
    }
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

test('legacy Shift-Tab walks the command list backwards', async ({ browser }) => {
    const page = await createConnectedPage(browser, { port: '9001', settings: { protocol: 'legacy' } });
    try {
        await waitForTransport(page, 'legacy');
        await waitForBuffer(page, '#glowing-bear', 10000);
        await switchToBuffer(page, '#glowing-bear');
        await defineCycleAliases(page);

        await typeIntoInput(page, '/zzz');
        const first = await pressAndWait(page, 'Tab', '/zzz');
        const second = await pressAndWait(page, 'Tab', first);
        const back = await pressAndWait(page, 'Shift+Tab', second);
        expect(back).toBe(first);
        // One step further back leaves the start of the list and wraps to the end.
        const wrapped = await pressAndWait(page, 'Shift+Tab', back);
        expect(wrapped).not.toBe(first);
        expect(wrapped).not.toBe(second);
    } finally {
        await removeCycleAliases(page);
        await page.close();
    }
});

test('API Shift-Tab walks the command list backwards', async ({ browser }) => {
    const page = await createConnectedPage(browser, { port: '9010' });
    try {
        await waitForTransport(page, 'api');
        await waitForBuffer(page, '#glowing-bear', 10000);
        await switchToBuffer(page, '#glowing-bear');
        await defineCycleAliases(page);

        await typeIntoInput(page, '/zzz');
        const first = await pressAndWait(page, 'Tab', '/zzz');
        const second = await pressAndWait(page, 'Tab', first);
        const back = await pressAndWait(page, 'Shift+Tab', second);
        expect(back).toBe(first);
        const wrapped = await pressAndWait(page, 'Shift+Tab', back);
        expect(wrapped).not.toBe(first);
        expect(wrapped).not.toBe(second);
    } finally {
        await removeCycleAliases(page);
        await page.close();
    }
});

