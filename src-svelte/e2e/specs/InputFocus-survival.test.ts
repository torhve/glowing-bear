/**
 * What takes the composer's focus, and what does not.
 *
 * Two deliberate rules meet at the composer, and each is pinned from the side that
 * would break it.
 *
 *   - The composer is never focused on mount or on a buffer switch
 *     (`InputBar.svelte`). A click on a buffer row must not hand focus to the
 *     composer, and the reader must be able to take focus back immediately.
 *   - Keys are characters while the composer has focus. `handleQuickKeys` and
 *     `handleJumpToBuffer` both return early on `isTypingTarget()`, because Alt+7
 *     is the pipe character on a Norwegian layout: a quick key that fired while
 *     the reader was typing would eat the character and move them to another
 *     buffer. So Alt+digit must not switch buffers from the composer.
 *
 * It came out of a full serial run where `input.focus()` resolved and focused the
 * textarea, and the element stayed unfocused through five seconds of polling —
 * focus taken and kept away, not transiently dropped. Run directly here that
 * never happened: the watchdog recorded focus arriving on the textarea and
 * nothing taking it, with the same textarea node throughout and the chat shell
 * never swapped for the connection form. So the contract is kept, not the
 * reproduction. The watchdog stays in every test, because a focus failure is only
 * worth reading if it says what took the focus.
 */
import { test, expect } from '@playwright/test';
import { createConnectedPage } from '../fixtures/auth';
import { botSay } from '../helpers/messages';
import { switchToBuffer } from '../helpers/buffers';
import { expectInputFocused } from '../helpers/input';
import { setupEffectOrphanFilter } from '../helpers/pageerror';

const COMPOSER = 'message-input';
const FLOOD_COUNT = 30;

let page: import('@playwright/test').Page;

/** One focus transition, as the page recorded it. */
interface FocusRecord {
    /** `in` when an element gained focus, `out` when one lost it. */
    kind: 'in' | 'out';
    element: string;
    at: number;
}

declare global {
    interface Window {
        __focusLog?: FocusRecord[];
    }
}

/**
 * Record every focus transition on the capture phase, so an element that receives
 * focus and is then removed is still caught. The log is carried into the failure
 * message: the point of a focus failure is knowing what took the focus.
 */
