/**
 * Style interpreter: applies decoded instructions to an explicit initial style.
 *
 * Every transition mirrors the WeeChat 4.10.1 curses renderer
 * (`gui_window_set_custom_color_fg` / `_bg` / `_fg_bg`, `set_weechat_color`,
 * `set_custom_color_pair`, `reset_color`, `reset_style` —
 * src/gui/curses/gui-curses-window.c:395-574, gui-curses-chat.c:315-365).
 *
 * Style objects are never mutated: each applied instruction returns a fresh
 * object, so runs emitted earlier can never be changed by later controls.
 */

import { keepsAttributes, maskEnablesAttribute, type Instruction } from './decode.js';
import {
    MAX_EXTENDED_COLOR,
    MAX_THEME_COLOR,
    MAX_WEECHAT_COLOR,
    THEME_COLORS,
    WEECHAT_PALETTE,
} from './tables.js';
import type {
    AttributeName,
    AttributeState,
    Attributes,
    ColorRef,
    DiagnosticReason,
    Style,
    ThemeColorName,
} from './types.js';

/**
 * Palette index 0 is the terminal default; 1-16 are the named colors.
 *
 * ColorRef objects are immutable and there are only 18 distinct ones, so they
 * are built once and shared instead of allocated per control: an ordinary chat
 * line that uses the default or a palette colour now allocates no ColorRef at
 * all, and `stylesEqual` can settle most of its comparisons on identity.
 */
const DEFAULT_COLOR: ColorRef = Object.freeze({ kind: 'default' } as const);
const PALETTE_COLORS: readonly ColorRef[] = WEECHAT_PALETTE.map((name, index) =>
    index === 0
        ? DEFAULT_COLOR
        : Object.freeze({ kind: 'weechat', name } as const),
);

function paletteColor(index: number): ColorRef {
    // Out-of-table indices fall back to the default, as before.
    return PALETTE_COLORS[index] ?? DEFAULT_COLOR;
}

function attributesWith(states: Partial<Record<AttributeName, AttributeState>>): Attributes {
    return {
        bold: states.bold ?? 'inherited',
        reverse: states.reverse ?? 'inherited',
        italic: states.italic ?? 'inherited',
        underline: states.underline ?? 'inherited',
        blink: states.blink ?? 'inherited',
        dim: states.dim ?? 'inherited',
    };
}

/** Fresh attributes with no decision made. */
function inheritedAttributes(): Attributes {
    return attributesWith({});
}

/**
 * The explicit initial style: base colors, no attribute decision, no emphasis.
 * Upstream starts each line with the chat theme color and no attributes.
 *
 * Frozen so the shared reference cannot be corrupted; parsers build a fresh
 * style per call through `createInitialStyle()` instead of reusing it.
 */
export const INITIAL_STYLE: Style = Object.freeze({
    fg: Object.freeze({ kind: 'default' } as const),
    bg: Object.freeze({ kind: 'default' } as const),
    attrs: Object.freeze(attributesWith({})),
    themeAttrs: null,
    emphasis: false,
});

/** A fresh initial style; nothing is shared between parser calls. */
export function createInitialStyle(): Style {
    return {
        fg: { kind: 'default' },
        bg: { kind: 'default' },
        attrs: inheritedAttributes(),
        themeAttrs: null,
        emphasis: false,
    };
}

export interface StyleTransition {
    readonly style: Style;
    /** Set when the instruction was recognized but produced no style change. */
    readonly diagnostic: DiagnosticReason | null;
}

/** Attributes with every attribute explicitly cleared. */
function clearedAttributes(): Attributes {
    return attributesWith({
        bold: 'disabled',
        reverse: 'disabled',
        italic: 'disabled',
        underline: 'disabled',
        blink: 'disabled',
        dim: 'disabled',
    });
}

