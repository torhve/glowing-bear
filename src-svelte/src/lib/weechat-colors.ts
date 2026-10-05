// Application adapter for WeeChat's inline chat formatting.
//
// The color grammar lives in @glowingbear/weechat-format, which follows WeeChat
// 4.10.1 (see packages/weechat-format/docs/format.md). This file contains no
// grammar of its own: it maps the library's symbolic styles onto the app's
// RichTextPart shape and CSS class vocabulary, and converts mIRC formatting
// into the control sequences WeeChat's own IRC plugin produces.
//
// Deliberate app-side choices are recorded in
// packages/weechat-format/docs/behavior-differences.md.

import { MAX_EXTENDED_COLOR, WEECHAT_PALETTE, parseWeeChatStyle, parseWeeChatText } from '@glowingbear/weechat-format';
import type { AttributeName, ColorRef, Style } from '@glowingbear/weechat-format';
import type { ColorInfo, TextAttrs, RichTextPart } from '#lib/types.ts';

type RichPart = RichTextPart;
export type { RichPart };

// --- Style → app color/attribute vocabulary ---

const DEFAULT_COLOR: ColorInfo = { type: 'weechat', name: 'default' };
const EMPHASIS_COLOR: ColorInfo = { type: 'option', name: 'emphasis' };

// Attribute keys used by the CSS vocabulary (app.css: .a-b, .a-no-b, …).
const ATTRIBUTE_NAMES: readonly AttributeName[] = ['bold', 'reverse', 'italic', 'underline', 'blink', 'dim'];
const attributeKeys: Record<AttributeName, string> = {
    bold: 'b', reverse: 'r', italic: 'i', underline: 'u', blink: 'k', dim: 'd',
};

// Reverse lookup: attribute key -> char (used by richText2Str)
const attrValueToChar: Record<string, string> = {
    'b': '*', 'r': '!', 'i': '/', 'u': '_', 'k': '%', 'd': '.',
};

// Palette name -> index, for the diagnostic formatter in richText2Str.
const colorNameToIndex = new Map<string, number>(WEECHAT_PALETTE.map((name, index) => [name, index]));

// t_gui_color_enum slots 17-26 are the chat_nick1..chat_nick10 colors removed in
// WeeChat 0.3.4 but kept in the enum (gui-color.h:61-74). Upstream still renders
// them from a hardcoded palette (gui-curses-color.c:1590-1599); the app has no
// CSS for them, so they resolve to the default text color instead. Recorded as
// row 9 of the behavior ledger, decided 2026-10-05.
const OBSOLETE_THEME_FIRST = 17;
const OBSOLETE_THEME_LAST = 26;

/** True for the theme slots the app deliberately renders as the default color. */
function isObsoleteTheme(ref: ColorRef): boolean {
    return ref.kind === 'theme' && ref.index >= OBSOLETE_THEME_FIRST && ref.index <= OBSOLETE_THEME_LAST;
}

/** Resolve one of the library's symbolic color references to the app's ColorInfo. */
function toColorInfo(ref: ColorRef): ColorInfo {
    switch (ref.kind) {
    case 'default':
        return DEFAULT_COLOR;
    case 'weechat':
        return { type: 'weechat', name: ref.name };
    case 'theme':
        return isObsoleteTheme(ref) ? DEFAULT_COLOR : { type: 'option', name: ref.name };
    case 'extended':
        return { type: 'ext', name: String(ref.value) };
    }
}

/**
 * Foreground for a run. Emphasis is a marker in the library; here it becomes the
 * emphasis option color, which is how the app's CSS already renders it. Upstream
 * overlays the emphasis color on top of whatever was drawn
 * (gui-curses-chat.c:477-483), so overriding the foreground — and not the
 * background — keeps the app's existing appearance while fixing the toggle.
 */
function toFgColor(style: Style): ColorInfo {
    return style.emphasis ? EMPHASIS_COLOR : toColorInfo(style.fg);
}

/**
 * Attributes for a run.
 *
 * A theme color or emphasis carries its attributes from CSS (`coa-*` rules), so
 * only attributes an instruction decided explicitly become `a-*` / `a-no-*`
 * classes. Otherwise every attribute is stated, because a color control clears
 * the attributes it does not carry.
 */
