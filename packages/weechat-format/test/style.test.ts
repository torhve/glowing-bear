/**
 * Style interpreter tests: how decoded instructions change a style.
 *
 * Grounded in src/gui/curses/gui-curses-window.c:395-574 and
 * src/gui/curses/gui-curses-chat.c:315-365 (WeeChat 4.10.1).
 */

import { describe, expect, it } from 'vitest';
import { parseWeeChatText } from '../src/parse.js';
import { INITIAL_STYLE } from '../src/style.js';
import { CTL, summarize } from './helpers/ctl.js';

/** Style of the single run produced by formatting-only-then-text input. */
function styleOf(input: string): string {
    const runs = parseWeeChatText(`${input}x`);
    const run = runs[0];
    if (run === undefined || runs.length !== 1) {
        throw new Error(`expected one run for ${JSON.stringify(input)}, got ${runs.length}`);
    }
    return summarize(run.style);
}

const DEFAULTS = 'fg=default bg=default attrs=- theme=- emphasis=-';

describe('initial style', () => {
    it('starts from base colors with no attribute decision', () => {
        expect(summarize(INITIAL_STYLE)).toBe(DEFAULTS);
    });

    it('leaves unformatted text in the initial style', () => {
        expect(styleOf('')).toBe(DEFAULTS);
    });
});

describe('foreground colors', () => {
    it('applies a two-digit palette index', () => {
        expect(styleOf(`${CTL.color}F03`)).toBe('fg=red bg=default attrs=blink-,bold-,dim-,italic-,reverse-,underline- theme=- emphasis=-');
    });

    it('maps index 0 to the terminal default', () => {
        expect(styleOf(`${CTL.color}F00`)).toBe('fg=default bg=default attrs=blink-,bold-,dim-,italic-,reverse-,underline- theme=- emphasis=-');
    });

    it('maps the full 17-entry palette', () => {
        const names = [
            'default', 'black', 'darkgray', 'red', 'lightred', 'green', 'lightgreen',
            'brown', 'yellow', 'blue', 'lightblue', 'magenta', 'lightmagenta',
            'cyan', 'lightcyan', 'gray', 'white',
        ];
        names.forEach((name, index) => {
            const code = String(index).padStart(2, '0');
            expect(styleOf(`${CTL.color}F${code}`)).toContain(`fg=${name}`);
        });
    });

    it('does not derive attributes from the palette (no-bold palette)', () => {
        // Light palette colors carry A_BOLD only in WeeChat's bold palette
        // table, which is used when the terminal has fewer than 16 colors.
        expect(styleOf(`${CTL.color}F16`)).toBe('fg=white bg=default attrs=blink-,bold-,dim-,italic-,reverse-,underline- theme=- emphasis=-');
    });

    it('ignores a two-digit index outside the palette', () => {
        expect(styleOf(`${CTL.color}F17`)).toBe(DEFAULTS);
        expect(styleOf(`${CTL.color}F99`)).toBe(DEFAULTS);
    });

    it('applies an extended color index', () => {
        expect(styleOf(`${CTL.color}F@00012`)).toContain('fg=ext:12');
        expect(styleOf(`${CTL.color}F@99999`)).toContain('fg=ext:99999');
    });

    it('treats an extended zero as the default color', () => {
        // Upstream guards the extended branch with `fg > 0`.
        expect(styleOf(`${CTL.color}F@00000`)).toContain('fg=default');
    });

    it('applies payload attribute flags', () => {
        expect(styleOf(`${CTL.color}F*03`)).toContain('bold+');
        expect(styleOf(`${CTL.color}F%03`)).toContain('blink+');
        expect(styleOf(`${CTL.color}F.03`)).toContain('dim+');
        expect(styleOf(`${CTL.color}F!03`)).toContain('reverse+');
        expect(styleOf(`${CTL.color}F/03`)).toContain('italic+');
        expect(styleOf(`${CTL.color}F_03`)).toContain('underline+');
    });

    it('clears other attributes when a payload sets one', () => {
        const style = styleOf(`${CTL.color}F*03`);
        expect(style).toContain('bold+');
        expect(style).toContain('italic-');
    });
});