/**
 * Attributes for a color payload.
 *
 * Upstream applies the same rule to two-digit and extended payloads
 * (gui-curses-window.c:404-441 and 500-527): a flag present in the payload is
 * enabled, everything else is cleared *unless* the payload carried `|`
 * (GUI_COLOR_EXTENDED_KEEPATTR_FLAG), which keeps the current attributes.
 *
 * The only upstream difference is that a two-digit payload also ORs in the
 * palette entry's own attributes, which are non-zero only in the *bold*
 * palette table — used only when the terminal has fewer than 16 colors or
 * `look_color_basic_force_bold` is on (gui-curses-color.c:1532-1543). A
 * browser always has at least 16 colors, so the library models the no-bold
 * palette and derives no attributes from the palette itself. See
 * docs/format.md.
 */
function adjustedAttributes(mask: number, current: Attributes): Attributes {
    const keep = keepsAttributes(mask);
    const decide = (name: AttributeName, enabled: boolean): AttributeState => {
        if (enabled) {
            return 'enabled';
        }
        return keep ? current[name] : 'disabled';
    };
    return attributesWith({
        bold: decide('bold', maskEnablesAttribute(mask, 'bold')),
        reverse: decide('reverse', maskEnablesAttribute(mask, 'reverse')),
        italic: decide('italic', maskEnablesAttribute(mask, 'italic')),
        underline: decide('underline', maskEnablesAttribute(mask, 'underline')),
        blink: decide('blink', maskEnablesAttribute(mask, 'blink')),
        dim: decide('dim', maskEnablesAttribute(mask, 'dim')),
    });
}

function unchanged(style: Style, diagnostic: DiagnosticReason | null): StyleTransition {
    return { style, diagnostic };
}

/** A numeric payload used as a color: palette index, or an extended index. */
function colorFromPayload(extended: boolean, value: number): ColorRef | null {
    if (value < 0 || value > MAX_EXTENDED_COLOR) {
        // Negative payloads are not producible by WeeChat; upstream would hand
        // a nonsense index to the terminal, so the library applies nothing.
        return null;
    }
    if (value === 0) {
        // Upstream guards the extended branch with `fg > 0` / `bg > 0`, so an
        // extended `@00000` falls through to palette index 0 (the default).
        return DEFAULT_COLOR;
    }
    if (!extended && value <= MAX_WEECHAT_COLOR) {
        return paletteColor(value);
    }
    // Out-of-palette two-digit values in a `*` payload are used by upstream as
    // raw terminal colors (gui-curses-window.c:528-558); a browser has no
    // palette-index meaning for them, so they become extended indices.
    return { kind: 'extended', value };
}

/**
 * Apply one decoded instruction to a style, returning the resulting style.
 *
 * `null` is returned for instructions that carry no style meaning (`bar`,
 * `noop`); callers treat that as "recognized, no rendering".
 */