function toAttrs(style: Style): TextAttrs {
    const themeName = isObsoleteTheme(style.fg) ? null : style.themeAttrs;
    const name = style.emphasis ? 'emphasis' : themeName;
    const cssCarriesAttributes = style.emphasis || themeName !== null;
    const override: Record<string, boolean> = {};
    for (const attribute of ATTRIBUTE_NAMES) {
        const state = style.attrs[attribute];
        if (state === 'inherited' && cssCarriesAttributes) {
            continue;
        }
        override[attributeKeys[attribute]] = state === 'enabled';
    }
    return { name, override };
}

function emptyPart(): RichPart {
    return { text: '', fgColor: { ...DEFAULT_COLOR }, bgColor: { ...DEFAULT_COLOR }, attrs: { name: null, override: {} } };
}

// --- mIRC → WeeChat conversion ---
//
// Follows WeeChat's IRC plugin, irc_color_decode()
// (src/plugins/irc/irc-color.c:206-488): attribute toggles become the control
// characters WeeChat's renderer understands, colors are mapped through WeeChat's
// IRC color table and emitted as custom-color controls that keep attributes, and
// a bare reset becomes the full reset.
//
// WeeChat's own controls are copied through untouched. No style-skipping lookahead
// is needed: a WeeChat color payload only contains digits, `@`, `F`, `B`, `*`,
// `~`, `,` and the printable attribute flags, so no mIRC control byte can appear
// inside one. The `\x01`-`\x06` bytes that do appear in WeeChat text are attribute
// characters following `\x1a`/`\x1b`, which the guard below passes through.

const IRC_BOLD_CHAR = '\x02';
const IRC_COLOR_CHAR = '\x03';
const IRC_HEX_COLOR_CHAR = '\x04';
const IRC_RESET_CHAR = '\x0f';
const IRC_REVERSE_CHAR = '\x16';
const IRC_ITALIC_CHAR = '\x1d';
const IRC_STRIKETHROUGH_CHAR = '\x1e';
const IRC_UNDERLINE_CHAR = '\x1f';

// WeeChat attribute control characters (GUI_COLOR_ATTR_*, gui-color.h).
const WEECHAT_ATTR_BOLD = '\x01';
const WEECHAT_ATTR_REVERSE = '\x02';
const WEECHAT_ATTR_ITALIC = '\x03';
const WEECHAT_ATTR_UNDERLINE = '\x04';
const WEECHAT_ATTR_DIM = '\x06';

// Attribute flag WeeChat's IRC plugin prepends so a color keeps the current attributes.
const KEEP_ATTRIBUTES_FLAG = '|';

const WEECHAT_COLOR_CHAR = '\x19';
const WEECHAT_SET_ATTR_CHAR = '\x1a';
const WEECHAT_REMOVE_ATTR_CHAR = '\x1b';
const WEECHAT_RESET_CHAR = '\x1c';

// irc_color_to_weechat[] (irc-color.c:36-65): palette names for 0-15 and 99,
// terminal color numbers for 16-98.
const IRC_COLOR_NAMES: readonly string[] = [
    'white', 'black', 'blue', 'green', 'lightred', 'red', 'magenta', 'brown',
    'yellow', 'lightgreen', 'cyan', 'lightcyan', 'lightblue', 'lightmagenta',
    'darkgray', 'gray',
    '52', '94', '100', '58', '22', '29', '23', '24',
    '17', '54', '53', '89', '88', '130', '142', '64',
    '28', '35', '30', '25', '18', '91', '90', '125',
    '124', '166', '184', '106', '34', '49', '37', '33',
    '19', '129', '127', '161', '196', '208', '226', '154',
    '46', '86', '51', '75', '21', '171', '201', '198',
    '203', '215', '227', '191', '83', '122', '87', '111',
    '63', '177', '207', '205', '217', '223', '229', '193',
    '157', '158', '159', '153', '147', '183', '219', '212',
    '16', '233', '235', '237', '239', '241', '244', '247',
    '250', '254', '231',
    'default',
];
const IRC_NUM_COLORS = IRC_COLOR_NAMES.length;

