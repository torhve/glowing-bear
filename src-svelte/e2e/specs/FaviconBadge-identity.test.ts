import { test, expect } from '@playwright/test';
import { createConnectedPage } from '../fixtures/auth';
import { setupEffectOrphanFilter } from '../helpers/pageerror';
import { switchToBuffer } from '../helpers/buffers';
import { sendSequence } from '../helpers/irc-control';
import { sendWeechatCommand } from '../helpers/connection';

/**
 * The favicon badge must not be repainted when the repaint cannot change it.
 *
 * The badge renders `formatCount(unread)`, not the raw count: every unread total
 * from 100 to 999 draws the same "99+" picture. Before the identity cache a flood
 * redrew and re-encoded the icon on every batch — measured 3999 href writes
 * producing 106 distinct images — each one making the browser decode a new PNG
 * and repaint the tab icon to show the pixels it was already showing.
 *
 * These tests watch the href attribute, which is what the tab icon actually
 * reads, so they are about the visible icon rather than how many times the
 * renderer was asked.
 *
 * Note on the numbers: the app's total unread is read back from the title rather
 * than assumed, because gbtest is shared across specs and the tally a flood
 * produces depends on how the relay batches it. Nothing here targets an absolute
 * count; each test reads the current total and works relative to it.
 */

const FLOOD = '#glowing-bear';
/** Kept on screen so messages to FLOOD stay unread. */
const VIEW = 'gbtest';

/** Mirrors `formatCount()` in lib/faviconBadge.ts — this is the specification. */
function label(count: number): string {
    if (count > 999999) return '999k+';
    if (count >= 1000) return `${Math.floor(count / 1000)}k+`;
    if (count > 99) return '99+';
    return String(count);
}

/** The total unread the app advertises, from `updateTitle()`'s `(N)` prefix. */
async function totalUnread(page: import('@playwright/test').Page): Promise<number> {
    return page.evaluate(() => {
        const m = /^\((\d+)\)/.exec(document.title);
        return m ? Number(m[1]) : 0;
    });
}

async function watchFavicon(page: import('@playwright/test').Page) {
    await page.evaluate(() => {
        const w = { writes: 0 };
        (window as any).__favwatch = w;
        const obs = new MutationObserver((muts) => {
            for (const m of muts) {
                if (m.type !== 'attributes') continue;
                const t = m.target as HTMLElement;
                if (t.tagName !== 'LINK' || (t.getAttribute('rel') || '').toLowerCase() !== 'icon') continue;
                w.writes++;
            }
        });
        obs.observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['href'] });
    });
}

const writes = (page: import('@playwright/test').Page) =>
    page.evaluate(() => (window as any).__favwatch.writes as number);

const href = (page: import('@playwright/test').Page) =>
    page.evaluate(() => {
        const link = document.querySelector<HTMLLinkElement>("link[rel='icon'][sizes='32x32']");
        return link ? link.getAttribute('href') : null;
    });

const msgs = (tag: string, n: number) => Array.from({ length: n }, (_, i) => `fav ${tag} ${i}`);

/**
 * Put the badge back in the unread branch.
 *
 * `updateFavico()` prefers the notification count over the unread count, so a
 * leftover highlight anywhere in WeeChat makes the icon show notifications and
 * immune to the unread the tests are producing. Clearing the hotlist first is
 * what makes "the unread label changed, so the icon must change" true.
 */
async function clearUnread(page: import('@playwright/test').Page) {
    await sendWeechatCommand(page, 'hotlist clear');
    await switchToBuffer(page, FLOOD);
    await switchToBuffer(page, VIEW);
}

/**
 * A total unread whose label survives one more unread message.
 *
 * The badge only changes when the *label* changes, so a test about "the label did
 * not change" has to start inside a label window. Below 100 every message moves
 * the label, and a total sitting exactly on a boundary (99, 999, 1999) does not
 * qualify either, so the count is nudged until the window is stable.
 */
