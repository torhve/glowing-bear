import { test, expect, type Page } from '@playwright/test';
import { createConnectedPage } from '../fixtures/auth';
import { setupEffectOrphanFilter } from '../helpers/pageerror';
import { switchToBuffer } from '../helpers/buffers';
import { irc } from '../helpers/irc-control';
import { openSpecChatChannel, closeSpecChatChannel } from '../helpers/spec-chat-channel';
import { openSettings, closeSettings } from '../helpers/settings';

/**
 * Issue #19: a search result that matched on its channel topic looked like a random row.
 *
 * The dialog filtered on short name, full name, buffer number and topic, but drew only the
 * first three. A channel whose topic held the query appeared with no mark anywhere on it, so
 * the reader could not tell a match from a coincidence. The row now prints a third line — the
 * part of the topic that holds the match — and marks the query in the names it does show.
 *
 * Serial: it joins a channel and sets that channel's topic on the shared fixture relay.
 */
test.describe.configure({ mode: 'serial' });

// The word the whole spec searches for. It appears in no fixture buffer name, so a row that
// shows it without carrying it in its own name can only have matched on its topic.
const QUERY = 'twitch';

// Longer than the topic line can print at the shipped dialog width (~75 characters), so the
// line has to cut, and long enough that the cut lands away from the match.
const TOPIC = 'Level design, engine plumbing and shipping dates. Weekly dev stream on '
    + 'twitch; recordings are linked in the channel sidebar.';

let page: Page;
let channel = '';

interface SearchRow {
    name: string;
    fullName: string;
    /** The topic line's own text, without the screen-reader label, or null when it prints none. */
    topic: string | null;
    topicMarks: string[];
    nameMarks: string[];
}

function readSearchRows(): Promise<SearchRow[]> {
    return page.$$eval('.buffer-search-item', (els) => els.map((el) => {
        const topicEl = el.querySelector('.buffer-search-topic');
        // The line carries a screen-reader label of its own; the assertions are about the topic.
        const ownText = topicEl
            ? Array.from(topicEl.childNodes)
                .filter((n) => !(n instanceof HTMLElement && n.classList.contains('sr-only')))
                .map((n) => n.textContent ?? '')
                .join('')
            : '';
        return {
            name: (el.querySelector('.buffer-search-shortname')?.textContent ?? '').trim(),
            fullName: (el.querySelector('.buffer-search-fullname')?.textContent ?? '').trim(),
            topic: topicEl ? ownText.trim() : null,
            topicMarks: Array.from(el.querySelectorAll('.buffer-search-topic mark'))
                .map((m) => m.textContent ?? ''),
            nameMarks: Array.from(el.querySelectorAll('.buffer-search-shortname mark, .buffer-search-fullname mark'))
                .map((m) => m.textContent ?? ''),
        } satisfies SearchRow;
    }));
}

async function searchFor(query: string): Promise<SearchRow[]> {
    await openSearch();
    await page.getByTestId('buffer-search').fill(query);

    // Wait for the list to stop changing, so the assertions read the rows this query produced
    // and not a list still being filtered. Two matching reads 150 ms apart is that proof; the
    // assertions themselves decide whether the rows are the right ones.
    let previous = '';
    await expect.poll(async () => {
        const snapshot = JSON.stringify((await readSearchRows()).map((r) => r.name));
        const settled = snapshot !== '[]' && snapshot === previous;
        previous = snapshot;
        return settled;
    }, { timeout: 10000, intervals: [150] }).toBe(true);
    return readSearchRows();
}

function rowFor(rows: SearchRow[], name: string): SearchRow {
    const row = rows.find((r) => r.name === name);
    expect(row, `${name} is missing from the search rows ${JSON.stringify(rows.map(r => r.name))}`)
        .toBeTruthy();
    return row!;
}

/** Opening a dialog that is already open would toggle it shut, so this one checks first. */
async function openSearch() {
    if (await page.getByTestId('buffer-search').isVisible().catch(() => false)) return;
    await page.getByTestId('search-button').click();
    await expect(page.getByTestId('buffer-search')).toBeVisible();
}

/** Closes with the dialog's own button: `+page.svelte` reads two Escapes in 500 ms as "leave". */
async function closeSearch() {
    await page.getByTestId('buffer-search-close').click();
    await expect(page.getByTestId('buffer-search')).toBeHidden();
}

/**
 * Contrast between one element's text and the surface it is really painted on.
 *
 * The row's accent is a `color-mix()` value, which Chromium reports as `oklab(...)`, so the
 * colours are handed to a canvas and read back as pixels instead of being parsed here. That is
 * the same compositing the browser does.
 */