export function applyInstruction(style: Style, instruction: Instruction): StyleTransition {
    switch (instruction.kind) {
    case 'fg': {
        const color = colorFromPayload(instruction.payload.extended, instruction.payload.value);
        if (color === null) {
            return unchanged(style, 'out-of-range-color');
        }
        // A two-digit `F` payload outside the palette is a no-op upstream
        // (`set_custom_color_fg` requires the index to be in range).
        if (!instruction.payload.extended && instruction.payload.value > MAX_WEECHAT_COLOR) {
            return unchanged(style, 'out-of-range-color');
        }
        return {
            style: {
                ...style,
                fg: color,
                // Payload flags adjust the attribute set; `|` keeps it.
                attrs: adjustedAttributes(instruction.attributes, style.attrs),
                themeAttrs: null,
            },
            diagnostic: null,
        };
    }

    case 'bg': {
        if (
            !instruction.payload.extended &&
                (instruction.payload.value < 0 || instruction.payload.value > MAX_WEECHAT_COLOR)
        ) {
            return unchanged(style, 'out-of-range-color');
        }
        const color = colorFromPayload(instruction.payload.extended, instruction.payload.value);
        if (color === null) {
            return unchanged(style, 'out-of-range-color');
        }
        // Background never touches attributes (gui-curses-window.c:464-486).
        return { style: { ...style, bg: color }, diagnostic: null };
    }

    case 'fgbg': {
        const fg = colorFromPayload(instruction.fg.extended, instruction.fg.value);
        const bg = colorFromPayload(instruction.bg.extended, instruction.bg.value);
        if (fg === null || bg === null) {
            return unchanged(style, 'out-of-range-color');
        }
        return {
            style: {
                ...style,
                fg,
                bg,
                attrs: adjustedAttributes(instruction.attributes, style.attrs),
                themeAttrs: null,
            },
            diagnostic: null,
        };
    }

    case 'theme': {
        if (instruction.index < 0 || instruction.index > MAX_THEME_COLOR) {
            // Out of `t_gui_color_enum` range: upstream applies nothing.
            return unchanged(style, 'out-of-range-color');
        }
        const name = THEME_COLORS[instruction.index] as ThemeColorName;
        const color: ColorRef = { kind: 'theme', name, index: instruction.index };
        return {
            style: {
                ...style,
                fg: color,
                bg: { ...color },
                // Upstream replaces the attributes with the theme color's
                // own (configuration-defined) attributes; the library keeps
                // the reference symbolic instead of guessing them.
                attrs: inheritedAttributes(),
                themeAttrs: name,
            },
            diagnostic: null,
        };
    }

    case 'pair': {
        // An ncurses pair number has no browser meaning. Upstream clears
        // all attributes when the pair is within the terminal's pair range;
        // that range is terminal-specific, so the library always clears.
        return {
            style: {
                ...style,
                attrs: clearedAttributes(),
                themeAttrs: null,
            },
            diagnostic: null,
        };
    }

    case 'emphasis': {
        return { style: { ...style, emphasis: !style.emphasis }, diagnostic: null };
    }

    case 'bar': {
        // Recognized layout/styling reference: consumed, never rendered.
        return unchanged(style, null);
    }

    case 'reset-colors': {
        // `\x19\x1c` resets colors and keeps attributes
        // (gui-curses-window.c:464-486 via gui-curses-chat.c:315-332).
        return {
            style: { ...style, fg: { kind: 'default' }, bg: { kind: 'default' } },
            diagnostic: null,
        };
    }

    case 'reset-all': {
        // `\x1c` resets colors and attributes to the base style.
        return {
            style: {
                ...style,
                fg: { kind: 'default' },
                bg: { kind: 'default' },
                attrs: inheritedAttributes(),
                themeAttrs: null,
            },
            diagnostic: null,
        };
    }

    case 'set-attr': {
        return {
            style: { ...style, attrs: { ...style.attrs, [instruction.attribute]: 'enabled' as AttributeState } },
            diagnostic: null,
        };
    }

    case 'remove-attr': {
        return {
            style: { ...style, attrs: { ...style.attrs, [instruction.attribute]: 'disabled' as AttributeState } },
            diagnostic: null,
        };
    }

    case 'noop': {
        return unchanged(style, instruction.reason);
    }
    }
}

/**
 * Structural equality used to coalesce adjacent runs.
 *
 * Identity first: Style, ColorRef and Attributes are immutable and increasingly
 * shared, so the common case is a pointer check. The attribute comparison is
 * unrolled because the loop version allocated a fresh array literal per call.
 */
export function stylesEqual(a: Style, b: Style): boolean {
    if (a === b) {
        return true;
    }
    if (a.emphasis !== b.emphasis || a.themeAttrs !== b.themeAttrs) {
        return false;
    }
    if (!colorsEqual(a.fg, b.fg) || !colorsEqual(a.bg, b.bg)) {
        return false;
    }
    const aa = a.attrs;
    const bb = b.attrs;
    return (
        aa.bold === bb.bold &&
        aa.reverse === bb.reverse &&
        aa.italic === bb.italic &&
        aa.underline === bb.underline &&
        aa.blink === bb.blink &&
        aa.dim === bb.dim
    );
}

function colorsEqual(a: ColorRef, b: ColorRef): boolean {
    if (a === b) {
        return true;
    }
    if (a.kind !== b.kind) {
        return false;
    }
    switch (a.kind) {
    case 'default':
        return true;
    case 'weechat':
        return a.name === (b as { name: string }).name;
    case 'theme':
        return a.index === (b as { index: number }).index;
    case 'extended':
        return a.value === (b as { value: number }).value;
    }
}
