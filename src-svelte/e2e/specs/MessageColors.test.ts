import { test, expect } from '@playwright/test';
import { createConnectedPage } from '../fixtures/auth';
import { waitForTransport } from '../helpers/connection';
import { waitForBuffer, switchToBuffer } from '../helpers/buffers';
import { irc } from '../helpers/irc-control';

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
    await irc.setTopic('#glowing-bear', '');
    await page.close();
});

test.beforeEach(async () => {
    setupEffectOrphanFilter(page);
});

// Color and attribute rendering is expressed through the app's CSS vocabulary
// (cwf-/cwb- WeeChat palette colors, cof-/cob- theme colors, cef-/ceb- terminal
// colors, a-* / a-no-* attributes), so these tests assert those classes on the
// spans the chat view actually renders.
function rowWith(text: string) {
    return page.locator('[data-testid="bufferline-row"]').filter({ hasText: text });
}

/** The CSS actually painted on an element, not just the classes it carries. */
function painted(locator: import('@playwright/test').Locator, property: string): Promise<string> {
    return locator.evaluate((el, prop) => getComputedStyle(el).getPropertyValue(prop), property);
}

test.describe('message colors and attributes', () => {
    test('an IRC foreground color renders as a WeeChat palette color class', async () => {
        const tag = `color-fg-${Date.now()}`;
        // The gbtest control sends mIRC \x0304…\x03; WeeChat relays it as its own
        // color control, and IRC color 04 maps to the lightred palette entry.
        await irc.sendColored('#glowing-bear', `${tag} red`, '04');

        const row = rowWith(`${tag} red`);
        await expect(row).toBeVisible({ timeout: 10000 });
        const colored = row.locator('span.cwf-lightred');
        await expect(colored).toContainText(`${tag} red`);
        // A class alone is not a color: the text must actually be painted differently
        // from the surrounding default chat text.
        expect(await painted(colored, 'color')).not.toBe(await painted(row.locator('.message-content'), 'color'));
    });

    test('an IRC foreground and background color render as both classes', async () => {
        const tag = `color-fgbg-${Date.now()}`;
        // IRC 04 → lightred, IRC 02 → blue.
        await irc.sendColored('#glowing-bear', `${tag} two colors`, '04', '02');

        const row = rowWith(`${tag} two colors`);
        await expect(row).toBeVisible({ timeout: 10000 });
        const colored = row.locator('span.cwf-lightred.cwb-blue');
        await expect(colored).toContainText(`${tag} two colors`);
        expect(await painted(colored, 'background-color')).not.toBe('rgba(0, 0, 0, 0)');
    });

    test('an out-of-palette IRC color index renders as a terminal color class', async () => {
        const tag = `color-ext-${Date.now()}`;
        // IRC 28 is not a palette color: WeeChat maps it to terminal color 88.
        await irc.sendColored('#glowing-bear', `${tag} extended`, '28');

        const row = rowWith(`${tag} extended`);
        await expect(row).toBeVisible({ timeout: 10000 });
        await expect(row.locator('span.cef-88')).toContainText(`${tag} extended`);
    });

    test('mIRC bold renders as the bold attribute class and leaves no marker in the text', async () => {
        const tag = `bold-${Date.now()}`;
        await irc.sendMessage('#glowing-bear', `\x02${tag} bold\x02`);

        const row = rowWith(`${tag} bold`);
        await expect(row).toBeVisible({ timeout: 10000 });
        await expect(row.locator('span.a-b')).toContainText(`${tag} bold`);
        await expect(row.locator('td.message')).not.toContainText('*');
    });

    test('mIRC strikethrough renders as dim, which is how WeeChat renders it', async () => {
        const tag = `strike-${Date.now()}`;
        await irc.sendMessage('#glowing-bear', `\x1e${tag} struck\x1e`);

        const row = rowWith(`${tag} struck`);
        await expect(row).toBeVisible({ timeout: 10000 });
        const struck = row.locator('span.a-d');
        await expect(struck).toContainText(`${tag} struck`);
        await expect(struck).toHaveCSS('opacity', '0.7');
    });

    test('an mIRC reset clears the attribute for the text that follows', async () => {
        const tag = `reset-${Date.now()}`;
        await irc.sendMessage('#glowing-bear', `\x02${tag} bold\x0f plain tail`);

        const row = rowWith(`${tag} bold`);
        await expect(row).toBeVisible({ timeout: 10000 });
        const bold = row.locator('span.a-b');
        await expect(bold).toContainText(`${tag} bold`);
        await expect(bold).toHaveCSS('font-weight', '700');

        // The tail is a separate run that states every attribute explicitly,
        // because the reset cleared them.
        const tail = row.locator('span.token-group').filter({ hasText: 'plain tail' });
        await expect(tail).toHaveText('plain tail');
        await expect(tail).toHaveClass(/a-no-b/);
        await expect(tail).toHaveCSS('font-weight', '400');
    });

    test('an mIRC hex color renders as the nearest terminal color class', async () => {
        const tag = `hex-color-${Date.now()}`;
        // #ff0000 is an exact entry in WeeChat's 256-color table (index 9).
        await irc.sendMessage('#glowing-bear', `\x04ff0000${tag} hex\x04`);

        const row = rowWith(`${tag} hex`);
        await expect(row).toBeVisible({ timeout: 10000 });
        const colored = row.locator('span.cef-9');
        await expect(colored).toContainText(`${tag} hex`);
        // .cef-9 is a literal hex color in the stylesheet, so the painted value is fixed.
        await expect(colored).toHaveCSS('color', 'rgb(255, 0, 0)');
    });

    test('an action message renders its prefix with a theme color class', async () => {
        const tag = `action-${Date.now()}`;
        // CTCP ACTION renders with WeeChat's action prefix, whose color is a theme option.
        await irc.sendMessage('#glowing-bear', `\x01ACTION ${tag} waves\x01`);

        const row = rowWith(`${tag} waves`);
        await expect(row).toBeVisible({ timeout: 10000 });
        const prefix = row.locator('.prefix-part').first();
        await expect(prefix).toHaveClass(/cof-|cwf-/);
    });
});

