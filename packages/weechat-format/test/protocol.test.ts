/**
 * Protocol tests: which control sequences are recognized and exactly how many
 * UTF-16 units each one consumes.
 *
 * Consumption follows the WeeChat 4.10.1 renderer
 * (src/gui/curses/gui-curses-chat.c:241-374, src/gui/curses/gui-curses-window.c:641-1038).
 */

import { describe, expect, it } from 'vitest';
import { decodeAt } from '../src/decode.js';
import { CTL } from './helpers/ctl.js';

function decode(input: string): { kind: string; consumed: number; reason?: string } {
    const result = decodeAt(input, 0);
    if (result === null) {
        return { kind: 'none', consumed: 0 };
    }
    return {
        kind: result.instruction.kind,
        consumed: result.consumed,
        ...('reason' in result.instruction ? { reason: result.instruction.reason } : {}),
    };
}

describe('foreground controls (F)', () => {
    it('consumes a two-digit palette payload', () => {
        expect(decode(`${CTL.color}F03`)).toEqual({ kind: 'fg', consumed: 4 });
    });

    it('consumes an extended five-digit payload', () => {
        expect(decode(`${CTL.color}F@00012`)).toEqual({ kind: 'fg', consumed: 8 });
    });

    it('consumes extended attribute flags after the extended marker', () => {
        // The extended form requires `@` first; attribute flags follow it.
        const result = decodeAt(`${CTL.color}F@%.*!/_00012`, 0);
        expect(result?.consumed).toBe(14);
        expect(result?.instruction.kind).toBe('fg');
    });

    it('treats flags without a leading @ as a two-digit payload', () => {
        // Upstream checks `@` before the attribute run, so `F%…00012` reads a
        // two-digit payload ("00") and leaves the remaining digits as text.
        const result = decodeAt(`${CTL.color}F%.*!/_|00012`, 0);
        expect(result?.consumed).toBe(11);
        expect(result?.instruction.kind).toBe('fg');
    });

    it('consumes attribute flags before a two-digit payload', () => {
        expect(decode(`${CTL.color}F*03`)).toEqual({ kind: 'fg', consumed: 5 });
    });

    it('stops the attribute run at an unrecognized character', () => {
        // `A` is not an attribute flag, so it becomes part of the two-character
        // numeric window; that window is consumed even though it fails to parse.
        expect(decode(`${CTL.color}F*A03`)).toEqual({ kind: 'noop', consumed: 5, reason: 'invalid-numeric' });
    });

    it('consumes a non-numeric two-digit payload without producing a color', () => {
        expect(decode(`${CTL.color}F0x`)).toEqual({ kind: 'noop', consumed: 4, reason: 'invalid-numeric' });
    });

    it('consumes a non-numeric extended payload without producing a color', () => {
        expect(decode(`${CTL.color}F@abcde`)).toEqual({ kind: 'noop', consumed: 8, reason: 'invalid-numeric' });
    });

    it('consumes only what is available when the payload is truncated', () => {
        expect(decode(`${CTL.color}F`)).toEqual({ kind: 'noop', consumed: 2, reason: 'truncated-payload' });
        // A partial two-digit window is not consumed: only the marker is.
        expect(decode(`${CTL.color}F0`)).toEqual({ kind: 'noop', consumed: 2, reason: 'truncated-payload' });
        expect(decode(`${CTL.color}F@12`)).toEqual({ kind: 'noop', consumed: 3, reason: 'truncated-payload' });
    });

    it('accepts a signed payload window', () => {
        expect(decode(`${CTL.color}F-1`)).toEqual({ kind: 'fg', consumed: 4 });
    });
});

describe('background controls (B)', () => {
    it('consumes a two-digit palette payload', () => {
        expect(decode(`${CTL.color}B04`)).toEqual({ kind: 'bg', consumed: 4 });
    });

    it('consumes an extended five-digit payload', () => {
        expect(decode(`${CTL.color}B@00012`)).toEqual({ kind: 'bg', consumed: 8 });
    });

    it('does not accept attribute flags', () => {
        expect(decode(`${CTL.color}B*03`)).toEqual({ kind: 'noop', consumed: 4, reason: 'invalid-numeric' });
    });

    it('consumes the marker but not a truncated extended payload', () => {
        expect(decode(`${CTL.color}B@12`)).toEqual({ kind: 'noop', consumed: 2, reason: 'truncated-payload' });
        expect(decode(`${CTL.color}B`)).toEqual({ kind: 'noop', consumed: 2, reason: 'truncated-payload' });
    });
});

