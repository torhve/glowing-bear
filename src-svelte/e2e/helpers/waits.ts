import { Page, expect } from '@playwright/test';
import { irc } from './irc-control';
import { switchToBuffer } from './buffers';

/**
 * Condition-driven waits shared by the E2E specs.
 *
 * Every helper here waits for an observable end state — a row that rendered, a
 * nick that appeared, a value that settled — instead of waiting for a fixed
 * number of milliseconds. A fixed sleep passes when the product is broken and
 * the delay happened to be long enough; these fail instead.
 *
 * The one honest use of a clock in this suite is waiting for a product timer to
 * expire (ChatView's follow-settle window). Those waits go through
 * waitForChatSettled() below, which polls the app's own state rather than
 * guessing a duration.
 */

/** Escape a literal string for use inside a RegExp. */
function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A chat row whose text contains `text`. */
export function rowWithText(page: Page, text: string) {
    return page
        .locator('[data-testid="bufferline-row"]')
        .filter({ hasText: text })
        .first();
}

/** Wait until a message that was already sent is rendered in the chat view. */
export async function waitForRow(page: Page, text: string, timeout = 15000): Promise<void> {
    await expect(rowWithText(page, text), `row ${text} never rendered`).toBeVisible({ timeout });
}

/** Wait until the chat view holds at least `count` rendered rows. */
export async function waitForRowCountAtLeast(page: Page, count: number, timeout = 15000): Promise<void> {
    await expect
        .poll(async () => page.locator('[data-testid="bufferline-row"]').count(), { timeout })
        .toBeGreaterThanOrEqual(count);
}

/**
 * Wait until `nick` appears in the nicklist.
 * Proves a nick change actually reached WeeChat and the client, which is what
 * the botNick() + sleep pairs were trying to achieve.
 */
export async function waitForNickVisible(page: Page, nick: string, timeout = 15000): Promise<void> {
    const exact = new RegExp('^' + escapeRe(nick) + '$');
    await expect(
        page.getByTestId('nick-item').filter({ hasText: exact }).first(),
        `nick ${nick} never appeared in the nicklist`,
    ).toBeVisible({ timeout });
}

/**
 * Wait until an inactive buffer's unread badge reports at least `count` unread lines.
 *
 * The honest replacement for a grace period after flooding a buffer the user is not
 * looking at: there is no rendered row to wait for, but the buffer list's badge is the
 * app's own record of how many of those lines have arrived.
 */
async function readUnreadBadge(page: Page, bufferName: string): Promise<number> {
    // Read the badge in one page evaluation: a locator would fail actionability while
    // the badge does not exist yet, which is the normal state at the start of the wait.
    return page.evaluate((name) => {
        // The buffer list shows display names, which drop the leading '#' an IRC channel
        // carries in its hdata name.
        const needle = name.startsWith('#') ? name.slice(1) : name;
        const items = Array.from(document.querySelectorAll('[data-testid="buffer-item"]'));
        const item = items.find((el) => (el.textContent ?? '').includes(needle));
        const badge = item?.querySelector('[data-testid="unread-badge"]');
        const n = badge ? parseInt((badge.textContent ?? '').trim(), 10) : 0;
        return Number.isNaN(n) ? 0 : n;
    }, bufferName);
}

export async function waitForUnreadAtLeast(page: Page, bufferName: string, count: number, timeout = 15000): Promise<void> {
    await expect.poll(() => readUnreadBadge(page, bufferName), { timeout }).toBeGreaterThanOrEqual(count);
}

/**
 * Wait until the app considers a buffer fully read (no unread badge). Used where a spec
 * needs a clean unread baseline before creating unread on purpose.
 */
export async function waitForNoUnread(page: Page, bufferName: string, timeout = 15000): Promise<void> {
    await expect.poll(() => readUnreadBadge(page, bufferName), { timeout }).toBe(0);
}

/**
 * The app's global unread total, read back from the document title's "(N) " prefix.
 *
 * That prefix and the favicon badge are built from the same sum (unread plus
 * notifications, across every buffer), so it is the observable that says whether a badge
 * should be on screen at all.
 */
export async function globalUnreadTotal(page: Page): Promise<number> {
    const match = /^\((\d+)\)/.exec(await page.title());
    return match ? Number(match[1]) : 0;
}