async function textContrast(selector: string): Promise<{ color: string, background: string, row: string, ratio: number }> {
    return page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) throw new Error(`no element matches ${sel}`);

        const canvas = document.createElement('canvas');
        canvas.width = 1;
        canvas.height = 1;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('no 2d canvas to composite colours with');

        const paint = (colour: string, over?: [number, number, number]): [number, number, number] => {
            ctx.clearRect(0, 0, 1, 1);
            if (over) {
                ctx.fillStyle = `rgb(${over[0]}, ${over[1]}, ${over[2]})`;
                ctx.fillRect(0, 0, 1, 1);
            }
            ctx.fillStyle = colour;
            ctx.fillRect(0, 0, 1, 1);
            const [r = 0, g = 0, b = 0] = ctx.getImageData(0, 0, 1, 1).data;
            return [r, g, b];
        };

        // Back to front: the page background first, then each element that paints one.
        const layers: string[] = [];
        for (let n: Element | null = el; n; n = n.parentElement) layers.push(getComputedStyle(n).backgroundColor);
        layers.reverse();
        let surface: [number, number, number] = [255, 255, 255];
        for (const layer of layers) {
            if (layer === 'transparent' || layer === 'rgba(0, 0, 0, 0)') continue;
            surface = paint(layer, surface);
        }

        const colour = getComputedStyle(el).color;
        const rgb = paint(colour, surface);
        const luminance = (c: [number, number, number]) => {
            const f = (v: number) => {
                const s = v / 255;
                return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
            };
            return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
        };
        const l1 = luminance(rgb);
        const l2 = luminance(surface);
        const row = el.closest('.buffer-search-item');
        const vars = row
            ? ['--gb-accent', '--color-accent-strong']
                .map((v) => `${v}=${getComputedStyle(row).getPropertyValue(v).trim() || '(unset)'}`)
                .join(' ')
            : '';
        const rowInfo = row
            ? `${row.className} bg=${getComputedStyle(row).backgroundColor} ${vars} theme=${document.documentElement.getAttribute('data-theme')}`
            : 'no row';
        return {
            color: `${colour} -> rgb(${rgb.join(', ')})`,
            background: `rgb(${surface.join(', ')})`,
            row: rowInfo,
            ratio: (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05),
        };
    }, selector);
}
/**
 * Wait until the row has finished painting its selection.
 *
 * A row changes colour with a 150 ms `transition-colors`, and `getComputedStyle` reports the
 * value the transition is at, not the one it is heading for. Measuring straight after the row
 * becomes selected reads the starting value, which for a row that was plain before is fully
 * transparent. Two matching reads 200 ms apart prove the transition is over.
 */
async function waitForPainted(selector: string) {
    let previous = '';
    await expect.poll(async () => {
        const now = await page.evaluate((sel) => {
            const row = document.querySelector(sel)?.closest('.buffer-search-item');
            return row
                ? `${getComputedStyle(row).backgroundColor}|${getComputedStyle(row).color}`
                : 'missing';
        }, selector);
        const settled = now === previous && now !== 'missing';
        previous = now;
        return settled;
    }, { timeout: 10000, intervals: [200] }).toBe(true);
}

test.beforeAll(async ({ browser }) => {
    page = await createConnectedPage(browser);
    setupEffectOrphanFilter(page);

    channel = await openSpecChatChannel(page, 'topicmatch');
    await irc.setTopic(channel, TOPIC);

    // The topic has to reach WeeChat before the dialog is asked about it: the topic bar of this
    // very buffer is the proof it did.
    await switchToBuffer(page, channel);
    await expect(page.locator('.topic-text').first()).toContainText(QUERY, { timeout: 20000 });
});

test.afterAll(async () => {
    closeSpecChatChannel(channel);
    await page.close();
});

test('a row that matched on its channel topic says so, and marks the match', async () => {
    const rows = await searchFor(QUERY);
    const row = rowFor(rows, channel);

    expect(row.topic, `${channel} matched only on its topic, so its row must show one`)
        .not.toBeNull();
    const shown = row.topic ?? '';
    expect(shown).toContain(QUERY);
    expect(row.topicMarks, `the topic line must mark the query, got ${JSON.stringify(row.topicMarks)}`)
        .toContain(QUERY);

    // The names carry no mark: they do not hold the query, and a mark there would be a lie.
    expect(row.nameMarks).toEqual([]);

    // The topic is longer than the line, so the line cuts and says it cut.
    expect(shown).toContain('\u2026');
    expect(shown.length).toBeLessThan(TOPIC.length);
    await closeSearch();
});

test('the topic excerpt never cuts inside the matched word', async () => {
    const rows = await searchFor(QUERY);
    const row = rowFor(rows, channel);
    const shown = row.topic ?? '';

    // A cut through 'twitch' would leave a fragment of it, and a fragment of the query
    // explains nothing: every visible cut keeps the whole word.
    expect(shown).toContain(QUERY);
    const cuts = shown.split('\u2026');
    for (const piece of cuts) {
        const at = piece.toLowerCase().indexOf(QUERY);
        if (at < 0) continue;
        expect(piece.slice(at, at + QUERY.length)).toBe(QUERY);
    }
    await closeSearch();
});

