/**
 * The global keyboard bindings, pinned as a table rather than as handler order.
 *
 * The bindings used to be read from `e.keyCode`, which reports the character a layout
 * produces. That made every letter shortcut need two numbers to cover case, and it left
 * macOS users unable to fire Alt+L at all, because the Option key composes `¬` where the
 * code would have said `KeyL`. The table matches a letter by the character it produced,
 * falling back to the physical key only when no letter is produced at all, which fixes
 * both without asking any layout to give up a shortcut or lending one layout's letter to
 * another — the tests below are written from three layouts, not one.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
    classifyGlobalCommand,
    isJumpArm,
    jumpDigit,
    quickKeyDigit,
    type GlobalCommand,
} from '#lib/keyBindings.ts';

function key(init: KeyboardEventInit): KeyboardEvent {
    return new KeyboardEvent('keydown', init);
}

/** Every command, from one keypress a real keyboard would produce. */
const REACHES: Array<[GlobalCommand, KeyboardEventInit]> = [
    ['page-up', { code: 'PageUp' }],
    ['page-down', { code: 'PageDown' }],
    ['previous-buffer', { altKey: true, code: 'Backquote', key: '`' }],
    ['focus-composer', { altKey: true, code: 'KeyL', key: 'l' }],
    ['toggle-nicklist', { altKey: true, code: 'KeyN', key: 'n' }],
    ['urgent-buffer', { altKey: true, code: 'KeyA', key: 'a' }],
    ['buffer-up', { altKey: true, code: 'ArrowUp', key: 'ArrowUp' }],
    ['buffer-down', { altKey: true, code: 'ArrowDown', key: 'ArrowDown' }],
    ['clear-unread', { altKey: true, code: 'KeyH', key: 'h' }],
    ['buffer-search', { altKey: true, code: 'KeyG', key: 'g' }],
    ['content-search', { ctrlKey: true, code: 'KeyF', key: 'f' }],
];

describe('the binding table', () => {
    it('reaches every command, and nothing else is a command', () => {
        for (const [command, init] of REACHES) {
            expect(classifyGlobalCommand(key(init)), `${init.code}`).toBe(command);
        }
        // A plain letter and a plain arrow belong to the page's own inputs, not here.
        expect(classifyGlobalCommand(key({ code: 'KeyL', key: 'l' }))).toBeNull();
        expect(classifyGlobalCommand(key({ code: 'ArrowDown', key: 'ArrowDown' }))).toBeNull();
        expect(classifyGlobalCommand(key({ code: 'Escape', key: 'Escape' }))).toBeNull();
    });

    it('does not care which case the layout produced', () => {
        // The old keyCode reading needed `76 || 108` for exactly this pair.
        expect(classifyGlobalCommand(key({ altKey: true, code: 'KeyL', key: 'L' }))).toBe('focus-composer');
        expect(classifyGlobalCommand(key({ altKey: true, code: 'KeyG', key: 'G' }))).toBe('buffer-search');
    });

    it('still matches Alt+L on macOS, where Option composes a different character', () => {
        // Option+L produces `¬`. A character reading of this keypress matches nothing.
        expect(classifyGlobalCommand(key({ altKey: true, code: 'KeyL', key: '¬' }))).toBe('focus-composer');
    });

    it('keeps the French `<` key as the previous-buffer shortcut', () => {
        // French keyboards put `<` on a key with no Backquote or IntlBackslash code,
        // and that character has always been accepted here.
        expect(classifyGlobalCommand(key({ altKey: true, code: 'KeyW', key: '<' }))).toBe('previous-buffer');
        expect(classifyGlobalCommand(key({ altKey: true, code: 'IntlBackslash', key: '\\' }))).toBe('previous-buffer');
        // Shift plus comma on a US layout produces `<` too, and that was never this
        // shortcut: the numeric check it replaced matched the unshifted character only.
        expect(classifyGlobalCommand(key({ altKey: true, shiftKey: true, code: 'Comma', key: '<' }))).toBeNull();
    });

    it('excludes Ctrl from the Alt shortcuts that say so, and from the one that does not', () => {
        for (const code of ['KeyN', 'KeyA', 'KeyH', 'ArrowUp', 'ArrowDown']) {
            expect(classifyGlobalCommand(key({ altKey: true, ctrlKey: true, code, key: code })), code).toBeNull();
        }
        // Ctrl+Alt+L has never been taken by anything else, so it still focuses the composer.
        expect(classifyGlobalCommand(key({ altKey: true, ctrlKey: true, code: 'KeyL', key: 'l' }))).toBe('focus-composer');
    });

    it('leaves paging to plain presses, so Alt+PageUp is the browser\'s', () => {
        expect(classifyGlobalCommand(key({ altKey: true, code: 'PageUp', key: 'PageUp' }))).toBeNull();
        expect(classifyGlobalCommand(key({ ctrlKey: true, code: 'PageDown', key: 'PageDown' }))).toBeNull();
        expect(classifyGlobalCommand(key({ shiftKey: true, code: 'PageDown', key: 'PageDown' }))).toBeNull();
    });

    it('accepts either Alt or Ctrl for buffer search and only Ctrl for content search', () => {
        expect(classifyGlobalCommand(key({ ctrlKey: true, code: 'KeyG', key: 'g' }))).toBe('buffer-search');
        expect(classifyGlobalCommand(key({ ctrlKey: true, altKey: true, code: 'KeyG', key: 'g' }))).toBe('buffer-search');
        expect(classifyGlobalCommand(key({ altKey: true, code: 'KeyF', key: 'f' }))).toBeNull();
    });
});

