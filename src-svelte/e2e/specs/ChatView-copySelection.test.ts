import { test, expect, type Locator } from '@playwright/test';
import { createConnectedPage } from '../fixtures/auth';
import { waitForBuffer, switchToBuffer } from '../helpers/buffers';
import { waitForChatSettled } from '../helpers/waits';
import { botSayVisible } from '../helpers/messages';
import { setupEffectOrphanFilter } from '../helpers/pageerror';

let page: import('@playwright/test').Page;
let context: import('@playwright/test').BrowserContext;

test.describe.configure({ mode: 'serial' });

// The copy shortcut is the platform's own: Chromium on macOS copies with
// Meta+C, everywhere else with Control+C.
const copyKey = process.platform === 'darwin' ? 'Meta+c' : 'Control+c';

// The clipboard is shared by every spec in the browser, so a copy that did
// nothing would otherwise read back another spec's leftovers. Seeding a
// sentinel makes "nothing was copied" fail as itself.
const SENTINEL = '__gb_copy_sentinel__';

test.beforeAll(async ({ browser }) => {
    // Reading the clipboard back is the only way to assert what a user actually
    // pastes, and that needs the clipboard permission.
    context = await browser.newContext();
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    page = await createConnectedPage(context);
    setupEffectOrphanFilter(page);
    await waitForBuffer(page, '#glowing-bear', 15000);
    await switchToBuffer(page, '#glowing-bear');
});

test.afterAll(async () => {
    await context.close();
});

test.beforeEach(async () => {
    setupEffectOrphanFilter(page);
});

/** The chat container's visible band, in viewport coordinates. */
function chatViewport(): Promise<{ top: number; bottom: number } | null> {
    return page.evaluate(() => {
        const el = document.querySelector('[data-testid="chat-messages"]');
        if (!el) return null;
        const r = (el as HTMLElement).getBoundingClientRect();
        return { top: r.top, bottom: r.bottom };
    });
}

/** Drag-select from the first character of one cell to the last character of
 *  another — the way a reader selects a stretch of chat. */
async function dragSelect(from: Locator, to: Locator): Promise<void> {
    // A drag is a mouse gesture: it can only select what the reader can see.
    await from.scrollIntoViewIfNeeded();
    await to.scrollIntoViewIfNeeded();
    await waitForChatSettled(page);

    const a = await from.boundingBox();
    const b = await to.boundingBox();
    const view = await chatViewport();
    if (!a || !b) throw new Error('selection anchors are not laid out');
    if (!view) throw new Error('the chat container is not mounted');
    for (const box of [a, b]) {
        if (box.y < view.top || box.y + box.height > view.bottom) {
            throw new Error(
                `selection anchor at y=${Math.round(box.y)} is outside the chat viewport ` +
                `(${Math.round(view.top)}..${Math.round(view.bottom)})`,
            );
        }
    }

    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    await page.mouse.move(a.x + 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width - 2, b.y + b.height / 2, { steps: 24 });
    await page.mouse.up();

    // A copy proves nothing if the drag selected nothing.
    await expect
        .poll(async () => (await page.evaluate(() => window.getSelection()?.toString() ?? '')).length)
        .toBeGreaterThan(0);
}

/** Select one exact substring of a cell, the way a reader grabs a URL out of a
 *  message and wants only the URL. */
async function selectSubstring(cell: Locator, needle: string): Promise<void> {
    const found = await cell.evaluate((el, text) => {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const at = (node as Text).data.indexOf(text);
            if (at < 0) continue;
            const range = document.createRange();
            range.setStart(node as Text, at);
            range.setEnd(node as Text, at + text.length);
            const sel = window.getSelection();
            sel?.removeAllRanges();
            sel?.addRange(range);
            return true;
        }
        return false;
    }, needle);
    expect(found, `could not select ${needle} inside the message cell`).toBe(true);
}

/** The row's prefix as it is shown — the prefix parts joined, brackets excluded. */
function shownPrefix(row: Locator): Promise<string> {
    return row.evaluate((tr) =>
        Array.from(tr.querySelectorAll('.prefix-part')).map((part) => part.textContent ?? '').join(''),
    );
}
async function copySelection(): Promise<string> {
    await page.evaluate((seed: string) => navigator.clipboard.writeText(seed), SENTINEL);
    // A keyboard copy goes to the focused control. If the composer still holds
    // focus, the chat selection is not what gets copied.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press(copyKey);
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard, 'the copy produced nothing — the clipboard still holds the sentinel').not.toBe(SENTINEL);
    return clipboard;
}

test.describe('copying chat text', () => {
    test('two selected lines come out as two lines, time then nick then text', async () => {
        const tag = `copy-two-${Date.now()}`;
        await botSayVisible(page, `${tag} first`);
        await botSayVisible(page, `${tag} second`);

        const rows = page.locator('[data-testid="bufferline-row"]').filter({ hasText: tag });
        await expect(rows).toHaveCount(2);

        await dragSelect(rows.nth(0).locator('td.time'), rows.nth(1).locator('td.message'));
        const clipboard = await copySelection();

        const lines = clipboard.split('\n');
        expect(lines, `copied as:\n${clipboard}`).toHaveLength(2);
        expect(clipboard, 'cell separators must not survive as tabs').not.toContain('\t');

        // The exact target format, built from what the row shows rather than from
        // what the clipboard returned: the row's own clock, the sender in brackets
        // with no stray space inside them, then what they said.
        const firstTime = (await rows.nth(0).locator('td.time').innerText()).trim();
        const secondTime = (await rows.nth(1).locator('td.time').innerText()).trim();
        expect(lines[0], `copied as:\n${clipboard}`).toBe(`${firstTime} <${await shownPrefix(rows.nth(0))}> ${tag} first`);
        expect(lines[1], `copied as:\n${clipboard}`).toBe(`${secondTime} <${await shownPrefix(rows.nth(1))}> ${tag} second`);
    });

    test('one selected line comes out as one line', async () => {
        const tag = `copy-one-${Date.now()}`;
        await botSayVisible(page, `${tag} solo`);

        const row = page.locator('[data-testid="bufferline-row"]').filter({ hasText: tag }).first();
        await dragSelect(row.locator('td.time'), row.locator('td.message'));
        const clipboard = await copySelection();

        const time = (await row.locator('td.time').innerText()).trim();
        expect(clipboard, `copied as:\n${clipboard}`).toBe(`${time} <${await shownPrefix(row)}> ${tag} solo`);
    });

    test('a partial selection stays partial: no time and no nick are added', async () => {
        const tag = `copy-partial-${Date.now()}`;
        await botSayVisible(page, `${tag} keep-this-part only`);

        const row = page.locator('[data-testid="bufferline-row"]').filter({ hasText: tag }).first();
        await row.scrollIntoViewIfNeeded();
        await selectSubstring(row.locator('td.message'), 'keep-this-part');
        const clipboard = await copySelection();

        expect(clipboard).toBe('keep-this-part');
    });
});