// gui_color_term256[] (gui-color.c:59-104): the RGB values WeeChat searches when
// it maps an mIRC hex color to a terminal color.
const TERM256_RGB: readonly number[] = [
    0x000000, 0x800000, 0x008000, 0x808000, 0x000080, 0x800080, 0x008080, 0xc0c0c0,
    0x808080, 0xff0000, 0x00ff00, 0xffff00, 0x0000ff, 0xff00ff, 0x00ffff, 0xffffff,
    0x000000, 0x00005f, 0x000087, 0x0000af, 0x0000d7, 0x0000ff, 0x005f00, 0x005f5f,
    0x005f87, 0x005faf, 0x005fd7, 0x005fff, 0x008700, 0x00875f, 0x008787, 0x0087af,
    0x0087d7, 0x0087ff, 0x00af00, 0x00af5f, 0x00af87, 0x00afaf, 0x00afd7, 0x00afff,
    0x00d700, 0x00d75f, 0x00d787, 0x00d7af, 0x00d7d7, 0x00d7ff, 0x00ff00, 0x00ff5f,
    0x00ff87, 0x00ffaf, 0x00ffd7, 0x00ffff, 0x5f0000, 0x5f005f, 0x5f0087, 0x5f00af,
    0x5f00d7, 0x5f00ff, 0x5f5f00, 0x5f5f5f, 0x5f5f87, 0x5f5faf, 0x5f5fd7, 0x5f5fff,
    0x5f8700, 0x5f875f, 0x5f8787, 0x5f87af, 0x5f87d7, 0x5f87ff, 0x5faf00, 0x5faf5f,
    0x5faf87, 0x5fafaf, 0x5fafd7, 0x5fafff, 0x5fd700, 0x5fd75f, 0x5fd787, 0x5fd7af,
    0x5fd7d7, 0x5fd7ff, 0x5fff00, 0x5fff5f, 0x5fff87, 0x5fffaf, 0x5fffd7, 0x5fffff,
    0x870000, 0x87005f, 0x870087, 0x8700af, 0x8700d7, 0x8700ff, 0x875f00, 0x875f5f,
    0x875f87, 0x875faf, 0x875fd7, 0x875fff, 0x878700, 0x87875f, 0x878787, 0x8787af,
    0x8787d7, 0x8787ff, 0x87af00, 0x87af5f, 0x87af87, 0x87afaf, 0x87afd7, 0x87afff,
    0x87d700, 0x87d75f, 0x87d787, 0x87d7af, 0x87d7d7, 0x87d7ff, 0x87ff00, 0x87ff5f,
    0x87ff87, 0x87ffaf, 0x87ffd7, 0x87ffff, 0xaf0000, 0xaf005f, 0xaf0087, 0xaf00af,
    0xaf00d7, 0xaf00ff, 0xaf5f00, 0xaf5f5f, 0xaf5f87, 0xaf5faf, 0xaf5fd7, 0xaf5fff,
    0xaf8700, 0xaf875f, 0xaf8787, 0xaf87af, 0xaf87d7, 0xaf87ff, 0xafaf00, 0xafaf5f,
    0xafaf87, 0xafafaf, 0xafafd7, 0xafafff, 0xafd700, 0xafd75f, 0xafd787, 0xafd7af,
    0xafd7d7, 0xafd7ff, 0xafff00, 0xafff5f, 0xafff87, 0xafffaf, 0xafffd7, 0xafffff,
    0xd70000, 0xd7005f, 0xd70087, 0xd700af, 0xd700d7, 0xd700ff, 0xd75f00, 0xd75f5f,
    0xd75f87, 0xd75faf, 0xd75fd7, 0xd75fff, 0xd78700, 0xd7875f, 0xd78787, 0xd787af,
    0xd787d7, 0xd787ff, 0xd7af00, 0xd7af5f, 0xd7afaf, 0xd7afd7, 0xd7afff, 0xd7d700,
    0xd7d75f, 0xd7d787, 0xd7d7af, 0xd7d7d7, 0xd7d7ff, 0xd7ff00, 0xd7ff5f, 0xd7ff87,
    0xd7ffaf, 0xd7ffd7, 0xd7ffff, 0xff0000, 0xff005f, 0xff0087, 0xff00af, 0xff00d7,
    0xff00ff, 0xff5f00, 0xff5f5f, 0xff5f87, 0xff5faf, 0xff5fd7, 0xff5fff, 0xff8700,
    0xff875f, 0xff8787, 0xff87af, 0xff87d7, 0xff87ff, 0xffaf00, 0xffaf5f, 0xffaf87,
    0xffafaf, 0xffafd7, 0xffafff, 0xffd700, 0xffd75f, 0xffd787, 0xffd7af, 0xffd7d7,
    0xffd7ff, 0xffff00, 0xffff5f, 0xffff87, 0xffffaf, 0xffffd7, 0xffffff,
    0x080808, 0x121212, 0x1c1c1c, 0x262626, 0x303030, 0x3a3a3a, 0x444444, 0x4e4e4e,
    0x585858, 0x626262, 0x6c6c6c, 0x767676, 0x808080, 0x8a8a8a, 0x949494, 0x9e9e9e,
    0xa8a8a8, 0xb2b2b2, 0xbcbcbc, 0xc6c6c6, 0xd0d0d0, 0xdadada, 0xe4e4e4, 0xeeeeee,
];

