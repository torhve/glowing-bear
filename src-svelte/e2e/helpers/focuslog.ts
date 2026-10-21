/**
 * A record of who held focus, installed on every test page.
 *
 * A full serial run produced a failure that said only "input bar never took
 * focus", after `input.focus()` had resolved and focused the textarea. With no
 * record of the focus transitions, that symptom could not be read: it said focus
 * was somewhere else, not what took it or when. The log below is what turns that
 * symptom into a diagnosis, so it is installed by the page fixtures rather than
 * by whichever spec happens to care.
 *
 * The listeners are on the capture phase, so an element that receives focus and is
 * then removed from the DOM is still recorded. Each `out` entry says whether the
 * element it lost focus on is still in the document and where focus went: losing
 * focus on a node that is no longer connected is destruction, not a blur, and the
 * two look identical in `activeElement` alone — both leave the body focused.
 */
import type { Page } from '@playwright/test';

export interface FocusTransition {
    /** `in` when an element gained focus, `out` when one lost it. */
    kind: 'in' | 'out';
    /** Tag, id, test id and the first few classes. */
    element: string;
    /** `Date.now()` as the page saw it. */
    at: number;
    /** On an `out`: where focus went, or that the element was destroyed. */
    note?: string;
}

declare global {
    interface Window {
        __gbFocusLog?: FocusTransition[];
    }
}

/**
 * Start recording focus transitions on this page. Idempotent, because the page
 * fixtures and individual specs may both call it. The log is bounded so a long
 * run cannot grow it without limit; the tail is what a failure needs.
 */
export async function installFocusLog(page: Page): Promise<void> {
    await page.evaluate(() => {
        if (window.__gbFocusLog) return;
        const log: Window['__gbFocusLog'] = [];
        window.__gbFocusLog = log;
        const describe = (el: Element | null) => {
            if (!el) return '(none)';
            const testId = el.getAttribute('data-testid');
            const cls = (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean).slice(0, 3).join('.');
            return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${testId ? `[${testId}]` : ''}${cls ? `.${cls}` : ''}`;
        };
        const push = (kind: 'in' | 'out', el: Element | null, related?: Element | null) => {
            let note: string | undefined;
            if (kind === 'out' && el) {
                // A node that is gone took its focus with it. A node still in the
                // document was blurred, and `related` says who received it.
                note = el.isConnected ? (related ? `→ ${describe(related)}` : '→ body') : 'destroyed (removed from the document)';
            }
            log.push({ kind, element: describe(el), at: Date.now(), note });
            // Keep the tail: a failure is read backwards from the most recent
            // transition, and a whole session's worth of them is noise.
            if (log.length > 60) log.shift();
        };
        document.addEventListener('focusin', (e) => push('in', e.target as Element | null), true);
        document.addEventListener('focusout', (e) => push('out', e.target as Element | null, e.relatedTarget as Element | null), true);
    });
}

/** The last few focus transitions, newest last. */
export async function focusTransitions(page: Page, limit = 8): Promise<FocusTransition[]> {
    return page.evaluate((n: number) => (window.__gbFocusLog ?? []).slice(-n), limit);
}

/** What holds focus right now, described the way the log describes elements. */
export async function describeFocused(page: Page): Promise<string> {
    return page.evaluate(() => {
        const el = document.activeElement;
        if (!el) return '(none)';
        const testId = el.getAttribute('data-testid');
        const cls = (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean).slice(0, 3).join('.');
        return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${testId ? `[${testId}]` : ''}${cls ? `.${cls}` : ''}`;
    });
}

/**
 * The log rendered for a failure message: transitions relative to `started`, so
 * the first entry near 0 ms is the one that explains the failure.
 */
export function renderFocusLog(transitions: FocusTransition[], started: number): string {
    if (transitions.length === 0) return '  (no focus log installed on this page)';
    return transitions
        .map((ev) => `  ${ev.at - started}ms ${ev.kind} ${ev.element}${ev.note ? ` ${ev.note}` : ''}`)
        .join('\n');
}