describe('keep-attributes behavior', () => {
    it('keeps the current attributes when the payload carries |', () => {
        expect(styleOf(`${CTL.color}F*03${CTL.color}F|04`)).toContain('bold+');
    });

    it('keeps an attribute set by a set-attribute control', () => {
        expect(styleOf(`${CTL.setAttr}${CTL.attrItalic}${CTL.color}F|04`)).toContain('italic+');
    });

    it('clears attributes without |', () => {
        const style = styleOf(`${CTL.setAttr}${CTL.attrItalic}${CTL.color}F04`);
        expect(style).toContain('italic-');
    });

    it('does not treat keep-attributes as an attribute reset', () => {
        // `|` preserves every current state, including explicit removals.
        expect(styleOf(`${CTL.setAttr}${CTL.attrBold}${CTL.removeAttr}${CTL.attrBold}${CTL.color}F|04`)).not.toContain('bold+');
    });

    it('has no special meaning for a background payload', () => {
        // Background controls never touch attributes.
        expect(styleOf(`${CTL.color}F*03${CTL.color}B04`)).toContain('bold+');
        expect(styleOf(`${CTL.color}B04`)).toBe('fg=default bg=lightred attrs=- theme=- emphasis=-');
    });
});

describe('background colors', () => {
    it('applies a two-digit palette index without touching attributes', () => {
        expect(styleOf(`${CTL.setAttr}${CTL.attrBold}${CTL.color}B04`)).toBe('fg=default bg=lightred attrs=bold+ theme=- emphasis=-');
    });

    it('applies an extended background index', () => {
        expect(styleOf(`${CTL.color}B@00012`)).toContain('bg=ext:12');
    });

    it('ignores an out-of-palette two-digit index', () => {
        expect(styleOf(`${CTL.color}B17`)).toBe(DEFAULTS);
    });
});

describe('combined foreground/background colors', () => {
    it('applies both colors with the legacy comma separator', () => {
        expect(styleOf(`${CTL.color}*03,04`)).toBe('fg=red bg=lightred attrs=blink-,bold-,dim-,italic-,reverse-,underline- theme=- emphasis=-');
    });

    it('applies both colors with the current tilde separator', () => {
        expect(styleOf(`${CTL.color}*03~04`)).toBe('fg=red bg=lightred attrs=blink-,bold-,dim-,italic-,reverse-,underline- theme=- emphasis=-');
    });

    it('applies extended payloads', () => {
        const style = styleOf(`${CTL.color}*@00012~@00034`);
        expect(style).toContain('fg=ext:12');
        expect(style).toContain('bg=ext:34');
    });

    it('applies nothing when only the foreground parses', () => {
        expect(styleOf(`${CTL.color}*03`)).toBe(DEFAULTS);
        expect(styleOf(`${CTL.color}*03,`)).toBe(DEFAULTS);
    });

    it('uses raw terminal indices for out-of-palette values in a combined payload', () => {
        // Upstream passes these straight to the terminal color pair; a browser
        // has no palette-index meaning for them (see docs/format.md).
        const style = styleOf(`${CTL.color}*99,99`);
        expect(style).toContain('fg=ext:99');
        expect(style).toContain('bg=ext:99');
    });

    it('honors | in a combined payload', () => {
        expect(styleOf(`${CTL.color}F*03${CTL.color}*|04~05`)).toContain('bold+');
    });
});

describe('theme option colors', () => {
    it('applies a bare two-digit theme index symbolically', () => {
        expect(styleOf(`${CTL.color}01`)).toBe('fg=theme:chat bg=theme:chat attrs=- theme=chat emphasis=-');
    });

    it('keeps the theme reference instead of resolving attributes', () => {
        const style = styleOf(`${CTL.color}46`);
        expect(style).toContain('theme=chat_status_enabled');
        expect(style).not.toContain('bold+');
    });

    it('replaces attributes with the theme color own attributes', () => {
        // An explicit removal before a theme code does not survive it.
        expect(styleOf(`${CTL.setAttr}${CTL.attrBold}${CTL.color}01`)).toBe('fg=theme:chat bg=theme:chat attrs=- theme=chat emphasis=-');
    });

    it('ignores an index outside the theme enum', () => {
        expect(styleOf(`${CTL.color}47`)).toBe(DEFAULTS);
        expect(styleOf(`${CTL.color}99`)).toBe(DEFAULTS);
    });
});