test('the topic line fits the room the browser gives it, at the shipped and the phone width', async () => {
    // The excerpt is cut in characters the row can hold, so the browser should never have to
    // cut it a second time. A line wider than its own box means the measured character budget
    // was wrong for the font and the glyphs the row really drew.
    const audit = async () => {
        await searchFor(QUERY);
        const bad = await page.evaluate(() =>
            Array.from(document.querySelectorAll('.buffer-search-topic'))
                .map((line) => {
                    const mark = line.querySelector('mark');
                    const box = line.getBoundingClientRect();
                    return {
                        shown: line.textContent ?? '',
                        clipped: line.scrollWidth > line.clientWidth + 1,
                        matchOutside: mark !== null
                            && mark.getBoundingClientRect().right > box.left + line.clientWidth + 1,
                    };
                })
                .filter((row) => row.clipped || row.matchOutside),
        );
        expect(bad, `topic lines the browser had to cut: ${JSON.stringify(bad)}`).toEqual([]);
        await closeSearch();
    };

    await audit();

    // The narrow dialog is where a character budget is easiest to get wrong: it leaves the
    // least room, and it is the width where a dropped context row matters most.
    await page.setViewportSize({ width: 380, height: 700 });
    await audit();
    await page.setViewportSize({ width: 1280, height: 720 });
});
test('a row that matched on its name marks the name and prints no topic line', async () => {
    const fragment = channel.slice(1, 7); // the spec channel's own name, without the '#'
    const rows = await searchFor(fragment);
    const row = rowFor(rows, channel);

    expect(row.nameMarks, `searching a name must mark that name, got ${JSON.stringify(row.nameMarks)}`)
        .toContain(fragment);
    expect(row.fullName).toContain(fragment);
    expect(row.topic, `${channel} matched on its name here, so its topic line must stay off`)
        .toBeNull();
    await closeSearch();
});

test('the topic line and its match stay readable in both shipped palettes', async () => {
    const darkSlot = page.getByTestId('theme-dark-selector');
    await openSettings(page);
    const originalSlot = await darkSlot.inputValue();
    await closeSettings(page);

    for (const palette of [originalSlot, 'light']) {
        await openSettings(page);
        await darkSlot.selectOption({ value: palette });
        await closeSettings(page);

        const rows = await searchFor(QUERY);
        const idx = rows.findIndex((r) => r.name === channel);
        expect(idx, `${channel} missing from the search rows`).toBeGreaterThanOrEqual(0);

        // Measured on this spec's own row, not on whichever row the dialog happened to list first.
        const row = `.buffer-search-item[data-search-index="${idx}"]`;
        await waitForPainted(row);
        const line = await textContrast(`${row} .buffer-search-topic`);
        const mark = await textContrast(`${row} .buffer-search-topic mark`);
        await closeSearch();

        // WCAG AA for body-size text: 4.5 to 1. Measured against the surface each one is
        // really painted on, not against the palette's nominal background.
        const says = (what: string, m: { ratio: number, color: string, background: string, row: string }) =>
            `palette ${palette} ${what}: ${m.ratio.toFixed(2)} (${m.color} on ${m.background}) row [${m.row}]`;
        expect(line.ratio, says('topic line', line)).toBeGreaterThanOrEqual(4.5);
        expect(mark.ratio, says('topic match', mark)).toBeGreaterThanOrEqual(4.5);
    }

    await openSettings(page);
    await darkSlot.selectOption({ value: originalSlot });
    await closeSettings(page);
});

test('the keyboard-selected row keeps its topic line readable', async () => {
    await openSearch();
    const row = rowFor(await searchFor(QUERY), channel);
    expect(row.topic, `${channel} was expected to show a topic line`).not.toBeNull();

    // The dialog selects its first row when it opens, and stepping down is how a reader gets
    // here. Polling each step keeps the spec from assuming which row it started on.
    await expect.poll(async () => {
        const active = await page.locator('.buffer-search-item-active .buffer-search-shortname')
            .textContent();
        if ((active ?? '').includes(channel)) return true;
        await page.keyboard.press('ArrowDown');
        return false;
    }, { timeout: 20000, intervals: [250] }).toBe(true);

    await waitForPainted('.buffer-search-item-active .buffer-search-topic');
    const line = await textContrast('.buffer-search-item-active .buffer-search-topic');
    const mark = await textContrast('.buffer-search-item-active .buffer-search-topic mark');
    const name = await textContrast('.buffer-search-item-active .buffer-search-fullname');
    await closeSearch();

    const says = (what: string, m: { ratio: number, color: string, background: string, row: string }) =>
        `selected row ${what}: ${m.ratio.toFixed(2)} (${m.color} on ${m.background}) row [${m.row}]`;
    expect(line.ratio, says('topic line', line)).toBeGreaterThanOrEqual(4.5);
    expect(mark.ratio, says('topic match', mark)).toBeGreaterThanOrEqual(4.5);
    expect(name.ratio, says('full name', name)).toBeGreaterThanOrEqual(4.5);
});