describe('the digits', () => {
    it('reads quick keys from main-row digits only', () => {
        expect(quickKeyDigit(key({ altKey: true, code: 'Digit1', key: '1' }))).toBe(1);
        expect(quickKeyDigit(key({ altKey: true, code: 'Digit0', key: '0' }))).toBe(0);
        expect(quickKeyDigit(key({ altKey: true, code: 'Digit9', key: '9' }))).toBe(9);
        // Alt plus a numpad digit is held too often by accident to mean buffer 5.
        expect(quickKeyDigit(key({ altKey: true, code: 'Numpad5', key: '5' }))).toBeNull();
        expect(quickKeyDigit(key({ code: 'Digit3', key: '3' }))).toBeNull();
        // Shift is excluded, which is the existing behaviour and worth saying out loud:
        // on AZERTY a main-row digit is Shift plus a key, so Alt+digit quick keys are
        // not available there either way.
        expect(quickKeyDigit(key({ altKey: true, shiftKey: true, code: 'Digit1', key: '&' }))).toBeNull();
    });

    it('reads jump digits from the numpad too, and with Shift', () => {
        expect(jumpDigit(key({ code: 'Digit4', key: '4' }))).toBe(4);
        expect(jumpDigit(key({ code: 'Numpad4', key: '4' }))).toBe(4);
        expect(jumpDigit(key({ shiftKey: true, code: 'Digit4', key: '$' }))).toBe(4);
        expect(jumpDigit(key({ altKey: true, code: 'Digit4', key: '4' }))).toBeNull();
        expect(jumpDigit(key({ ctrlKey: true, code: 'Digit4', key: '4' }))).toBeNull();
        expect(jumpDigit(key({ code: 'KeyJ', key: 'j' }))).toBeNull();
    });

    it('arms the jump from Alt+J only', () => {
        expect(isJumpArm(key({ altKey: true, code: 'KeyJ', key: 'j' }))).toBe(true);
        expect(isJumpArm(key({ altKey: true, shiftKey: true, code: 'KeyJ', key: 'J' }))).toBe(false);
        expect(isJumpArm(key({ code: 'KeyJ', key: 'j' }))).toBe(false);
    });
});

describe('three layouts, the same shortcuts', () => {
    // Alt+A and Ctrl+F sit on different physical keys depending on the layout, and
    // macOS Option composes a different character. Each row is what that layout's
    // browser reports when the user presses the key the docs name.
    const LAYOUTS: Array<{ name: string; altA: KeyboardEventInit; ctrlF: KeyboardEventInit; altL: KeyboardEventInit }> = [
        {
            name: 'QWERTY',
            altA: { altKey: true, code: 'KeyA', key: 'a' },
            ctrlF: { ctrlKey: true, code: 'KeyF', key: 'f' },
            altL: { altKey: true, code: 'KeyL', key: 'l' },
        },
        {
            // On AZERTY the letters A and F live on the keys QWERTY calls Q and U.
            name: 'AZERTY',
            altA: { altKey: true, code: 'KeyQ', key: 'a' },
            ctrlF: { ctrlKey: true, code: 'KeyU', key: 'f' },
            altL: { altKey: true, code: 'KeyL', key: 'l' },
        },
        {
            // The physical key is unchanged there; only the character differs.
            name: 'macOS Option',
            altA: { altKey: true, code: 'KeyA', key: '©' },
            ctrlF: { ctrlKey: true, code: 'KeyF', key: 'f' },
            altL: { altKey: true, code: 'KeyL', key: '¬' },
        },
    ];

    for (const layout of LAYOUTS) {
        it(`keeps Alt+A, Ctrl+F and Alt+L on ${layout.name}`, () => {
            expect(classifyGlobalCommand(key(layout.altA)), layout.name).toBe('urgent-buffer');
            expect(classifyGlobalCommand(key(layout.ctrlF)), layout.name).toBe('content-search');
            expect(classifyGlobalCommand(key(layout.altL)), layout.name).toBe('focus-composer');
        });
    }

    it('does not let one letter borrow another letter\'s shortcut', () => {
        // A QWERTY press of Alt+Q lands on the physical key AZERTY's A occupies, but it
        // produced 'q', so it is not Alt+A.
        expect(classifyGlobalCommand(key({ altKey: true, code: 'KeyQ', key: 'q' }))).toBeNull();
        // And the AZERTY key that sits where QWERTY's A does produces `q`, so pressing
        // it is not Alt+A either — a bare physical-OR-character match would say it was.
        expect(classifyGlobalCommand(key({ altKey: true, code: 'KeyA', key: 'q' }))).toBeNull();
        // Option+G composes ©, which is not the letter g: only the physical key makes
        // buffer search work there, and it does.
        expect(classifyGlobalCommand(key({ altKey: true, code: 'KeyG', key: '©' }))).toBe('buffer-search');
    });
});

