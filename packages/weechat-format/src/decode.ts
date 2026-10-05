/**
 * Control decoder: reads one instruction directly from `(input, offset)` and
 * reports the typed instruction plus its consumed extent.
 *
 * Consumption rules mirror the WeeChat 4.10.1 *renderer*
 * (`gui_chat_string_next_char` + `gui_window_string_apply_color_*`,
 * src/gui/curses/gui-curses-chat.c:241-374, src/gui/curses/gui-curses-window.c:641-1038),
 * which is the authoritative decoder for how much of a malformed payload is
 * swallowed. The `gui_color_code_size()` scanner and `gui_color_decode()`
 * stripper disagree in a few places; those divergences are recorded in
 * docs/format.md and are deliberately *not* followed here.
 *
 * This module decodes syntax only. It never decides whether a decoded value is
 * in a valid range or what it does to a style — that is `style.ts`'s job.
 */

import {
    BAR_CHAR,
    BAR_REFERENCES,
    BG_CHAR,
    COLOR_CHAR,
    EXTENDED_CHAR,
    FG_BG_CHAR,
    FG_CHAR,
    EMPHASIS_CHAR,
    KEEP_ATTRIBUTE_CHAR,
    LEGACY_SEPARATOR,
    REMOVE_ATTR_CHAR,
    RESET_CHAR,
    SEPARATOR,
    SET_ATTR_CHAR,
    ATTRIBUTE_NAMES,
    ATTRIBUTE_CONTROL_CHARS,
    EXTENDED_ATTRIBUTE_CHARS,
    type BarReference,
} from './tables.js';
import type { AttributeName, DiagnosticReason } from './types.js';

// ---- Private attribute bitmask ----
// Bitmasks are an internal representation; the public model uses named
// tri-state attributes (see types.ts / style.ts).

const BIT_BOLD = 1;
const BIT_REVERSE = 2;
const BIT_ITALIC = 4;
const BIT_UNDERLINE = 8;
const BIT_BLINK = 16;
const BIT_DIM = 32;
const BIT_KEEP = 64;

const ATTRIBUTE_BITS: Record<AttributeName, number> = {
    bold: BIT_BOLD,
    reverse: BIT_REVERSE,
    italic: BIT_ITALIC,
    underline: BIT_UNDERLINE,
    blink: BIT_BLINK,
    dim: BIT_DIM,
};

/** Attribute names carried by a decoded bitmask, in table order. */
export function attributesOfMask(mask: number): AttributeName[] {
    const names: AttributeName[] = [];
    for (const name of ATTRIBUTE_NAMES) {
        if (mask & ATTRIBUTE_BITS[name]) {
            names.push(name);
        }
    }
    return names;
}

/** Whether a payload carried `|` (keep the current attributes). */
export function keepsAttributes(mask: number): boolean {
    return (mask & BIT_KEEP) !== 0;
}

// ---- Instruction types (internal: not part of the public API) ----

/** A numeric color payload: which form it used and the parsed value. */
export interface NumericPayload {
    readonly extended: boolean;
    readonly value: number;
}

export type Instruction =
    | { readonly kind: 'fg'; readonly payload: NumericPayload; readonly attributes: number }
    | { readonly kind: 'bg'; readonly payload: NumericPayload }
    | { readonly kind: 'fgbg'; readonly fg: NumericPayload; readonly bg: NumericPayload; readonly attributes: number }
    | { readonly kind: 'theme'; readonly index: number }
    | { readonly kind: 'pair'; readonly value: number }
    | { readonly kind: 'emphasis' }
    | { readonly kind: 'bar'; readonly reference: BarReference }
    | { readonly kind: 'reset-colors' }
    | { readonly kind: 'reset-all' }
    | { readonly kind: 'set-attr'; readonly attribute: AttributeName }
    | { readonly kind: 'remove-attr'; readonly attribute: AttributeName }
    | { readonly kind: 'noop'; readonly reason: DiagnosticReason };

