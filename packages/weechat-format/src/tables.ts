/**
 * Constant tables for the WeeChat inline formatting protocol.
 *
 * Provenance: WeeChat 4.10.1 (`/tmp/weechat-4.10.1`). Every table cites the
 * file and line range it was transcribed from; `test/tables.test.ts` re-checks
 * the tables against the transcription notes in `docs/format.md`.
 */

import type { AttributeName, ThemeColorName, WeechatColorName } from './types.js';

// ---- Control characters (src/gui/gui-color.h:102-112) ----

/** `\x19` introduces a color instruction. */
export const COLOR_CHAR = '\x19';
/** `\x1a` sets an attribute. */
export const SET_ATTR_CHAR = '\x1a';
/** `\x1b` removes an attribute. */
export const REMOVE_ATTR_CHAR = '\x1b';
/** `\x1c` resets colors and attributes. */
export const RESET_CHAR = '\x1c';

// ---- Color form markers (src/gui/gui-color.h:122-136) ----

export const FG_CHAR = 'F';
export const BG_CHAR = 'B';
export const FG_BG_CHAR = '*';
export const EXTENDED_CHAR = '@';
export const EMPHASIS_CHAR = 'E';
export const BAR_CHAR = 'b';

/** Legacy FG/BG separator, used up to WeeChat 2.5 and still accepted (gui-curses-window.c:824-829). */
export const LEGACY_SEPARATOR = ',';
/** Current FG/BG separator since WeeChat 2.6. */
export const SEPARATOR = '~';

// ---- Attribute encodings ----

/**
 * Attribute characters accepted directly after `\x1a` / `\x1b`
 * (GUI_COLOR_ATTR_*_CHAR, src/gui/gui-color.h:107-112).
 */
export const ATTRIBUTE_CONTROL_CHARS: ReadonlyMap<string, AttributeName> = new Map<string, AttributeName>([
    ['\x01', 'bold'],
    ['\x02', 'reverse'],
    ['\x03', 'italic'],
    ['\x04', 'underline'],
    ['\x05', 'blink'],
    ['\x06', 'dim'],
]);

/**
 * Attribute characters accepted inside a color payload, before the numeric
 * field (GUI_COLOR_EXTENDED_*_CHAR, src/gui/gui-color.h:126-132; consumed by
 * `gui_color_attr_get_flag`, src/gui/gui-color.c). Control characters are *not*
 * valid here.
 */
export const EXTENDED_ATTRIBUTE_CHARS: ReadonlyMap<string, AttributeName> = new Map<string, AttributeName>([
    ['%', 'blink'],
    ['.', 'dim'],
    ['*', 'bold'],
    ['!', 'reverse'],
    ['/', 'italic'],
    ['_', 'underline'],
]);

/** `|` in a color payload means "keep the current attributes". */
export const KEEP_ATTRIBUTE_CHAR = '|';

/** Attribute order used when building internal bitmasks. */
export const ATTRIBUTE_NAMES: readonly AttributeName[] = [
    'bold',
    'reverse',
    'italic',
    'underline',
    'blink',
    'dim',
];

// ---- Bar references (`\x19b` + reference) ----

/**
 * Bar references are styling *references* or layout-only instructions used in
 * bar item definitions; inside chat text they are recognized and consumed but
 * never render a style (src/gui/curses/gui-curses-chat.c:298-314).
 */
export type BarReference =
    | 'fg'
    | 'delim'
    | 'bg'
    | 'start-input'
    | 'start-input-hidden'
    | 'move-cursor'
    | 'start-item'
    | 'start-line-item'
    | 'spacer';

/** src/gui/gui-color.h:137-145. */
export const BAR_REFERENCES: ReadonlyMap<string, BarReference> = new Map<string, BarReference>([
    ['F', 'fg'],
    ['D', 'delim'],
    ['B', 'bg'],
    ['_', 'start-input'],
    ['-', 'start-input-hidden'],
    ['#', 'move-cursor'],
    ['i', 'start-item'],
    ['l', 'start-line-item'],
    ['s', 'spacer'],
]);