/**
 * Nearest terminal color for an RGB value, matching gui_color_convert_rgb_to_term
 * (gui-color.c:563-597): squared RGB distance over the 256-entry table, first
 * exact match wins.
 */
function rgbToTerminalColor(rgb: number): number {
    const r1 = (rgb >> 16) & 0xff;
    const g1 = (rgb >> 8) & 0xff;
    const b1 = rgb & 0xff;
    let bestDiff = Number.POSITIVE_INFINITY;
    let bestColor = 0;
    for (let i = 0; i < TERM256_RGB.length; i++) {
        const rgb2 = TERM256_RGB[i]!;
        const dr = ((rgb2 >> 16) & 0xff) - r1;
        const dg = ((rgb2 >> 8) & 0xff) - g1;
        const db = (rgb2 & 0xff) - b1;
        const diff = dr * dr + dg * dg + db * db;
        if (diff === 0) {
            return i;
        }
        if (diff < bestDiff) {
            bestDiff = diff;
            bestColor = i;
        }
    }
    return bestColor;
}

/**
 * Render one color name as a WeeChat color payload: named palette colors become a
 * two-digit index, numeric terminal colors an `@NNNNN` extended index. Attribute
 * flags go between the `@` and the digits, exactly as gui_color_get_custom()
 * builds them (gui-color.c:472-496).
 */
function colorPayload(name: string, attributes: string): string | null {
    const index = colorNameToIndex.get(name);
    if (index !== undefined) {
        return attributes + String(index).padStart(2, '0');
    }
    if (/^\d+$/.test(name)) {
        const value = Math.min(Number(name), MAX_EXTENDED_COLOR);
        return '@' + attributes + String(value).padStart(5, '0');
    }
    return null;
}

/**
 * Build the control WeeChat emits for a custom "fg,bg" color name
 * (gui_color_get_custom, gui-color.c:498-527). The keep-attributes flag is how
 * the IRC plugin passes colors through (irc-color.c:353-366); background
 * payloads carry no attribute flags.
 */
function customColorControl(fg: string | null, bg: string | null): string {
    const fgPayload = fg === null ? null : colorPayload(fg, KEEP_ATTRIBUTES_FLAG);
    const bgPayload = bg === null ? null : colorPayload(bg, '');
    if (fgPayload === null && bgPayload === null) {
        return WEECHAT_COLOR_CHAR + WEECHAT_RESET_CHAR; // weechat_color("resetcolor")
    }
    if (fgPayload !== null && bgPayload !== null) {
        return WEECHAT_COLOR_CHAR + '*' + fgPayload + '~' + bgPayload;
    }
    if (fgPayload !== null) {
        return WEECHAT_COLOR_CHAR + 'F' + fgPayload;
    }
    return WEECHAT_COLOR_CHAR + 'B' + bgPayload;
}

/** Read up to `max` decimal digits from `text` starting at `start`. */
function readDigits(text: string, start: number, max: number): { value: string; next: number } {
    let value = '';
    let i = start;
    while (i < text.length && value.length < max && text[i]! >= '0' && text[i]! <= '9') {
        value += text[i];
        i++;
    }
    return { value, next: i };
}

/** Read up to `max` hexadecimal digits from `text` starting at `start`. */
function readHexDigits(text: string, start: number, max: number): { value: string; next: number } {
    let value = '';
    let i = start;
    while (i < text.length && value.length < max && /[0-9a-fA-F]/.test(text[i]!)) {
        value += text[i];
        i++;
    }
    return { value, next: i };
}

/** Map an mIRC color index through irc_color_to_weechat[], wrapping at 100 like irc_color_decode. */
function ircColorName(digits: string): string | null {
    if (digits === '') {
        return null;
    }
    let index = Number(digits);
    if (!Number.isFinite(index)) {
        return null;
    }
    index %= IRC_NUM_COLORS;
    return IRC_COLOR_NAMES[index] ?? null;
}

