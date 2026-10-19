/**
 * Focus a dialog's input while its popover is opening.
 *
 * Chromium dispatches `toggle` a frame after the popover becomes visible, which
 * delays auto-focus enough to swallow a fast first keystroke. `beforetoggle`
 * fires synchronously inside showPopover(), so focus from there — deferred one
 * microtask, by which time the popover is shown and the input is focusable.
 *
 * Call this from a `beforetoggle` handler that has already decided the transition
 * is an opening one. The guard stays with the caller because a dialog may have
 * its own state to commit on the same event, and it must not commit that on a
 * closing transition either.
 */
export function focusWhenPopoverOpens(
    inputId: string,
    options: { select?: boolean } = {},
): void {
    queueMicrotask(() => {
        const input = document.getElementById(inputId) as HTMLInputElement | null;
        input?.focus();
        if (options.select) input?.select();
    });
}