/**
 * Clear unread on every buffer the sidebar shows, by switching to each one in turn.
 *
 * The badge is global, and notifications outrank unread in it, so a single leftover
 * notification anywhere in the shared gbtest session keeps a badge painted no matter what
 * the spec does next — an "absent badge" assertion then passes or fails on whatever the
 * previous spec left behind rather than on this spec's own actions.
 *
 * Switching is the only thing that reliably clears a buffer's hotlist entry: the IRC
 * plugin regenerates the entry for a buffer that is still unread, so a `/hotlist -clear`
 * is undone as soon as it lands (measured: the entry survives it, date and all).
 */
export async function absorbAllUnread(page: Page, timeout = 15000): Promise<void> {
    for (let pass = 0; pass < 8; pass++) {
        const names = await page.evaluate(() =>
            [...document.querySelectorAll('[data-testid="buffer-item"]')]
                .filter((row) => row.querySelector('[data-testid="unread-badge"]'))
                .map((row) => (row.querySelector('.buffer-name')?.textContent ?? '').trim())
                .filter((name) => name.length > 0),
        );
        if (names.length === 0) break;
        for (const name of names) {
            await switchToBuffer(page, name);
        }
    }
    await expect.poll(() => globalUnreadTotal(page), { timeout, intervals: [200] }).toBe(0);
}

/**
 * Wait until the chat container is no longer being pinned to the bottom by the
 * auto-follow loop, and has stayed quiet for `quietMs`.
 *
 * ChatView re-pins the viewport every frame while a new tail line lays out, and
 * treats scroll events inside FOLLOW_SETTLE_MS as noise. A spec that scrolls on
 * purpose while that window is open has its scroll overwritten, which is why the
 * specs used to sleep 400-900 ms here. ChatView exposes its own follow state
 * through __chatFollowState(), so the real condition is pollable.
 *
 * The quiet window matters: the pin loop starts one animation frame *after* the
 * new row is in the DOM, so a single "not busy" sample right after the row shows
 * up is not yet evidence that the follow is over.
 */
export async function waitForChatSettled(page: Page, quietMs = 300, timeout = 10000): Promise<void> {
    let quietSince = 0;
    await expect
        .poll(
            async () => {
                const state = await page.evaluate(() => {
                    const hook = (window as typeof window & {
                        __chatFollowState?: () => { pinning: boolean; pendingFrames: number; settlingUntil: number };
                    }).__chatFollowState;
                    // No ChatView mounted (or it unmounted): nothing can re-anchor the view.
                    if (typeof hook !== 'function') return { busy: false };
                    const s = hook();
                    return { busy: s.pinning || s.pendingFrames > 0 || performance.now() < s.settlingUntil };
                });
                if (state.busy) {
                    quietSince = 0;
                    return 'busy';
                }
                const now = Date.now();
                if (quietSince === 0) quietSince = now;
                return now - quietSince >= quietMs ? 'settled' : 'quiet';
            },
            { timeout },
        )
        .toBe('settled');
}

/**
 * Wait until an element's box has stopped changing size.
 *
 * The input bar grows as the textarea content wraps, and the chat container shrinks by
 * exactly that amount. A spec measuring the container after typing a long line must wait
 * for that growth to finish, which is what the fixed 300 ms stood in for.
 */
export async function waitForSizeStable(page: Page, selector: string, quietMs = 200, timeout = 8000): Promise<void> {
    let last = '';
    let since = 0;
    await expect
        .poll(
            async () => {
                const box = await page.locator(selector).first().boundingBox();
                if (!box) return 'no-box';
                const key = `${Math.round(box.height)}x${Math.round(box.width)}`;
                if (key !== last) {
                    last = key;
                    since = Date.now();
                    return 'resizing';
                }
                return Date.now() - since >= quietMs ? 'stable' : 'stable-briefly';
            },
            { timeout },
        )
        .toBe('stable');
}

/**
 * Prove a bot nick change reached WeeChat.
 *
 * The relay sends no nicklist diff for the gbtest bot's NICK, so the only observable
 * proof that a change took effect is a line stored under the new nick. Probe with a
 * fresh line each round and read the prefix it landed under; the wait ends on the first
 * line the server actually wrote under `nick`.
 */
export async function waitForBotNickApplied(page: Page, nick: string, channel: string, label: string, timeout = 20000): Promise<void> {
    await expect
        .poll(
            async () => {
                const probe = `${label}-${Date.now()}`;
                await irc.sendMessage(channel, probe);
                const row = rowWithText(page, probe);
                if (!(await row.isVisible().catch(() => false))) return 'no-row';
                const prefix = await row.locator('td.prefix').textContent();
                return (prefix ?? '').includes(nick) ? 'applied' : 'old-nick';
            },
            { timeout, intervals: [250] },
        )
        .toBe('applied');
}
