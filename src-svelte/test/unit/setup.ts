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
