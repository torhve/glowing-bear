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