async function stableTotal(page: import('@playwright/test').Page, tag: string): Promise<number> {
    let t = await totalUnread(page);
    for (let round = 0; round <= 10; round++) {
        if (t >= 100 && label(t + 1) === label(t)) return t;
        if (round === 10) break;
        // A flood is tallied in relay batches, not one per message, so the
        // count has to be read back after the flood has drained.
        await sendSequence(FLOOD, msgs(`${tag}#${round}`, 200));
        await waitForUnreadSettled(page);
        const seen = await totalUnread(page);
        expect(seen).toBeGreaterThan(t);
        t = seen;
    }
    throw new Error(`no stable label window reached (last total ${t}, label ${label(t)})`);
}

/**
 * Wait until the total unread stops moving.
 *
 * A flood is still draining after the send returns, so a badge update from the
 * *previous* batch would otherwise be counted as a rewrite caused by the message
 * under test.
 */
async function waitForUnreadSettled(page: import('@playwright/test').Page) {
    let last = -1;
    let quiet = 0;
    await expect(async () => {
        const now = await totalUnread(page);
        quiet = now === last ? quiet + 1 : 0;
        last = now;
        expect(quiet).toBeGreaterThanOrEqual(5);
    }).toPass({ timeout: 30000, intervals: [200] });
}

/** Wait until the app's total unread has moved past `from`. */
async function unreadAbove(page: import('@playwright/test').Page, from: number) {
    await expect(async () => {
        expect(await totalUnread(page)).toBeGreaterThan(from);
    }).toPass({ timeout: 20000, intervals: [200] });
}

test.describe('favicon badge repaint identity', () => {
    test.describe.configure({ mode: 'serial' });

    let page: import('@playwright/test').Page;

    let startBuffer: string | null = null;

    test.beforeAll(async ({ browser }) => {
        page = await createConnectedPage(browser);
        setupEffectOrphanFilter(page);
        // These tests read and clear unread on the flood buffer, which is a
        // visible change to shared gbtest state; remember where the app was so
        // later specs in the serial project are not handed a different buffer.
        startBuffer = await page.evaluate(() => {
            const m = /Glowing Bear - (.+?) - IRC:/.exec(document.title);
            return m ? m[1] : null;
        });
        await watchFavicon(page);
    });

    test.afterAll(async () => {
        // The private messages above leave highlights in WeeChat's hotlist, and a
        // leftover highlight makes `updateFavico()` draw a notification badge
        // instead of resetting — which would break a later spec that asserts the
        // reset. Leave gbtest as found.
        await sendWeechatCommand(page, 'hotlist clear').catch(() => {});
        await switchToBuffer(page, FLOOD).catch(() => {});
        if (startBuffer) await switchToBuffer(page, startBuffer).catch(() => {});
        await page.close().catch(() => {});
    });

    test('unread totals that render the same label leave the icon untouched', async () => {
        await clearUnread(page);
        const t = await stableTotal(page, 'same');

        await waitForUnreadSettled(page);

        const firstHref = await href(page);
        expect(firstHref).not.toBe('/favicon.png');
        expect(label((await totalUnread(page)) + 1)).toBe(label(await totalUnread(page)));

        const before = await writes(page);
        await sendSequence(FLOOD, msgs('same+', 1));
        await unreadAbove(page, t);
        await waitForUnreadSettled(page);

        expect(await writes(page)).toBe(before);
        expect(await href(page)).toBe(firstHref);
    });

    test('a theme change repaints the icon even when the count is unchanged', async () => {
        await clearUnread(page);
        const t = await stableTotal(page, 'theme');

        await waitForUnreadSettled(page);
        const hrefBefore = await href(page);
        expect(hrefBefore).not.toBe('/favicon.png');

        // Follow the app wherever it started — it may sit on the light slot when
        // the system is in light mode — and flip to the other palette.
        const current = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
        const other = current === 'dark' ? 'light' : 'dark';
        await page.evaluate((theme) => {
            document.documentElement.setAttribute('data-theme', theme);
        }, other);

        // The theme change alone does not call the renderer; make the app update
        // the badge the way an incoming message would, at the same label.
        await sendSequence(FLOOD, msgs('theme+', 1));
        await unreadAbove(page, t);

        const hrefAfter = await href(page);
        await page.evaluate((theme) => {
            document.documentElement.setAttribute('data-theme', theme);
        }, current);

        expect(hrefAfter).not.toBe(hrefBefore);
    });
});