// mIRC control bytes; a line without any of them is already WeeChat text.
// eslint-disable-next-line no-control-regex -- the mIRC controls *are* control characters
const IRC_CONTROL_CHARS = /[\x02\x03\x04\x0f\x16\x1d\x1e\x1f]/;

/**
 * Convert mIRC formatting into WeeChat controls.
 *
 * Attribute bytes toggle, so the conversion tracks them exactly as
 * irc_color_decode() does and emits the matching set/remove control pairs.
 */
export function convertIrcCodes(text: string): string {
    // Fast path: relayed chat usually carries WeeChat controls, and every byte
    // outside the table above is copied through unchanged.
    if (!IRC_CONTROL_CHARS.test(text)) {
        return text;
    }

    let result = '';
    let bold = false;
    let reverse = false;
    let italic = false;
    let strikethrough = false;
    let underline = false;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i]!;
        const prevChar = i > 0 ? text[i - 1] : '';
        // \x01-\x06 after \x1a/\x1b are WeeChat attribute characters, not mIRC bytes.
        const isWeechatAttr = prevChar === WEECHAT_SET_ATTR_CHAR || prevChar === WEECHAT_REMOVE_ATTR_CHAR;

        switch (ch) {
        case IRC_BOLD_CHAR:
            result += isWeechatAttr ? ch : (bold ? `${WEECHAT_REMOVE_ATTR_CHAR}${WEECHAT_ATTR_BOLD}` : `${WEECHAT_SET_ATTR_CHAR}${WEECHAT_ATTR_BOLD}`);
            bold = !bold;
            break;
        case IRC_REVERSE_CHAR:
            result += isWeechatAttr ? ch : (reverse ? `${WEECHAT_REMOVE_ATTR_CHAR}${WEECHAT_ATTR_REVERSE}` : `${WEECHAT_SET_ATTR_CHAR}${WEECHAT_ATTR_REVERSE}`);
            reverse = !reverse;
            break;
        case IRC_ITALIC_CHAR:
            result += isWeechatAttr ? ch : (italic ? `${WEECHAT_REMOVE_ATTR_CHAR}${WEECHAT_ATTR_ITALIC}` : `${WEECHAT_SET_ATTR_CHAR}${WEECHAT_ATTR_ITALIC}`);
            italic = !italic;
            break;
        case IRC_UNDERLINE_CHAR:
            result += isWeechatAttr ? ch : (underline ? `${WEECHAT_REMOVE_ATTR_CHAR}${WEECHAT_ATTR_UNDERLINE}` : `${WEECHAT_SET_ATTR_CHAR}${WEECHAT_ATTR_UNDERLINE}`);
            underline = !underline;
            break;
        case IRC_STRIKETHROUGH_CHAR:
            // WeeChat has no strikethrough; the IRC plugin maps it to dim.
            result += isWeechatAttr ? ch : (strikethrough ? `${WEECHAT_REMOVE_ATTR_CHAR}${WEECHAT_ATTR_DIM}` : `${WEECHAT_SET_ATTR_CHAR}${WEECHAT_ATTR_DIM}`);
            strikethrough = !strikethrough;
            break;
        case IRC_RESET_CHAR:
            result += isWeechatAttr ? ch : WEECHAT_RESET_CHAR;
            bold = false;
            reverse = false;
            italic = false;
            strikethrough = false;
            underline = false;
            break;
        case IRC_COLOR_CHAR: {
            if (isWeechatAttr) {
                result += ch;
                break;
            }
            const fg = readDigits(text, i + 1, 2);
            let bg = { value: '', next: fg.next };
            if (text[fg.next] === ',' && (text[fg.next + 1] ?? '') >= '0' && (text[fg.next + 1] ?? '') <= '9') {
                bg = readDigits(text, fg.next + 1, 2);
            }
            result += customColorControl(ircColorName(fg.value), ircColorName(bg.value));
            i = bg.next - 1;
            break;
        }
        case IRC_HEX_COLOR_CHAR: {
            if (isWeechatAttr) {
                result += ch;
                break;
            }
            const fg = readHexDigits(text, i + 1, 6);
            let bg = { value: '', next: fg.next };
            if (text[fg.next] === ',' && /[0-9a-fA-F]/.test(text[fg.next + 1] ?? '')) {
                bg = readHexDigits(text, fg.next + 1, 6);
            }
            result += customColorControl(hexColorName(fg.value), hexColorName(bg.value));
            i = bg.next - 1;
            break;
        }
        default:
            result += ch;
        }
    }

    return result;
}