describe('ncurses pair controls', () => {
    it('clears attributes and leaves colors unresolved', () => {
        expect(styleOf(`${CTL.setAttr}${CTL.attrBold}${CTL.color}@01234`)).toBe(
            'fg=default bg=default attrs=blink-,bold-,dim-,italic-,reverse-,underline- theme=- emphasis=-',
        );
    });
});

describe('emphasis', () => {
    it('toggles emphasis', () => {
        expect(styleOf(`${CTL.color}E`)).toContain('emphasis');
        expect(styleOf(`${CTL.color}E${CTL.color}E`)).toContain('emphasis=-');
    });

    it('survives color changes', () => {
        expect(styleOf(`${CTL.color}E${CTL.color}F03`)).toContain('emphasis');
    });

    it('is not changed by either reset form', () => {
        expect(styleOf(`${CTL.color}E${CTL.color}${CTL.reset}`)).toContain('emphasis');
        expect(styleOf(`${CTL.color}E${CTL.reset}`)).toContain('emphasis');
    });
});

describe('recognized-but-nonrendering controls', () => {
    it('consumes bar references without changing the style', () => {
        expect(styleOf(`${CTL.color}bF`)).toBe(DEFAULTS);
        expect(styleOf(`${CTL.color}b_`)).toBe(DEFAULTS);
        expect(styleOf(`${CTL.color}b#`)).toBe(DEFAULTS);
    });

    it('does not disturb a surrounding style', () => {
        expect(styleOf(`${CTL.color}F03${CTL.color}bD${CTL.color}F04`)).toContain('fg=lightred');
    });
});

describe('set and remove attribute controls', () => {
    it('enables and disables individual attributes', () => {
        expect(styleOf(`${CTL.setAttr}${CTL.attrBold}`)).toContain('bold+');
        expect(styleOf(`${CTL.setAttr}${CTL.attrBold}${CTL.removeAttr}${CTL.attrBold}`)).not.toContain('bold+');
    });

    it('leaves colors untouched', () => {
        expect(styleOf(`${CTL.color}F03${CTL.setAttr}${CTL.attrBold}`)).toContain('fg=red');
    });

    it('ignores unsupported payload characters', () => {
        expect(styleOf(`${CTL.setAttr}*`)).toBe(DEFAULTS);
    });
});

describe('sequences', () => {
    it('applies theme, attribute removal, foreground, keep and reset in order', () => {
        const input = [
            `${CTL.color}01`, // theme color
            `${CTL.removeAttr}${CTL.attrBold}`, // explicit removal
            `${CTL.color}F04`, // foreground replaces attributes
            `${CTL.color}F|05`, // keep them
            `${CTL.color}${CTL.reset}`, // color-only reset
        ].join('');
        expect(styleOf(input)).toBe('fg=default bg=default attrs=blink-,bold-,dim-,italic-,reverse-,underline- theme=- emphasis=-');
    });

    it('applies foreground, set-attribute, keep and full reset in order', () => {
        const input = [
            `${CTL.color}F04`,
            `${CTL.setAttr}${CTL.attrUnderline}`,
            `${CTL.color}F|05`,
            CTL.reset,
        ].join('');
        expect(styleOf(input)).toBe(DEFAULTS);
    });

    it('keeps foreground-only and background-only effects distinct', () => {
        const fg = styleOf(`${CTL.color}F03`);
        const bg = styleOf(`${CTL.color}B03`);
        expect(fg).toContain('fg=red');
        expect(fg).not.toContain('bg=red');
        expect(bg).toContain('bg=red');
        expect(bg).not.toContain('fg=red');
    });
});