describe('modifier permutations, per binding', () => {
    // The numeric checks had no Shift condition on any of these, so Shift has always
    // been tolerated; the old keyCode readings tolerated it unevenly (78 was uppercase
    // `N`, so Alt+N needed Shift while Alt+n did nothing). One letter rule covers both,
    // and these pin that the tolerance is still there rather than accidentally widened.
    const SHIFT_TOLERATED: Array<[GlobalCommand, string]> = [
        ['focus-composer', 'KeyL'],
        ['toggle-nicklist', 'KeyN'],
        ['urgent-buffer', 'KeyA'],
        ['clear-unread', 'KeyH'],
        ['buffer-search', 'KeyG'],
        ['buffer-up', 'ArrowUp'],
        ['buffer-down', 'ArrowDown'],
    ];

    for (const [command, code] of SHIFT_TOLERATED) {
        it(`keeps Shift in ${command}`, () => {
            expect(classifyGlobalCommand(key({ altKey: true, shiftKey: true, code, key: code })), code).toBe(command);
        });
    }

    it('reads a letter shortcut from either case, which the numeric pairs did not', () => {
        // keyCode reported one case per key press for some letters, so Alt+n and Alt+N
        // were not the same shortcut.
        expect(classifyGlobalCommand(key({ altKey: true, code: 'KeyN', key: 'n' }))).toBe('toggle-nicklist');
        expect(classifyGlobalCommand(key({ altKey: true, shiftKey: true, code: 'KeyN', key: 'N' }))).toBe('toggle-nicklist');
        expect(classifyGlobalCommand(key({ ctrlKey: true, code: 'KeyF', key: 'f' }))).toBe('content-search');
        expect(classifyGlobalCommand(key({ ctrlKey: true, shiftKey: true, code: 'KeyF', key: 'F' }))).toBe('content-search');
    });

    it('refuses Ctrl everywhere except the composer focus chord', () => {
        // KeyG is absent on purpose: buffer search accepts either Alt or Ctrl, so a
        // press holding both is still that shortcut, exactly as it was before.
        for (const code of ['KeyH', 'KeyN', 'KeyA', 'ArrowUp', 'ArrowDown']) {
            expect(classifyGlobalCommand(key({ altKey: true, ctrlKey: true, code, key: code.toLowerCase() })), code).toBeNull();
        }
        expect(classifyGlobalCommand(key({ altKey: true, ctrlKey: true, code: 'KeyL', key: 'l' }))).toBe('focus-composer');
    });

    it('needs Alt or Ctrl for the search shortcuts, and Ctrl alone for content search', () => {
        expect(classifyGlobalCommand(key({ code: 'KeyG', key: 'g' }))).toBeNull();
        expect(classifyGlobalCommand(key({ shiftKey: true, code: 'KeyG', key: 'G' }))).toBeNull();
        expect(classifyGlobalCommand(key({ ctrlKey: true, altKey: true, code: 'KeyF', key: 'f' }))).toBe('content-search');
        expect(classifyGlobalCommand(key({ altKey: true, code: 'KeyF', key: 'f' }))).toBeNull();
    });
});

describe('the page dispatches through the table', () => {
    // The idiom is banned rather than the field: reading keyCode is exactly what makes a
    // shortcut need two numbers, and a hand-written numeric check would pass every test
    // above while the page quietly disagreed with it.
    it('does not read a numeric key code anywhere', () => {
        const page = readFileSync('src-svelte/src/routes/+page.svelte', 'utf8');
        expect(page).not.toMatch(/keyCode\s*\|\|\s*e\.?which/);
        expect(page).not.toMatch(/code\s*===\s*\d+/);
    });

    it('asks the table what a keypress means', () => {
        const page = readFileSync('src-svelte/src/routes/+page.svelte', 'utf8');
        expect(page).toContain('classifyGlobalCommand(e)');
    });
});
