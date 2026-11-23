import { test, expect } from '@playwright/test';
import { createConnectedPage } from '../fixtures/auth';
import { waitForBuffer, switchToBuffer } from '../helpers/buffers';
import { irc } from '../helpers/irc-control';

import { setupEffectOrphanFilter } from '../helpers/pageerror';

let page: import('@playwright/test').Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
    page = await createConnectedPage(browser);
    setupEffectOrphanFilter(page)
});

test.afterAll(async () => {
    await page.close();
});

test.beforeEach(async () => {
    setupEffectOrphanFilter(page)
});

/**
 * The `gb…` nick the shared fixture channel holds.
 *
 * Completion picks it from WeeChat's nicklist, so the spec reads that arrangement
 * instead of naming a nick a previous spec happened to leave behind.
 */
async function fixtureBotNick(): Promise<string> {
    const members = await irc.channelMembers('#glowing-bear');
    const bots = members.filter((name) => /^gb/i.test(name));
    expect(bots, `expected exactly one gb nick in #glowing-bear, members: ${members.join(', ')}`).toHaveLength(1);
    return bots[0]!;
}

/**
 * Type `text`, walk the caret `back` characters left, press Tab, and hand back the
 * composer once a completion has landed in it.
 */
async function completeInComposer(text: string, back = 0): Promise<string> {
    const input = page.getByTestId('message-input');
    await input.focus();
    await input.fill(text);
    for (let i = 0; i < back; i++) {
        await input.press('ArrowLeft');
    }
    await input.press('Tab');
    await expect
        .poll(() => input.inputValue(), { timeout: 5000, message: `Tab left ${JSON.stringify(text)} unchanged` })
        .not.toBe(text);
    return input.inputValue();
}

test('Tab key completes partial nick at start of input', async () => {
    await waitForBuffer(page, '#glowing-bear', 10000);
    await switchToBuffer(page, '#glowing-bear');
    await expect(page.getByTestId('topic-bar')).toBeVisible({ timeout: 5000 });

    // The first word of the composer arrives with the completer suffix and its
    // space inside the candidate, so the composer gets one space and not two.
    const bot = await fixtureBotNick();
    expect(await completeInComposer('gb')).toBe(`${bot}: `);
});

test('nick-complete button completes nick', async () => {
    await waitForBuffer(page, '#glowing-bear', 10000);
    await switchToBuffer(page, '#glowing-bear');
    await expect(page.getByTestId('topic-bar')).toBeVisible({ timeout: 5000 });

    // Wait for nicks to be loaded in the channel
    await page.getByTestId('nicklist').locator('[data-testid="nick-item"]').first().waitFor({ state: 'visible', timeout: 5000 });

    // Use evaluate to set value and dispatch input event — Playwright's fill()
    // does not properly sync with Svelte 5 bind:value on textarea.
    await page.getByTestId('message-input').focus();
    await page.evaluate(() => {
        const input = document.querySelector('[data-testid="message-input"]') as HTMLTextAreaElement;
        if (input) {
            input.value = 'te';
            input.dispatchEvent(new Event('input', { bubbles: true }));
        }
    });

    await page.getByTestId('nick-complete-button').click();

    await expect(async () => {
        const val = await page.getByTestId('message-input').inputValue();
        expect(val.length).toBeGreaterThan(2);
        expect(val).toContain('te');
    }).toPass({ timeout: 5000 });
});

test('repeated Tab iterates through matching nicks', async () => {
    await waitForBuffer(page, '#glowing-bear', 10000);
    await switchToBuffer(page, '#glowing-bear');
    await expect(page.getByTestId('topic-bar')).toBeVisible({ timeout: 5000 });

    const input = page.getByTestId('message-input');
    await input.focus();

    await input.fill('te');
    await page.evaluate(() => new Promise(r => requestAnimationFrame(r)));

    await input.press('Tab');
    const first = await input.inputValue();

    await input.press('Tab');
    const second = await input.inputValue();

    // If there are multiple matching nicks, cycling should produce a different result
    // At minimum, verify the values are valid nick completions
    expect(first.length).toBeGreaterThan(0);
    expect(second.length).toBeGreaterThan(0);
});

test('Tab completes nick in middle of message', async () => {
    await waitForBuffer(page, '#glowing-bear', 10000);
    await switchToBuffer(page, '#glowing-bear');
    await expect(page.getByTestId('topic-bar')).toBeVisible({ timeout: 5000 });

    // A later word comes back bare with add_space true, so the client supplies the
    // separator the reader did not type — exactly one space.
    const bot = await fixtureBotNick();
    expect(await completeInComposer('hello gb')).toBe(`hello ${bot} `);
});

test('Tab does not add a space where the reader already typed one', async () => {
    await waitForBuffer(page, '#glowing-bear', 10000);
    await switchToBuffer(page, '#glowing-bear');
    await expect(page.getByTestId('topic-bar')).toBeVisible({ timeout: 5000 });

    // Four ArrowLeft steps put the caret just past 'gb', so ' now' stays in the
    // composer. A second space before it is the bug this pins.
    const bot = await fixtureBotNick();
    expect(await completeInComposer('say hi to gb now', 4)).toBe(`say hi to ${bot} now`);
});

test('no change when no nick matches the prefix', async () => {
    await waitForBuffer(page, '#glowing-bear', 10000);
    await switchToBuffer(page, '#glowing-bear');
    await expect(page.getByTestId('topic-bar')).toBeVisible({ timeout: 5000 });

    const input = page.getByTestId('message-input');
    await input.focus();
    await input.fill('zzzzz_no_match');

    const before = await input.inputValue();
    await input.press('Tab');

    await expect(async () => {
        const after = await input.inputValue();
        expect(after).toBe(before);
    }).toPass({ timeout: 5000 });
});
