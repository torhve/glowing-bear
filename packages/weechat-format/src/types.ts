/**
 * Domain model for the WeeChat inline chat formatting protocol.
 *
 * Provenance: WeeChat 4.10.1 (`/tmp/weechat-4.10.1`), see `docs/format.md`.
 * The library models *references* to colors (palette names, theme option names,
 * extended color indices) and never resolves them to RGB values: resolution is
 * the consumer's responsibility.
 */

/** The 17 WeeChat named palette colors (`gui_weechat_colors_*`, gui-curses-color.c:52-91). */
export type WeechatColorName =
    | 'default'
    | 'black'
    | 'darkgray'
    | 'red'
    | 'lightred'
    | 'green'
    | 'lightgreen'
    | 'brown'
    | 'yellow'
    | 'blue'
    | 'lightblue'
    | 'magenta'
    | 'lightmagenta'
    | 'cyan'
    | 'lightcyan'
    | 'gray'
    | 'white';

/**
 * Theme option color names, index-aligned with `t_gui_color_enum`
 * (gui-color.h:41-98). Index 17-26 are the obsolete `chat_nick1`..`chat_nick10`
 * colors, kept upstream for compatibility.
 */
export type ThemeColorName =
    | 'separator'
    | 'chat'
    | 'chat_time'
    | 'chat_time_delimiters'
    | 'chat_prefix_error'
    | 'chat_prefix_network'
    | 'chat_prefix_action'
    | 'chat_prefix_join'
    | 'chat_prefix_quit'
    | 'chat_prefix_more'
    | 'chat_prefix_suffix'
    | 'chat_buffer'
    | 'chat_server'
    | 'chat_channel'
    | 'chat_nick'
    | 'chat_nick_self'
    | 'chat_nick_other'
    | 'chat_nick1'
    | 'chat_nick2'
    | 'chat_nick3'
    | 'chat_nick4'
    | 'chat_nick5'
    | 'chat_nick6'
    | 'chat_nick7'
    | 'chat_nick8'
    | 'chat_nick9'
    | 'chat_nick10'
    | 'chat_host'
    | 'chat_delimiters'
    | 'chat_highlight'
    | 'chat_read_marker'
    | 'chat_text_found'
    | 'chat_value'
    | 'chat_prefix_buffer'
    | 'chat_tags'
    | 'chat_inactive_window'
    | 'chat_inactive_buffer'
    | 'chat_prefix_buffer_inactive_buffer'
    | 'chat_nick_offline'
    | 'chat_nick_offline_highlight'
    | 'chat_nick_prefix'
    | 'chat_nick_suffix'
    | 'emphasis'
    | 'chat_day_change'
    | 'chat_value_null'
    | 'chat_status_disabled'
    | 'chat_status_enabled';

/** The six text attributes WeeChat can set or remove. */
export type AttributeName = 'bold' | 'reverse' | 'italic' | 'underline' | 'blink' | 'dim';

/**
 * Tri-state attribute model:
 * - `inherited`: no instruction has decided this attribute for the run.
 * - `enabled`: an instruction explicitly turned it on.
 * - `disabled`: an instruction explicitly turned it off (color codes clear
 *   attributes they do not carry).
 */
export type AttributeState = 'inherited' | 'enabled' | 'disabled';

/** Attributes of a style, keyed by attribute name. */
export type Attributes = Readonly<Record<AttributeName, AttributeState>>;

/**
 * A color reference. Discriminated by `kind`:
 * - `default`: the terminal/base color (palette index 0, fg/bg = -1 upstream).
 * - `weechat`: one of the 17 named palette colors (index 1-16).
 * - `theme`: a theme option color referenced by index (0-46).
 * - `extended`: a numeric color index (`@NNNNN` payloads, 0-99999).
 */
export type ColorRef =
    | { readonly kind: 'default' }
    | { readonly kind: 'weechat'; readonly name: WeechatColorName }
    | { readonly kind: 'theme'; readonly name: ThemeColorName; readonly index: number }
    | { readonly kind: 'extended'; readonly value: number };

/**
 * An immutable style snapshot. `themeAttrs` preserves the *symbolic* theme
 * color whose configuration-defined attributes apply to the run; the library
 * cannot know those attributes, so it keeps the reference unresolved.
 */
export interface Style {
    readonly fg: ColorRef;
    readonly bg: ColorRef;
    readonly attrs: Attributes;
    readonly themeAttrs: ThemeColorName | null;
    readonly emphasis: boolean;
}

/** A run of ordinary text carrying the style that applies to it. */
export interface TextRun {
    readonly text: string;
    readonly style: Style;
}

/** Why the decoder consumed a control without producing a style change. */
export type DiagnosticReason =
    | 'unknown-control'
    | 'unknown-bar-reference'
    | 'truncated-payload'
    | 'invalid-numeric'
    | 'invalid-attribute'
    | 'out-of-range-color';

/** A malformed-input record reported through `ParseOptions.onDiagnostic`. */
export interface ParseDiagnostic {
    readonly reason: DiagnosticReason;
    /** UTF-16 index of the control character in the input (not a UTF-8 byte offset). */
    readonly offset: number;
    /** Number of UTF-16 units the decoder consumed for this instruction. */
    readonly consumed: number;
}

export interface ParseOptions {
    /** Optional diagnostics sink; called once per malformed/ignored instruction. */
    readonly onDiagnostic?: (diagnostic: ParseDiagnostic) => void;
}

/**
 * Result of `parseWeeChatStyle`, which accepts formatting-only input and
 * rejects unexpected text instead of guessing which segment matters.
 * Recognized-but-non-rendering instructions do not fail the parse: they leave
 * the style unchanged and are reported through `ParseOptions.onDiagnostic`.
 */
export type StyleParseResult =
    | { readonly ok: true; readonly style: Style }
    | {
          readonly ok: false;
          readonly reason: 'empty-input' | 'unexpected-text';
          readonly offset: number;
      };
