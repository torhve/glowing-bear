/**
 * Vitest environment shims.
 *
 * jsdom does not implement every API the app relies on. These stubs exist so a
 * component test mounts the same code path the browser does — a production
 * `typeof X === 'undefined'` guard would instead silently skip the real branch
 * and a regression in it would never be seen.
 *
 * They are deliberately inert: jsdom performs no layout, so a fake that invented
 * size callbacks would fabricate geometry the test never asked for. Tests that
 * need layout behaviour drive the viewport controller directly with the explicit
 * adapter in test/unit/chat-viewport.test.ts.
 */

class InertResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
}

if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = InertResizeObserver as unknown as typeof ResizeObserver;
}

/**
 * The Popover API is not in jsdom. The app opens its dialogs programmatically
 * (`showPopover()`), so without a stub a component test would throw before it ever
 * reached the code under test. It stays inert: tests assert on what a dialog renders,
 * not on whether it popped.
 */
// Guarded on HTMLElement existing: `hash-params-ssr.test.ts` runs with
// `@vitest-environment node`, where there is no HTMLElement to patch at all.
if (typeof HTMLElement !== 'undefined' && !('showPopover' in HTMLElement.prototype)) {
    const inert = function (this: HTMLElement) {};
    HTMLElement.prototype.showPopover = inert as HTMLElement['showPopover'];
    HTMLElement.prototype.hidePopover = inert as HTMLElement['hidePopover'];
}

/**
 * jsdom has no `matchMedia` at all, so the OS light/dark follow from issue #13 would
 * only ever run its non-DOM guard and a regression in the live path would be invisible.
 *
 * Unlike the inert stubs above this one is *driven*: it keeps one fake query list per
 * query string, reports the scheme the test asked for, and dispatches `change` to every
 * registered listener when a test flips it with `__setPrefersColorSchemeDark()`. That is
 * the only way a unit test can prove the app reacts to an OS flip without an OS.
 */
class FakeMediaQueryList {
    media: string;
    matches: boolean;
    private listeners = new Set<(event: { matches: boolean }) => void>();

    constructor(media: string, matches: boolean) {
        this.media = media;
        this.matches = matches;
    }

    addEventListener(type: string, callback: (event: { matches: boolean }) => void): void {
        if (type === 'change') this.listeners.add(callback);
    }

    removeEventListener(type: string, callback: (event: { matches: boolean }) => void): void {
        if (type === 'change') this.listeners.delete(callback);
    }

    notify(): void {
        for (const callback of [...this.listeners]) callback({ matches: this.matches });
    }
}

if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
    const queries = new Map<string, FakeMediaQueryList>();
    let prefersDark = false;

    window.matchMedia = ((query: string) => {
        let queryList = queries.get(query);
        if (!queryList) {
            queryList = new FakeMediaQueryList(query, prefersDark);
            queries.set(query, queryList);
        }
        queryList.matches = prefersDark;
        return queryList as unknown as MediaQueryList;
    }) as typeof window.matchMedia;

    // Test-only handle: flip the scheme the way an OS would and let the app follow.
    (window as Window & { __setPrefersColorSchemeDark?: (dark: boolean) => void })
        .__setPrefersColorSchemeDark = (dark: boolean) => {
            prefersDark = dark;
            for (const queryList of queries.values()) {
                queryList.matches = dark;
                queryList.notify();
            }
        };
}
