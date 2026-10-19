/**
 * Is focus currently held by something the user is typing into?
 *
 * The global keyboard shortcuts must not fire while the composer, a settings
 * field or any other editable element has focus. Alt+1..9 and Alt+J are fine
 * there, but Alt+7 is how a Norwegian layout types a pipe: a shortcut that
 * steals it makes the channel untypeable, which is worse than a shortcut that
 * occasionally does not fire.
 *
 * Contenteditable is part of the rule alongside the three editable tags. The
 * composer is a textarea today, so that half looks redundant, but an editable
 * element inside a dialog would not be, and the four call sites all checked it.
 */
export function isTypingTarget(el: Element | null = document.activeElement): boolean {
    const tag = el?.tagName || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    return (el as HTMLElement | null)?.isContentEditable === true;
}