describe('combined foreground/background controls (*)', () => {
    it('consumes the legacy comma separator', () => {
        expect(decode(`${CTL.color}*01,02`)).toEqual({ kind: 'fgbg', consumed: 7 });
    });

    it('consumes the current tilde separator', () => {
        expect(decode(`${CTL.color}*01~02`)).toEqual({ kind: 'fgbg', consumed: 7 });
    });

    it('consumes extended foreground and background payloads', () => {
        expect(decode(`${CTL.color}*@00012~@00034`)).toEqual({ kind: 'fgbg', consumed: 15 });
    });

    it('consumes an incomplete form and produces nothing', () => {
        expect(decode(`${CTL.color}*03`)).toEqual({ kind: 'noop', consumed: 4, reason: 'truncated-payload' });
        expect(decode(`${CTL.color}*03,`)).toEqual({ kind: 'noop', consumed: 5, reason: 'truncated-payload' });
        // The renderer leaves a truncated extended background payload literal.
        expect(decode(`${CTL.color}*03,@12`)).toEqual({ kind: 'noop', consumed: 5, reason: 'truncated-payload' });
        expect(decode(`${CTL.color}*0x,02`)).toEqual({ kind: 'noop', consumed: 7, reason: 'invalid-numeric' });
    });
});

describe('theme option colors (bare two digits)', () => {
    it('consumes two digits as a theme index', () => {
        const result = decodeAt(`${CTL.color}03`, 0);
        expect(result?.consumed).toBe(3);
        expect(result?.instruction).toEqual({ kind: 'theme', index: 3 });
    });

    it('consumes only the color character when the payload is not numeric', () => {
        expect(decode(`${CTL.color}ab`)).toEqual({ kind: 'noop', consumed: 1, reason: 'unknown-control' });
        expect(decode(`${CTL.color}1`)).toEqual({ kind: 'noop', consumed: 1, reason: 'unknown-control' });
    });
});

describe('ncurses pair controls (bare @)', () => {
    it('requires exactly five digits', () => {
        const result = decodeAt(`${CTL.color}@01234`, 0);
        expect(result?.consumed).toBe(7);
        expect(result?.instruction).toEqual({ kind: 'pair', value: 1234 });
    });

    it('consumes only the marker and @ when the digits are missing', () => {
        expect(decode(`${CTL.color}@12`)).toEqual({ kind: 'noop', consumed: 2, reason: 'truncated-payload' });
    });
});

describe('emphasis, bar and reset controls', () => {
    it('consumes the emphasis marker', () => {
        expect(decode(`${CTL.color}E`)).toEqual({ kind: 'emphasis', consumed: 2 });
    });

    it('consumes recognized bar references', () => {
        // GUI_COLOR_BAR_*_CHAR, src/gui/gui-color.h:136-145.
        for (const reference of ['F', 'D', 'B', '_', '-', '#', 'i', 'l', 's']) {
            expect(decode(`${CTL.color}b${reference}`)).toEqual({ kind: 'bar', consumed: 3 });
        }
    });

    it('consumes the bar marker but not an unknown reference', () => {
        expect(decode(`${CTL.color}bX`)).toEqual({ kind: 'noop', consumed: 2, reason: 'unknown-bar-reference' });
        expect(decode(`${CTL.color}b`)).toEqual({ kind: 'noop', consumed: 2, reason: 'unknown-bar-reference' });
    });

    it('distinguishes color-only reset from full reset', () => {
        expect(decode(`${CTL.color}${CTL.reset}`)).toEqual({ kind: 'reset-colors', consumed: 2 });
        expect(decode(CTL.reset)).toEqual({ kind: 'reset-all', consumed: 1 });
    });
});

describe('set/remove attribute controls', () => {
    const supported = [
        [CTL.attrBold, 'bold'],
        [CTL.attrReverse, 'reverse'],
        [CTL.attrItalic, 'italic'],
        [CTL.attrUnderline, 'underline'],
        [CTL.attrBlink, 'blink'],
        [CTL.attrDim, 'dim'],
    ] as const;

    it('consumes the control plus a supported attribute control character', () => {
        for (const [char, name] of supported) {
            expect(decodeAt(`${CTL.setAttr}${char}`, 0)?.instruction).toEqual({ kind: 'set-attr', attribute: name });
            expect(decodeAt(`${CTL.removeAttr}${char}`, 0)?.instruction).toEqual({
                kind: 'remove-attr',
                attribute: name,
            });
            expect(decode(`${CTL.setAttr}${char}`).consumed).toBe(2);
        }
    });

    it('consumes only the control character for printable attribute markers', () => {
        // Upstream recognizes only control characters after \x1a/\x1b; the
        // printable markers are ordinary text (see docs/format.md).
        for (const marker of ['*', '!', '/', '_', '%', '.', '|']) {
            expect(decode(`${CTL.setAttr}${marker}`)).toEqual({
                kind: 'noop',
                consumed: 1,
                reason: 'invalid-attribute',
            });
        }
    });
});

describe('non-control input', () => {
    it('reports no instruction for ordinary text', () => {
        expect(decode('a')).toEqual({ kind: 'none', consumed: 0 });
        expect(decode('')).toEqual({ kind: 'none', consumed: 0 });
    });

    it('treats NUL as a payload boundary', () => {
        expect(decode(`${CTL.color}F0\u0000`)).toEqual({ kind: 'noop', consumed: 2, reason: 'truncated-payload' });
    });
});
