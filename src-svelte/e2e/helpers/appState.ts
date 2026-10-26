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

/** Harness-side page events: the page-side recorder cannot report its own document's death. */
const harnessPageEvents = new WeakMap<Page, Array<{ at: number; kind: string; detail: string }>>();

/** The token of the document the harness built its session in, per page. */
const harnessDocTokens = new WeakMap<Page, string>();

/** Watch the frame from the harness side. Call before the page's first navigation. */
export function attachNavigationWitness(page: Page): void {
    const entries: Array<{ at: number; url: string }> = [];
    const events: Array<{ at: number; kind: string; detail: string }> = [];
    harnessNavigations.set(page, entries);
    harnessPageEvents.set(page, events);
    const push = (kind: string, detail: string) => {
        events.push({ at: Date.now(), kind, detail });
        if (events.length > 40) events.shift();
    };
    page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame()) entries.push({ at: Date.now(), url: frame.url() });
    });
    page.on('crash', () => push('page-crash', page.url()));
    page.on('close', () => push('page-close', page.url()));
    page.on('pageerror', (error) => push('pageerror', error.message.slice(0, 140)));
    // A page the test never asked for is a fixture leak, and a leaked page is one explanation for a
    // helper acting on a document that never connected.
    page.context().on('page', (opened) => push('context-page', opened.url() || '(new page)'));
}

/**
 * Remember the token of the document the session was built in. Call after the first navigation.
 *
 * Every fresh document mints a new token, so a failure can separate two things that look identical
 * from the outside: the app losing its session inside the document it was connected in, and that
 * document being replaced underneath the test. An unchanged token with an empty lifecycle ring means
 * the instrumentation or the page object is the suspect, not the app.
 */
export async function rememberDocumentToken(page: Page): Promise<void> {
    try {
        const token = await page.evaluate(
            () => (window as Window & { __e2eDocToken?: string }).__e2eDocToken,
        );
        if (token) harnessDocTokens.set(page, token);
    } catch {
        // A page that cannot answer yet has no token to remember; the failure text says it is unrecorded.
    }
}

/**
 * Whether the dev server is still serving, read from the harness.
 *
 * Playwright owns the `webServer` process, so a failure cannot otherwise say whether the server died
 * or restarted underneath the run — and a dev server that goes away reloads every open page, which is
 * the same fresh-document shape as the app losing its own session.
 */
async function probeDevServer(): Promise<string> {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    try {
        const response = await fetch('http://localhost:8001/', { signal: controller.signal });
        return `dev server ${response.status} in ${Date.now() - startedAt}ms`;
    } catch (error) {
        const reason = (error as Error).name === 'AbortError' ? 'no answer within 1500ms' : (error as Error).message;
        return `dev server unreachable (${reason})`;
    } finally {
        clearTimeout(timer);
    }
}
export async function readAppState(page: Page): Promise<string> {
    const state = await page.evaluate(async () => {
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
        // The app ships a service worker, and a worker claiming or reloading a client produces the
        // same fresh-document shape as a dev-server reload. Say which it is instead of guessing.
        let swState: string;
        try {
            const registration = await navigator.serviceWorker?.getRegistration?.();
            swState = registration
                ? `${navigator.serviceWorker?.controller ? 'controlling this client' : 'registered, not controlling'} at ${registration.scope}`
                : 'no registration';
        } catch {
            swState = 'unreadable';
        }
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
            docToken: (window as Window & { __e2eDocToken?: string }).__e2eDocToken ?? '(unstamped)',
            sw: swState,
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

    // The token is the discriminator. Same token and an empty lifecycle ring points at the harness or
    // the recorder; a different token points at whatever replaced the document; a page the test never
    // opened points at a fixture leak. Each of those reads differently here on purpose.
    const expectedToken = harnessDocTokens.get(page);
    const documentText = !expectedToken
        ? `document token ${state.docToken} was never recorded by the harness`
        : state.docToken === expectedToken
            ? `document ${state.docToken}, the same one the session was built in`
            : `DOCUMENT REPLACED: the session was built in ${expectedToken}, this document is ${state.docToken}`;

    const pageEvents = harnessPageEvents.get(page) ?? [];
    const eventText = pageEvents.length
        ? `; harness page events: ${pageEvents
            .map((e) => `${e.kind} @${Math.round((e.at - readAt) / 100) / 10}s${e.detail ? ` (${e.detail})` : ''}`)
            .join(', ')}`
        : '';

    const devServer = await probeDevServer();

    return `app was on the ${state.screen} with ${rows}; ${documentText}; connection: ${lifecycle}; page recorded: ${activity}${navigated}${eventText}; ${devServer}; service worker: ${state.sw}; title ${JSON.stringify(state.title)}`;
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
    const w = window as Window & { __e2eActivity?: Entry[]; __e2eDocToken?: string };
    w.__e2eActivity = trace;
    // One token per document, stamped where the recorder is stamped. A reload or a navigation runs
    // this again and mints a new one, so the harness can tell a replaced document from a document
    // that merely lost its session — the two things that look identical from a locator timeout.
    w.__e2eDocToken = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

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
