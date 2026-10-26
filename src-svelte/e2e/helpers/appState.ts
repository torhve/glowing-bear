import type { Page } from '@playwright/test';

/**
 * What the app itself is showing, read at the moment a helper gives up.
 *
 * The reason this exists: a Playwright click timeout says the locator did not get a click
 * landed. It does not say the app had already lost its relay session and was sitting on the
 * connect form — which is what one such timeout in `BufferList-pm.test.ts` actually meant
 * (screenshot: host/port/password form, empty sidebar). The app can get there through
 * `api-orchestrator.stop()`, whose `'disconnected'` status writes no console error and makes
 * WeeChat log nothing either, so nothing in a run log names it.
 *
 * This reads the two screens apart, counts the sidebar rows the app is rendering, and quotes
 * whatever the page recorded about itself (see `pageActivityInitScript`). It changes no
 * behaviour and hides nothing: a failure that used to read "click timed out" now reads why.
 */
/**
 * Main-frame navigations seen from the harness side.
 *
 * The page-side recorder cannot report its own page's death: a reload takes the recorder away with
 * it, and the fresh instance then reports "no page activity recorded" — which is exactly how a
 * dev-server reload landing under a running test used to read as an app that dropped its own
 * session. These entries live on the Playwright Page object, so they outlive the reload.
 */
const harnessNavigations = new WeakMap<Page, Array<{ at: number; url: string }>>();

/** Watch the frame from the harness side. Call before the page's first navigation. */
export function attachNavigationWitness(page: Page): void {
    const entries: Array<{ at: number; url: string }> = [];
    harnessNavigations.set(page, entries);
    page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame()) entries.push({ at: Date.now(), url: frame.url() });
    });
}

export async function readAppState(page: Page): Promise<string> {
    const state = await page.evaluate(() => {
        const chat = document.querySelector('[data-testid="chat-view"]');
        const connectForm = document.querySelector('[data-testid="host-input"]');
        const rows = [...document.querySelectorAll('[data-testid="buffer-item"] .buffer-name')]
            .map((el) => (el.textContent ?? '').trim());
        const trace = (window as Window & { __e2eActivity?: Array<{ t: number; kind: string; detail: string }> })
            .__e2eActivity ?? [];
        const lifecycle = (
            window as Window & {
                __gbE2eDebugEntries?: () => Array<{ t: number; event: string; detail?: string }>;
            }
        ).__gbE2eDebugEntries?.() ?? [];
        return {
            screen: connectForm ? 'connect form' : chat ? 'chat' : 'neither chat nor connect form',
            bufferRows: rows.length,
            rowNames: rows.slice(0, 8),
            title: document.title,
            // Newest last, and only the tail: this text is meant to be read inside a failure.
            activity: trace.slice(-12),
            lifecycle: lifecycle.slice(-14).map((e) => ({
                event: e.event,
                detail: e.detail,
                // Age is measured against the moment this is read, not against the newest entry:
                // the question a failure asks is "how long before the action that failed did the
                // session go away".
                ageSeconds: Math.round((e.t - Date.now()) / 100) / 10,
            })),
        };
    });

    const rows = state.rowNames.length
        ? `${state.bufferRows} rows (${state.rowNames.join(', ')})`
        : '0 rows';
    const activity = state.activity.length
        ? state.activity.map((a) => `${a.kind}${a.detail ? ` ${a.detail}` : ''}`).join('; ')
        : 'no page activity recorded';
    // Oldest first, each entry timed against the moment the state was read: the point of this line
    // is how long before the action that failed the session went away, and through which app event.
    const lifecycle = state.lifecycle.length
        ? state.lifecycle
            .map((e) => `${e.event}${e.detail ? ` (${e.detail})` : ''} @${e.ageSeconds >= 0 ? '+' : ''}${e.ageSeconds}s`)
            .join(' -> ')
        : 'no connection lifecycle recorded';

    // Ages are measured against the moment of reading: a test that failed three seconds after the
    // page navigated to the URL it was already on had a reload land under it, whatever the page
    // itself managed to record about it.
    const seen = harnessNavigations.get(page) ?? [];
    const readAt = Date.now();
    const seenText = seen
        .map((n) => `${n.url} @${Math.round((n.at - readAt) / 100) / 10}s`)
        .join(', ');
    const navigated = seen.length ? `; harness saw ${seen.length} main-frame navigation(s): ${seenText}` : '';

    return `app was on the ${state.screen} with ${rows}; connection: ${lifecycle}; page recorded: ${activity}${navigated}; title ${JSON.stringify(state.title)}`;
}

/** readAppState, never the cause of a failure: a page that is closing reads as unreadable state. */
export async function describeAppState(page: Page): Promise<string> {
    try {
        return await readAppState(page);
    } catch {
        return 'app state unreadable (page navigating or closed)';
    }
}

/**
 * Page-side recorder installed before the app loads.
 *
 * It records the page-level events that a helper cannot see from Playwright: a reload or
 * unload (`pagehide` / `beforeunload`), an SPA history write (`pushState` / `replaceState`),
 * a `popstate`, and an uncaught window error. Those are the fingerprints of the silent path
 * to the connect form — a component destroy that disposes the connection looks like a
 * `pushState`, and a real reload looks like a `pagehide`.
 *
 * Only the tail is kept (60 entries) and nothing is thrown: this is a witness, not a test.
 */
export function pageActivityInitScript(): void {
    type Entry = { t: number; kind: string; detail: string };
    const trace: Entry[] = [];
    const w = window as Window & { __e2eActivity?: Entry[] };
    w.__e2eActivity = trace;

    const push = (kind: string, detail: string) => {
        trace.push({ t: Date.now(), kind, detail });
        if (trace.length > 60) trace.shift();
    };

    window.addEventListener('pagehide', (event) => {
        push('pagehide', `persisted=${(event as PageTransitionEvent).persisted}`);
    });
    window.addEventListener('beforeunload', () => push('beforeunload', ''));
    window.addEventListener('popstate', () => push('popstate', `${location.pathname}${location.search}`));
    window.addEventListener('error', (event) => push('window-error', event.message));

    // Wrapped, never replaced: SvelteKit installs its own history handling on top of this, and
    // the app must keep working exactly as it does without the recorder.
    const originalPush = history.pushState.bind(history);
    const originalReplace = history.replaceState.bind(history);
    history.pushState = function (this: History, ...args: Parameters<History['pushState']>) {
        push('pushState', String(args[2] ?? ''));
        return originalPush(...args);
    };
    history.replaceState = function (this: History, ...args: Parameters<History['replaceState']>) {
        push('replaceState', String(args[2] ?? ''));
        return originalReplace(...args);
    };
}

/** Attach the recorder to a page that has not navigated yet. */
export async function installPageActivityRecorder(page: Page): Promise<void> {
    await page.addInitScript(pageActivityInitScript);
}