export interface DecodedInstruction {
    readonly instruction: Instruction;
    /** UTF-16 units consumed from `offset`; always >= 1 for a control character. */
    readonly consumed: number;
}

// ---- Bounded helpers ----

/**
 * True when `count` characters exist at `pos` and none of them is NUL.
 *
 * Upstream tests `ptr[0] && ptr[1] …`, i.e. "the string has at least this many
 * characters left". JavaScript strings are length-terminated rather than
 * NUL-terminated, so NUL is treated as a payload boundary (documented policy).
 */
function hasPayload(input: string, pos: number, count: number): boolean {
    const end = pos + count;
    if (end > input.length) {
        return false;
    }
    for (let i = pos; i < end; i++) {
        if (input.charCodeAt(i) === 0) {
            return false;
        }
    }
    return true;
}

/**
 * Bounded decimal reader mirroring `util_parse_int()` (src/core/core-util.c:64-88):
 * `strtol(str, &end, 10)` accepted only when the whole window is consumed, so
 * leading whitespace and an optional sign are allowed but trailing garbage is
 * not. Never looks beyond the fixed payload window.
 */
export function parseBoundedInt(window: string): number | null {
    if (!/^[ \t\n\r\f\v]*[+-]?[0-9]+$/.test(window)) {
        return null;
    }
    const value = Number(window);
    return Number.isSafeInteger(value) ? value : null;
}

/** True for the five ASCII digits `gui_color_code_size`/`apply_color_pair` require. */
function isAsciiDigit(ch: string | undefined): boolean {
    return ch !== undefined && ch >= '0' && ch <= '9';
}

/** Consume a run of extended attribute characters, returning the new offset and bitmask. */
function scanAttributeRun(input: string, pos: number): { pos: number; mask: number } {
    let mask = 0;
    let i = pos;
    while (i < input.length) {
        const ch = input.charAt(i);
        if (ch === KEEP_ATTRIBUTE_CHAR) {
            mask |= BIT_KEEP;
            i++;
            continue;
        }
        const attribute = EXTENDED_ATTRIBUTE_CHARS.get(ch);
        if (attribute === undefined) {
            break;
        }
        mask |= ATTRIBUTE_BITS[attribute];
        i++;
    }
    return { pos: i, mask };
}

// ---- Payload decoders ----

/**
 * `F` payload: `(@)?(A)*NNNNN` or `(A)*NN`.
 *
 * Upstream consumes the fixed payload width whenever enough characters remain,
 * even when the payload is not numeric; a failed parse then leaves the style
 * untouched (gui-curses-window.c:641-700).
 */
function decodeFgPayload(input: string, start: number, pos: number): DecodedInstruction {
    if (input.charAt(pos) === EXTENDED_CHAR) {
        const afterMarker = pos + 1;
        const run = scanAttributeRun(input, afterMarker);
        if (!hasPayload(input, run.pos, 5)) {
            return { instruction: { kind: 'noop', reason: 'truncated-payload' }, consumed: run.pos - start };
        }
        const value = parseBoundedInt(input.slice(run.pos, run.pos + 5));
        const consumed = run.pos + 5 - start;
        if (value === null) {
            return { instruction: { kind: 'noop', reason: 'invalid-numeric' }, consumed };
        }
        return {
            instruction: { kind: 'fg', payload: { extended: true, value }, attributes: run.mask },
            consumed,
        };
    }

    const run = scanAttributeRun(input, pos);
    if (!hasPayload(input, run.pos, 2)) {
        return { instruction: { kind: 'noop', reason: 'truncated-payload' }, consumed: run.pos - start };
    }
    const value = parseBoundedInt(input.slice(run.pos, run.pos + 2));
    const consumed = run.pos + 2 - start;
    if (value === null) {
        return { instruction: { kind: 'noop', reason: 'invalid-numeric' }, consumed };
    }
    return {
        instruction: { kind: 'fg', payload: { extended: false, value }, attributes: run.mask },
        consumed,
    };
}

