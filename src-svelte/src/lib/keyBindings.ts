/**
 * The global keyboard bindings, as one table.
 *
 * A letter shortcut is matched by the character the key produced, with the physical
 * key (`e.code`) as a fallback for the cases where no letter is produced at all.
 * Neither reading alone works:
 *
 *   - The character alone: on macOS the Option key is a compose key, so Option+L
 *     reports `¬`, and Alt+L would match nothing a user ever pressed.
 *   - The physical key alone: a code is a QWERTY position, so Alt+A would stop working
 *     on AZERTY, where that letter sits on the key QWERTY calls `Q` — and a QWERTY
 *     press of Alt+Q would turn into Alt+A.
 *
 * Matching the produced character also retires the case pairs: the old reading needed
 * `76 || 108` for L and `71 || 103` for G purely to cover upper and lower case.
 *
 * Digits stay physical. That is the existing, deliberate choice for Alt+0–9 quick keys
 * and Alt+J (see the jump handler's history), and it is the one place where position
 * rather than character is what the shortcut means.
 */

/** What a keypress asks the page to do. The page owns the doing; this owns the asking. */
export type GlobalCommand =
    | 'page-up'
    | 'page-down'
    | 'previous-buffer'
    | 'focus-composer'
    | 'toggle-nicklist'
    | 'urgent-buffer'
    | 'buffer-up'
    | 'buffer-down'
    | 'clear-unread'
    | 'buffer-search'
    | 'content-search';

type Matcher = (e: KeyboardEvent) => boolean;

const alt = (e: KeyboardEvent) => e.altKey && !e.ctrlKey && !e.shiftKey;
const altNoCtrl = (e: KeyboardEvent) => e.altKey && !e.ctrlKey;
const plain = (e: KeyboardEvent) => !e.ctrlKey && !e.altKey && !e.shiftKey;

/** The letter `ch`, by physical key or by the character that key produced. */
/**
 * The letter `ch`. The character the key produced decides, normally. The physical key
 * is a fallback only when that character is not a letter at all: macOS composes `¬` for
 * Option+L, and a dead key reports `Dead`. Falling back rather than OR-ing the two
 * readings is what keeps a layout's own letters out of each other's shortcuts — on
 * AZERTY the key QWERTY calls `A` produces `q`, and pressing it must not be Alt+A.
 */
const letter = (e: KeyboardEvent, ch: string) => {
    const produced = e.key.toLowerCase();
    if (/^[a-z]$/.test(produced)) return produced === ch;
    return e.code === `Key${ch.toUpperCase()}`;
};

/**
 * Matched in order, which is the order the page used before this table existed.
 * No two bindings can match the same keypress today; the order is kept so that a
 * future overlap is at least deterministic.
 */
const BINDINGS: ReadonlyArray<{ command: GlobalCommand; match: Matcher }> = [
    { command: 'page-up', match: (e) => plain(e) && e.code === 'PageUp' },
    { command: 'page-down', match: (e) => plain(e) && e.code === 'PageDown' },
    {
        command: 'previous-buffer',
        // The French `<` key has no Backquote or IntlBackslash code, and the old numeric
        // check matched it as the unshifted character `<`. Shift is refused rather than
        // ignored: on a US layout `<` is Shift plus comma, which was never this shortcut.
        match: (e) =>
            e.altKey &&
            (e.code === 'Backquote' || e.code === 'IntlBackslash' || (!e.shiftKey && e.key === '<')),
    },
    // Ctrl is not excluded here, unlike the other Alt shortcuts: Ctrl+Alt+L has never
    // been taken by anything else, and excluding it would retire a working chord.
    { command: 'focus-composer', match: (e) => e.altKey && letter(e, 'l') },
    { command: 'toggle-nicklist', match: (e) => altNoCtrl(e) && letter(e, 'n') },
    { command: 'urgent-buffer', match: (e) => altNoCtrl(e) && letter(e, 'a') },
    // Arrows report the same name as `code` and as `key` on every layout, so the
    // physical reading is enough here and says what the shortcut is.
    { command: 'buffer-up', match: (e) => altNoCtrl(e) && e.code === 'ArrowUp' },
    { command: 'buffer-down', match: (e) => altNoCtrl(e) && e.code === 'ArrowDown' },
    { command: 'clear-unread', match: (e) => altNoCtrl(e) && letter(e, 'h') },
    { command: 'buffer-search', match: (e) => (e.altKey || e.ctrlKey) && letter(e, 'g') },
    { command: 'content-search', match: (e) => e.ctrlKey && letter(e, 'f') },
];

/**
 * The command a keypress asks for, or `null` when it asks for nothing.
 * Escape is deliberately absent: its meaning depends on when the last Escape
 * arrived, which is a page-level fact rather than a binding.
 */
export function classifyGlobalCommand(e: KeyboardEvent): GlobalCommand | null {
    for (const binding of BINDINGS) {
        if (binding.match(e)) return binding.command;
    }
    return null;
}

/** The Alt+0–9 quick keys. Main-row digits only: Alt plus numpad is held too often by accident. */
export function quickKeyDigit(e: KeyboardEvent): number | null {
    if (!alt(e)) return null;
    const match = e.code.match(/^Digit(\d)$/);
    return match?.[1] ? Number(match[1]) : null;
}

/**
 * A digit for the two-step jump. Numpad digits count here because armed mode is
 * exclusive — anything that is not a digit aborts — and on AZERTY a main-row digit
 * is Shift plus a key.
 */
export function jumpDigit(e: KeyboardEvent): number | null {
    if (e.altKey || e.ctrlKey) return null;
    const match = e.code.match(/^(?:Digit|Numpad)(\d)$/);
    return match?.[1] ? Number(match[1]) : null;
}

/** Alt+J arms the two-step jump. */
export function isJumpArm(e: KeyboardEvent): boolean {
    return alt(e) && e.code === 'KeyJ';
}