/** Name an mIRC hex color by its nearest terminal color, as irc_color_decode() does. */
function hexColorName(digits: string): string | null {
    if (digits === '') {
        return null;
    }
    return String(rgbToTerminalColor(parseInt(digits, 16)));
}

// --- Public parsing ---

/** Parse a line of WeeChat chat text into styled runs. */
export function rawText2Rich(rawText: string): RichPart[] {
    if (!rawText) {
        return [emptyPart()];
    }

    const runs = parseWeeChatText(convertIrcCodes(rawText));
    if (runs.length === 0) {
        return [];
    }

    const result: RichPart[] = new Array(runs.length);
    for (let i = 0; i < runs.length; i++) {
        const run = runs[i]!;
        result[i] = {
            text: run.text,
            fgColor: toFgColor(run.style),
            bgColor: toColorInfo(run.style.bg),
            attrs: toAttrs(run.style),
        };
    }
    return result;
}

/**
 * Diagnostic rendering of parsed parts as `%NN`/`^option` style text.
 *
 * This is a debug view for the parity tests, not a WeeChat serializer: nothing
 * here is sent back to the relay.
 */
export function richText2Str(parts: RichPart[]): string {
    const segments = new Array<string>(parts.length);
    for (let i = 0; i < parts.length; i++) {
        const part = parts[i]!;
        let str = '';

        // Foreground color — switch is faster than if/else chain
        switch (part.fgColor.type) {
        case 'weechat': {
            const idx = colorNameToIndex.get(part.fgColor.name);
            if (idx !== undefined) str += '%' + idx.toString().padStart(2, '0');
            break;
        }
        case 'ext': str += '%' + part.fgColor.name; break;
        case 'option': str += '^' + part.fgColor.name; break;
        }

        // Background color
        switch (part.bgColor.type) {
        case 'weechat': {
            const idx = colorNameToIndex.get(part.bgColor.name);
            if (idx !== undefined) str += ',' + idx.toString().padStart(2, '0');
            break;
        }
        case 'ext': str += ',' + part.bgColor.name; break;
        case 'option': str += ',' + part.bgColor.name; break;
        }

        // Attributes
        if (part.attrs.name) {
            str += '/' + part.attrs.name;
        }
        for (const attr in part.attrs.override) {
            if (part.attrs.override[attr]) {
                const char = attrValueToChar[attr];
                if (char) str += '/' + char;
            }
        }

        segments[i] = str + ':' + part.text;
    }
    return segments.join('');
}

/// Color class for a parsed ColorInfo in the nick/line CSS vocabulary
/// (cwf-/cef-/cof- foreground, cwb-/ceb-/cob- background).
function nickColorClass(color: ColorInfo, isFg: boolean): string {
    switch (color.type) {
    case 'option': return (isFg ? 'cof-' : 'cob-') + color.name;
    case 'weechat': return (isFg ? 'cwf-' : 'cwb-') + color.name;
    case 'ext': return (isFg ? 'cef-' : 'ceb-') + color.name;
    }
}

/**
 * Parse a WeeChat internal color string — the `colors=weechat` encoding of the
 * nick `color`/`prefix_color` fields, e.g. "\x19F06", "\x19*03,05", "\x19F|04" —
 * into the CSS class vocabulary line parts use. Attribute flags inside the
 * payload become `a-*` classes. Returns null when the string is not a parseable
 * internal code so callers can fall back to name-based mapping.
 */
export function parseWeechatNickColor(code: string): string[] | null {
    if (!code || !code.includes(WEECHAT_COLOR_CHAR)) {
        return null;
    }

    const parsed = parseWeeChatStyle(code);
    if (!parsed.ok) {
        return null;
    }

    const classes: string[] = [];
    classes.push(nickColorClass(toFgColor(parsed.style), true));
    classes.push(nickColorClass(toColorInfo(parsed.style.bg), false));
    const attrs = toAttrs(parsed.style);
    for (const attr in attrs.override) {
        if (attrs.override[attr]) {
            classes.push('a-' + attr);
        }
    }
    return classes.length > 0 ? classes : null;
}