/**
 * `B` payload: `@NNNNN` or `NN`. No attribute characters are accepted.
 *
 * Note the asymmetry with `F`: when an `@` payload is truncated the `@` itself
 * is *not* consumed (gui-curses-window.c:709-755).
 */
function decodeBgPayload(input: string, start: number, pos: number): DecodedInstruction {
    if (input.charAt(pos) === EXTENDED_CHAR) {
        if (!hasPayload(input, pos + 1, 5)) {
            return { instruction: { kind: 'noop', reason: 'truncated-payload' }, consumed: pos - start };
        }
        const value = parseBoundedInt(input.slice(pos + 1, pos + 6));
        const consumed = pos + 6 - start;
        if (value === null) {
            return { instruction: { kind: 'noop', reason: 'invalid-numeric' }, consumed };
        }
        return { instruction: { kind: 'bg', payload: { extended: true, value } }, consumed };
    }

    if (!hasPayload(input, pos, 2)) {
        return { instruction: { kind: 'noop', reason: 'truncated-payload' }, consumed: pos - start };
    }
    const value = parseBoundedInt(input.slice(pos, pos + 2));
    const consumed = pos + 2 - start;
    if (value === null) {
        return { instruction: { kind: 'noop', reason: 'invalid-numeric' }, consumed };
    }
    return { instruction: { kind: 'bg', payload: { extended: false, value } }, consumed };
}

/**
 * `*` payload: an `F`-shaped foreground followed by an optional `,`/`~` and a
 * `B`-shaped background. The instruction is only produced when *both* numeric
 * payloads parse; the consumed extent is reported either way
 * (gui-curses-window.c:764-871).
 */
function decodeFgBgPayload(input: string, start: number, pos: number): DecodedInstruction {
    let attributes: number;
    let fg: NumericPayload | null = null;
    let failure: DiagnosticReason | null = null;
    let i = pos;

    if (input.charAt(i) === EXTENDED_CHAR) {
        const run = scanAttributeRun(input, i + 1);
        i = run.pos;
        attributes = run.mask;
        if (hasPayload(input, i, 5)) {
            const value = parseBoundedInt(input.slice(i, i + 5));
            i += 5;
            if (value !== null) {
                fg = { extended: true, value };
            } else {
                failure = 'invalid-numeric';
            }
        } else {
            failure = 'truncated-payload';
        }
    } else {
        const run = scanAttributeRun(input, i);
        i = run.pos;
        attributes = run.mask;
        if (hasPayload(input, i, 2)) {
            const value = parseBoundedInt(input.slice(i, i + 2));
            i += 2;
            if (value !== null) {
                fg = { extended: false, value };
            } else {
                failure = 'invalid-numeric';
            }
        } else {
            failure = 'truncated-payload';
        }
    }

    let bg: NumericPayload | null = null;
    const separator = input.charAt(i);
    if (separator === LEGACY_SEPARATOR || separator === SEPARATOR) {
        i++;
        if (input.charAt(i) === EXTENDED_CHAR) {
            if (hasPayload(input, i + 1, 5)) {
                const value = parseBoundedInt(input.slice(i + 1, i + 6));
                i += 6;
                if (value !== null) {
                    bg = { extended: true, value };
                } else if (failure === null) {
                    failure = 'invalid-numeric';
                }
            } else if (failure === null) {
                failure = 'truncated-payload';
            }
        } else if (hasPayload(input, i, 2)) {
            const value = parseBoundedInt(input.slice(i, i + 2));
            i += 2;
            if (value !== null) {
                bg = { extended: false, value };
            } else if (failure === null) {
                failure = 'invalid-numeric';
            }
        } else if (failure === null) {
            failure = 'truncated-payload';
        }
    } else if (failure === null) {
        // No background part at all: upstream still consumed the foreground
        // payload and applies nothing.
        failure = 'truncated-payload';
    }

    const consumed = i - start;
    if (fg === null || bg === null) {
        return { instruction: { kind: 'noop', reason: failure ?? 'truncated-payload' }, consumed };
    }
    return { instruction: { kind: 'fgbg', fg, bg, attributes }, consumed };
}