// ---- Named palette (src/gui/curses/gui-curses-color.c:52-92) ----

/**
 * The 17 WeeChat named colors, index-aligned with `gui_weechat_colors`.
 * Index 0 is the terminal default. Attributes are *not* modelled here: on a
 * terminal with at least 16 colors WeeChat selects `gui_weechat_colors_no_bold`
 * (gui-curses-color.c:1532-1543), so the light colors carry no implicit bold.
 */
export const WEECHAT_PALETTE: readonly WeechatColorName[] = [
    'default',
    'black',
    'darkgray',
    'red',
    'lightred',
    'green',
    'lightgreen',
    'brown',
    'yellow',
    'blue',
    'lightblue',
    'magenta',
    'lightmagenta',
    'cyan',
    'lightcyan',
    'gray',
    'white',
] as const;

/** Highest valid named palette index (`GUI_CURSES_NUM_WEECHAT_COLORS - 1`). */
export const MAX_WEECHAT_COLOR = WEECHAT_PALETTE.length - 1;

// ---- Theme option colors (src/gui/gui-color.h:41-98) ----

/**
 * Theme option color names, index-aligned with `t_gui_color_enum`. Indices
 * 17-26 are the obsolete `chat_nick1`..`chat_nick10` colors kept for `/upgrade`
 * compatibility; upstream resolves them to hardcoded palette colors (see
 * docs/format.md), which the library deliberately does not do.
 */
export const THEME_COLORS: readonly ThemeColorName[] = [
    'separator', // 0
    'chat', // 1
    'chat_time', // 2
    'chat_time_delimiters', // 3
    'chat_prefix_error', // 4
    'chat_prefix_network', // 5
    'chat_prefix_action', // 6
    'chat_prefix_join', // 7
    'chat_prefix_quit', // 8
    'chat_prefix_more', // 9
    'chat_prefix_suffix', // 10
    'chat_buffer', // 11
    'chat_server', // 12
    'chat_channel', // 13
    'chat_nick', // 14
    'chat_nick_self', // 15
    'chat_nick_other', // 16
    'chat_nick1', // 17 (obsolete)
    'chat_nick2', // 18 (obsolete)
    'chat_nick3', // 19 (obsolete)
    'chat_nick4', // 20 (obsolete)
    'chat_nick5', // 21 (obsolete)
    'chat_nick6', // 22 (obsolete)
    'chat_nick7', // 23 (obsolete)
    'chat_nick8', // 24 (obsolete)
    'chat_nick9', // 25 (obsolete)
    'chat_nick10', // 26 (obsolete)
    'chat_host', // 27
    'chat_delimiters', // 28
    'chat_highlight', // 29
    'chat_read_marker', // 30
    'chat_text_found', // 31
    'chat_value', // 32
    'chat_prefix_buffer', // 33
    'chat_tags', // 34
    'chat_inactive_window', // 35
    'chat_inactive_buffer', // 36
    'chat_prefix_buffer_inactive_buffer', // 37
    'chat_nick_offline', // 38
    'chat_nick_offline_highlight', // 39
    'chat_nick_prefix', // 40
    'chat_nick_suffix', // 41
    'emphasis', // 42
    'chat_day_change', // 43
    'chat_value_null', // 44
    'chat_status_disabled', // 45
    'chat_status_enabled', // 46
] as const;

/** Highest valid theme color index (`GUI_COLOR_NUM_COLORS - 1`). */
export const MAX_THEME_COLOR = THEME_COLORS.length - 1;

/** Largest numeric payload WeeChat documents (`GUI_COLOR_EXTENDED_MAX`, gui-color.h:156). */
export const MAX_EXTENDED_COLOR = 99999;