test.describe('the legacy relay path', () => {
    let legacyPage: import('@playwright/test').Page;

    test.beforeAll(async ({ browser }) => {
        // Same adapter, different transport: the legacy relay hands the line to the
        // protocol class in lib/weechat.ts, which delegates to the same parser.
        legacyPage = await createConnectedPage(browser, { settings: { protocol: 'legacy' }, port: '9001' });
        await waitForTransport(legacyPage, 'legacy');
        await waitForBuffer(legacyPage, '#glowing-bear', 15000);
        await switchToBuffer(legacyPage, '#glowing-bear');
    });

    test.afterAll(async () => {
        await legacyPage.close();
    });

    test('a colored IRC message renders with the same color class over the legacy relay', async () => {
        const tag = `legacy-color-${Date.now()}`;
        await irc.sendColored('#glowing-bear', `${tag} legacy red`, '04');

        const row = legacyPage.locator('[data-testid="bufferline-row"]').filter({ hasText: `${tag} legacy red` });
        await expect(row).toBeVisible({ timeout: 10000 });
        await expect(row.locator('span.cwf-lightred')).toContainText(`${tag} legacy red`);
    });
});

test.describe('nick and topic colors', () => {
    test('nicklist entries carry a WeeChat or theme color class', async () => {
        await switchToBuffer(page, '#glowing-bear');
        const nickNames = page.locator('[data-testid="nick-item"] span.nick-name');
        await expect(nickNames.first()).toBeVisible({ timeout: 10000 });

        const classes = await nickNames.evaluateAll((els) => els.map((el) => el.className));
        const colored = classes.filter((value) => /cwf-|cof-|cef-/.test(value));
        expect(colored.length, 'at least one nick should be rendered with a color class').toBeGreaterThan(0);
    });

    test('a colored topic renders with its color class in the topic modal', async () => {
        const tag = `topic-color-${Date.now()}`;
        await irc.setTopic('#glowing-bear', `\x0304${tag} topic\x03`);
        await switchToBuffer(page, '#glowing-bear');

        await expect(page.locator('.topic-text')).toContainText(`${tag} topic`, { timeout: 10000 });
        await page.getByTestId('topic-bar').click();

        const body = page.locator('.topic-modal-body');
        await expect(body).toBeVisible({ timeout: 5000 });
        await expect(body.locator('span.cwf-lightred')).toContainText(`${tag} topic`);

        await page.getByTestId('topic-modal-close').click();
    });
});