/** Bare `@NNNNN`: an ncurses pair number; requires exactly five digits. */
function decodePair(input: string, start: number, pos: number): DecodedInstruction {
    if (
        isAsciiDigit(input.charAt(pos)) &&
        isAsciiDigit(input.charAt(pos + 1)) &&
        isAsciiDigit(input.charAt(pos + 2)) &&
        isAsciiDigit(input.charAt(pos + 3)) &&
        isAsciiDigit(input.charAt(pos + 4))
    ) {
        const value = Number(input.slice(pos, pos + 5));
        return { instruction: { kind: 'pair', value }, consumed: pos + 5 - start };
    }
    return { instruction: { kind: 'noop', reason: 'truncated-payload' }, consumed: pos - start };
}

/** Bare two digits: a theme option color index (`apply_color_weechat`). */
function decodeThemeIndex(input: string, start: number, pos: number): DecodedInstruction {
    if (isAsciiDigit(input.charAt(pos)) && isAsciiDigit(input.charAt(pos + 1))) {
        return {
            instruction: { kind: 'theme', index: Number(input.slice(pos, pos + 2)) },
            consumed: pos + 2 - start,
        };
    }
    return { instruction: { kind: 'noop', reason: 'unknown-control' }, consumed: pos - start };
}

// ---- Public (package-internal) entry point ----

/**
 * Decode the instruction starting at `offset`, or return `null` when `offset`
 * does not hold a control character.
 *
 * Every control character consumes at least one unit, so callers always make
 * forward progress.
 */
export function decodeAt(input: string, offset: number): DecodedInstruction | null {
    const control = input.charAt(offset);
    if (control === COLOR_CHAR) {
        const pos = offset + 1;
        const marker = input.charAt(pos);
        switch (marker) {
        case FG_CHAR:
            return decodeFgPayload(input, offset, pos + 1);
        case BG_CHAR:
            return decodeBgPayload(input, offset, pos + 1);
        case FG_BG_CHAR:
            return decodeFgBgPayload(input, offset, pos + 1);
        case EXTENDED_CHAR:
            return decodePair(input, offset, pos + 1);
        case EMPHASIS_CHAR:
            return { instruction: { kind: 'emphasis' }, consumed: 2 };
        case BAR_CHAR: {
            const reference = BAR_REFERENCES.get(input.charAt(pos + 1));
            if (reference !== undefined) {
                return { instruction: { kind: 'bar', reference }, consumed: 3 };
            }
            // `b` is consumed, the character after it is ordinary text.
            return { instruction: { kind: 'noop', reason: 'unknown-bar-reference' }, consumed: 2 };
        }
        case RESET_CHAR:
            return { instruction: { kind: 'reset-colors' }, consumed: 2 };
        default:
            return decodeThemeIndex(input, offset, pos);
        }
    }

    if (control === SET_ATTR_CHAR || control === REMOVE_ATTR_CHAR) {
        const attribute = ATTRIBUTE_CONTROL_CHARS.get(input.charAt(offset + 1));
        if (attribute === undefined) {
            // Only the control character is consumed; the rest is text.
            return { instruction: { kind: 'noop', reason: 'invalid-attribute' }, consumed: 1 };
        }
        return {
            instruction: { kind: control === SET_ATTR_CHAR ? 'set-attr' : 'remove-attr', attribute },
            consumed: 2,
        };
    }

    if (control === RESET_CHAR) {
        return { instruction: { kind: 'reset-all' }, consumed: 1 };
    }

    return null;
}
