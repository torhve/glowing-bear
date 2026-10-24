import { createContext } from 'svelte';

/** The composer's textarea, reachable by whoever expresses composer intent. */
export interface ComposerHolder {
    current: HTMLTextAreaElement | null;
}

/**
 * Scoped bridge between the message composer and the siblings that write into it: the
 * global key handler (focus and blur), the chat view (a clicked mention) and the
 * nicklist (a clicked nick).
 *
 * Six call sites used to find the composer with
 * `document.querySelector('[data-testid="message-input"]')`. A test hook is not an
 * address: it resolves only while exactly one composer happens to be in the document,
 * and it says nothing about which page instance owns it. The chat viewport already
 * settled this — `chatScrollContext.ts` — and said reaching the viewport by query was
 * wrong; the composer was the last thing reached that way.
 *
 * The value is one holder per page instance, never a module-global singleton: a sibling
 * can only write to the composer of the page it is rendered in, and a composer that is
 * not mounted simply leaves `current` null, which is what the queries returned then.
 */
const [getComposerInput, setComposerInput, hasComposerInput] = createContext<ComposerHolder>();

/**
 * Publishes the page's holder. Nothing outside this module reads the context accessors:
 * `readComposerInput` is the only way in, which is what keeps "there is no composer here" a
 * value a caller can handle instead of a context the caller has to know about.
 */
export { setComposerInput };

/**
 * The holder for the current page, or an inert one when this component is rendered
 * outside a composer page: there is nothing to write to, which is the same state as a
 * composer that has not mounted. Must be called during component initialisation.
 */
export function readComposerInput(): ComposerHolder {
    return hasComposerInput() ? getComposerInput() : { current: null };
}

/**
 * Rewrite the composer's value and put the caret where the caller says, then announce
 * the change the way a real edit does. The `input` event is what keeps Svelte's own
 * value state, and everything downstream of it, in step with the textarea.
 */
export function applyComposerEdit(
    input: HTMLTextAreaElement,
    transform: (value: string, start: number, end: number) => { value: string; cursor: number },
): void {
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    const result = transform(input.value, start, end);
    input.value = result.value;
    input.focus();
    input.setSelectionRange(result.cursor, result.cursor);
    input.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * Insert a nick at the caret, spaced from whatever the reader had already typed. The
 * trailing space is where the reader wants to keep typing; the caret goes after the
 * nick rather than at the end of the composer, because the text behind the caret is
 * theirs.
 */
export function insertNickAtCursor(input: HTMLTextAreaElement, nickName: string): void {
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    const before = input.value.substring(0, start);
    const after = input.value.substring(end);
    const needsSpace = before.length > 0 && !/\s$/.test(before);
    input.value = before + (needsSpace ? ' ' : '') + nickName + ' ' + after;
    const newPos = start + (needsSpace ? 1 : 0) + nickName.length + 1;
    input.focus();
    input.setSelectionRange(newPos, newPos);
    input.dispatchEvent(new Event('input', { bubbles: true }));
}