async function watchFocus(target: import('@playwright/test').Page) {
    await target.evaluate(() => {
        const log: Window['__focusLog'] = [];
        window.__focusLog = log;
        const describe = (el: Element | null) => {
            if (!el) return '(none)';
            const testId = el.getAttribute('data-testid');
            const cls = (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean).slice(0, 3).join('.');
            return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${testId ? `[${testId}]` : ''}${cls ? `.${cls}` : ''}`;
        };
        document.addEventListener('focusin', (e) => {
            log.push({ kind: 'in', element: describe(e.target), at: Date.now() });
        }, true);
        document.addEventListener('focusout', (e) => {
            log.push({ kind: 'out', element: describe(e.target), at: Date.now() });
        }, true);
    });
}

/** Identity of the focused element: a test id when it has one, else tag and id. */
async function focusedIdentity(target: import('@playwright/test').Page): Promise<string> {
    return target.evaluate(() => {
        const el = document.activeElement;
        if (!el) return '(none)';
        return el.getAttribute('data-testid') ?? `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}`;
    });
}

async function focusLog(target: import('@playwright/test').Page): Promise<FocusRecord[]> {
    return target.evaluate(() => (window.__focusLog ?? []).slice(-12));
}

/**
 * Assert focus keeps sitting on the composer for a stretch of time. The polling
 * interval is the point: a theft that lands and is undone between two checks is
 * still a theft, and one check would miss it. On failure the recorded transitions
 * are appended, so the test names the element that took the focus.
 */
async function focusStaysOnComposer(target: import('@playwright/test').Page, context: string) {
    const started = Date.now();
    try {
        await expect.poll(() => focusedIdentity(target), { timeout: 3000, intervals: [100] }).toBe(COMPOSER);
    } catch (err) {
        const log = await focusLog(target);
        throw new Error(
            `${context}: the composer lost focus. Focus transitions since ${started}:\n`
            + log.map((ev) => `  ${ev.at - started}ms ${ev.kind} ${ev.element}`).join('\n'),
            { cause: err },
        );
    }
}

/** Which sidebar row carries the active marker. */
async function activeIndex(items: import('@playwright/test').Locator): Promise<number> {
    const count = await items.count();
    for (let i = 0; i < count; i++) {
        if (await items.nth(i).evaluate((el) => el.classList.contains('border-s-accent'))) return i;
    }
    throw new Error('no buffer row carries the active marker');
}

/** The first sidebar row that is not the active buffer, within Alt+1..Alt+9. */
async function pickSwitchTarget(items: import('@playwright/test').Locator): Promise<number> {
    const count = await items.count();
    expect(count, 'the sidebar needs a second buffer to switch to').toBeGreaterThanOrEqual(2);
    for (let i = 0; i < Math.min(count, 9); i++) {
        if (!(await items.nth(i).evaluate((el) => el.classList.contains('border-s-accent')))) return i;
    }
    throw new Error('every buffer within Alt+1..Alt+9 is already active');
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
    page = await createConnectedPage(browser);
    setupEffectOrphanFilter(page);
    await watchFocus(page);
});

test.afterAll(async () => {
    await page.close();
});

test('lines arriving while the composer is focused leave it focused', async () => {
    // botSay speaks in #glowing-bear, so that is the buffer that must be active.
    await switchToBuffer(page, '#glowing-bear');

    await page.getByTestId('message-input').focus();
    await expectInputFocused(page);

    // The reader types nothing while these land; the chat view projects them and
    // the viewport owner decides what that means for the scroll position.
    for (let i = 0; i < FLOOD_COUNT; i++) await botSay(`focus-keep-${i}`);
    await expect(
        page.locator('[data-testid="bufferline-row"] td.message').filter({ hasText: `focus-keep-${FLOOD_COUNT - 1}` }).first(),
        'the last line never arrived',
    ).toBeVisible({ timeout: 15000 });

    await focusStaysOnComposer(page, `${FLOOD_COUNT} lines arriving in the active channel`);
});

test('Alt+digit typed in the composer is a character, not a buffer switch', async () => {
    const items = page.getByTestId('buffer-item');
    const activeBefore = await activeIndex(items);

    await page.getByTestId('message-input').focus();
    await expectInputFocused(page);

    // Alt+7 is the pipe character on a Norwegian layout. The quick keys read
    // e.code precisely so this key can be typed, which means it must not also be
    // read as "jump to buffer 7".
    await page.keyboard.press('Alt+Digit7');
    await page.keyboard.press('Alt+Digit1');

    await expect(items.nth(activeBefore), 'a quick key switched the buffer from the composer').toHaveClass(/border-s-accent/);
    await expect(items.nth(activeBefore === 0 ? 1 : 0), 'a quick key landed on another buffer').not.toHaveClass(/border-s-accent/);
    await focusStaysOnComposer(page, 'after Alt+digit pressed in the composer');
});

test('a clicked buffer switch does not take the composer focus', async () => {
    const items = page.getByTestId('buffer-item');
    const target = await pickSwitchTarget(items);

    await page.getByTestId('message-input').focus();
    await expectInputFocused(page);

    await items.nth(target).click();
    await expect(items.nth(target), 'the click did not change the buffer').toHaveClass(/border-s-accent/);

    // Deliberate: the composer is not focused on a buffer switch. Asserting it
    // here keeps the rule honest — a future auto-focus would fail as a change to
    // intended behaviour, not as a flake.
    await expect(page.getByTestId('message-input'), 'the switch focused the composer on its own').not.toBeFocused();

    // And the reader can take it back immediately.
    await page.getByTestId('message-input').focus();
    await expectInputFocused(page);
    await focusStaysOnComposer(page, 'after taking focus back following a click switch');

    await switchToBuffer(page, '#glowing-bear');
});
