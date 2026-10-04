// Standalone WeeChat color/format parser — no protocol or transport code.
// Extracted from weechat.ts during the relay API migration (phase 3) so the
// formatting engine survives the legacy protocol retirement.

import type { ColorInfo, TextAttrs, RichTextPart } from '#lib/types.ts';

type RichPart = RichTextPart;
export type { RichPart };

// --- Static color/attribute parsing ---

const weeChatColorsNames = [
    'default', 'black', 'darkgray', 'red', 'lightred', 'green', 'lightgreen',
    'brown', 'yellow', 'blue', 'lightblue', 'magenta', 'lightmagenta',
    'cyan', 'lightcyan', 'gray', 'white'
];

// Reverse lookup: color name -> index (avoids O(n) indexOf in richText2Str loop)
const colorNameToIndex = new Map(weeChatColorsNames.map((name, i) => [name, i]));

// Style options names — STD color codes map to these option names for theme-defined rendering
const colorsOptionsNames = [
    'separator',
    'chat',
    'chat_time',
    'chat_time_delimiters',
    'chat_prefix_error',
    'chat_prefix_network',
    'chat_prefix_action',
    'chat_prefix_join',
    'chat_prefix_quit',
    'chat_prefix_more',
    'chat_prefix_suffix',
    'chat_buffer',
    'chat_server',
    'chat_channel',
    'chat_nick',
    'chat_nick_self',
    'chat_nick_other',
    'invalid',
    'invalid',
    'invalid',
    'invalid',
    'invalid',
    'invalid',
    'invalid',
    'invalid',
    'invalid',
    'invalid',
    'chat_host',
    'chat_delimiters',
    'chat_highlight',
    'chat_read_marker',
    'chat_text_found',
    'chat_value',
    'chat_prefix_buffer',
    'chat_tags',
    'chat_inactive_window',
    'chat_inactive_buffer',
    'chat_prefix_buffer_inactive_buffer',
    'chat_nick_offline',
    'chat_nick_offline_highlight',
    'chat_nick_prefix',
    'chat_nick_suffix',
    'emphasis',
    'chat_day_change',
    'chat_value_null',
    'chat_status_disabled',
    'chat_status_enabled'
];

const attrNameChars: Record<string, string> = {
    '*': 'b', '!': 'r', '/': 'i', '_': 'u', '%': 'k', '.': 'd',
    '\x01': 'b', '\x02': 'r', '\x03': 'i', '\x04': 'u', '\x05': 'k', '\x06': 'd'
};

// Reverse lookup: attribute key -> char (avoids Object.entries().find in richText2Str loop)
const attrValueToChar: Record<string, string> = {
    'b': '*', 'r': '!', 'i': '/', 'u': '_', 'k': '%', 'd': '.'
};

function getDefaultColor(): ColorInfo {
    return { type: 'weechat', name: 'default' };
}

function getDefaultAttributes(): TextAttrs {
    return { name: null, override: { b: false, r: false, i: false, u: false, k: false, d: false } };
}

function getColorObj(str: string): ColorInfo {
    if (str.length === 2) {
        const code = parseInt(str, 10);
        if (code > 16) {
            return getDefaultColor();
        }
        return { type: 'weechat', name: weeChatColorsNames[code]! };
    }
    // Extended color code: strip leading @ and convert to numeric string
    const codeStr = str.startsWith('@') ? str.substring(1) : str;
    return { type: 'ext', name: parseInt(codeStr, 10).toString() };
}

interface StyleResult {
    fgColor: ColorInfo | null;
    bgColor: ColorInfo | null;
    attrs: TextAttrs | null;
    text: string;
}

type StyleMatcherFn = (txt: string, m: RegExpMatchArray) => StyleResult;

// Pre-built style matchers to avoid per-call array allocation in getStyle().
const styleMatchers: Array<{ regex: RegExp; fn: StyleMatcherFn }> = [
    // STD color codes: 2 digits → option colors (bare STD codes set both fg and bg)
    // Old JS treats all bare STD codes as option type with bgColor = fgColor.
    // Codes > 46 are out of range, return default color.
    {
        regex: /^(\d{2})/,
        fn: (txt, m) => {
            const code = parseInt(m[1]!, 10);
            if (code > 46) {
                return { fgColor: getDefaultColor(), bgColor: null, attrs: null, text: txt.substring(m[0].length) };
            }
            const optionName = colorsOptionsNames[code];
            if (!optionName || optionName === 'invalid') {
                return { fgColor: getDefaultColor(), bgColor: null, attrs: null, text: txt.substring(m[0].length) };
            }
            const fgColor: ColorInfo = { type: 'option' as const, name: optionName };
            return {
                fgColor,
                bgColor: { ...fgColor },
                attrs: { name: optionName, override: {} },
                text: txt.substring(m[0].length)
            };
        }
    },
    // Extended color codes: bare @NNNNN is unimplemented in old JS (returns null)
    // F/B prefixed EXT colors are handled by their respective matchers below
    {
        regex: /^@\d{5}/,
        fn: (txt, m) => ({
            fgColor: null, bgColor: null, attrs: null,
            text: txt.substring(m[0].length)
        })
    },
    // Foreground color: F + optional attributes + STD or EXT
    {
        // eslint-disable-next-line no-control-regex
        regex: /^F(?:([*!_/.%|]*)(\d{2})|@([\x01-\x06*!_/.%|]*)(\d{5}))/,
        fn: (txt, m) => {
            if (m[2]) {
                return { fgColor: getColorObj(m[2]), bgColor: null, attrs: attrsFromStr(m[1] ?? ''), text: txt.substring(m[0].length) };
            }
            return { fgColor: getColorObj('@' + m[4]), bgColor: null, attrs: attrsFromStr(m[3] ?? ''), text: txt.substring(m[0].length) };
        }
    },
    // Background color: B + STD or EXT
    {
        regex: /^B(\d{2}|@\d{5})/,
        fn: (txt, m) => ({
            fgColor: null, bgColor: getColorObj(m[1]!), attrs: null,
            text: txt.substring(m[0].length)
        })
    },
    // Foreground + background with optional attributes (WeeChat 2.6+ uses ~ or ,)
    // Leading * is the FG+BG marker, not bold - old JS doesn't add bold from it
    {
        // eslint-disable-next-line no-control-regex
        regex: /^\*(?:([\x01-\x06*!_/.%|]*)(\d{2})|@([\x01-\x06*!_/.%|]*)(\d{5}))[,~](\d{2}|@\d{5})/,
        fn: (txt, m) => {
            let fgColor: ColorInfo;
            let attrs: TextAttrs | null;
            if (m[2]) {
                attrs = attrsFromStr(m[1] ?? '');
                fgColor = getColorObj(m[2]);
            } else {
                attrs = attrsFromStr(m[3] ?? '');
                fgColor = getColorObj('@' + m[4]);
            }
            return { fgColor, bgColor: getColorObj(m[5]!), attrs, text: txt.substring(m[0].length) };
        }
    },
    // Foreground color with * prefix (+ attributes)
    // Leading * is just the pattern marker, not bold - old JS doesn't add bold from it
    {
        // eslint-disable-next-line no-control-regex
        regex: /^\*([\x01-\x06*!_/.%|]*)(\d{2}|@\d{5})/,
        fn: (txt, m) => ({
            fgColor: getColorObj(m[2]!), bgColor: null,
            attrs: attrsFromStr(m[1] ?? ''),
            text: txt.substring(m[0].length)
        })
    },
    // Foreground color with % prefix (+ attributes) - includes blink
    {
        // eslint-disable-next-line no-control-regex
        regex: /^%([\x01-\x06*!_/.%|]*)(\d{2}|@\d{5})/,
        fn: (txt, m) => ({
            fgColor: getColorObj(m[2]!), bgColor: null,
            attrs: attrsFromStr('%' + (m[1] ?? '')),
            text: txt.substring(m[0].length)
        })
    },
    // Foreground color with . prefix (+ attributes) - includes dim
    {
        // eslint-disable-next-line no-control-regex
        regex: /^\.([\x01-\x06*!_/.%|]*)(\d{2}|@\d{5})/,
        fn: (txt, m) => ({
            fgColor: getColorObj(m[2]!), bgColor: null,
            attrs: attrsFromStr('.' + (m[1] ?? '')),
            text: txt.substring(m[0].length)
        })
    },
    // Emphasis
    {
        regex: /^E/,
        fn: (txt) => ({
            fgColor: { type: 'option', name: 'emphasis' },
            bgColor: null,
            attrs: { name: 'emphasis', override: {} },
            text: txt.substring(1)
        })
    }
];

// First-character dispatch map — reduces regex checks from up to 9 down to 1-2 per style block.
const matchersByFirstChar: Record<string, Array<{ regex: RegExp; fn: StyleMatcherFn }>> = {
    '0': [styleMatchers[0]!], '1': [styleMatchers[0]!], '2': [styleMatchers[0]!],
    '3': [styleMatchers[0]!], '4': [styleMatchers[0]!], '5': [styleMatchers[0]!],
    '6': [styleMatchers[0]!], '7': [styleMatchers[0]!], '8': [styleMatchers[0]!],
    '9': [styleMatchers[0]!], '@': [styleMatchers[1]!], 'F': [styleMatchers[2]!],
    'B': [styleMatchers[3]!], '*': [styleMatchers[4]!, styleMatchers[5]!],
    '%': [styleMatchers[6]!], '.': [styleMatchers[7]!], 'E': [styleMatchers[8]!]
};

function getStyle(txt: string): StyleResult {
    if (txt.length > 0) {
        const first = txt[0]!;
        const matchers = matchersByFirstChar[first];
        if (matchers) {
            for (let i = 0; i < matchers.length; i++) {
                const matcher = matchers[i]!;
                const m = txt.match(matcher.regex);
                if (m) {
                    return matcher.fn(txt, m);
                }
            }
        }
    }
    return { fgColor: null, bgColor: null, attrs: null, text: txt };
}

function attrsFromStr(str: string): TextAttrs | null {
    // Matches old JS behavior: '|' anywhere means "keep attributes" (null);
    // an empty string returns a reset (all-false) attributes object.
    const attrs: TextAttrs = { name: null, override: { b: false, r: false, i: false, u: false, k: false, d: false } };
    for (const ch of str) {
        if (ch === '|') {
            return null;
        }
        if (ch in attrNameChars) {
            attrs.override[attrNameChars[ch]!] = true;
        }
    }
    return attrs;
}

export function convertIrcCodes(text: string): string {
    // Single-pass conversion avoids V8 .replace() bug where multi-char
    // replacement strings ending with a digit matching the next source char
    // cause that character to be duplicated.
    // Pre-compiled regex matches any valid WeeChat style sequence so we can
    // skip entire style blocks in one step instead of tracking state manually.
    // When preceded by \x1a or \x1b, raw bytes are WeeChat attribute chars.
    // eslint-disable-next-line no-control-regex
    const weechatStyleRegex = /^(?:(?:\d{2})|@\d{5}|F(?:[*!_/.%|]*\d{2}|@[\x01-\x06*!_/.%|]*\d{5})|B(?:\d{2}|@\d{5})|\*(?:[\x01-\x06*!_/.%|]*\d{2}|@[\x01-\x06*!_/.%|]*\d{5})[,~](?:\d{2}|@\d{5})|\*(?:[\x01-\x06*!_/.%|]*)(?:\d{2}|@\d{5})|%(?:[\x01-\x06*!_/.%|]*)(?:\d{2}|@\d{5})|\.(?:[\x01-\x06*!_/.%|]*)(?:\d{2}|@\d{5})|E)/;

    let result = '';
    for (let i = 0; i < text.length; i++) {
        const ch = text[i]!;
        const prevChar = i > 0 ? text[i - 1] : '';
        const isWeechatAttr = prevChar === '\x1a' || prevChar === '\x1b';
        switch (ch) {
        case '\x19': {
            // Start of a WeeChat style code — consume entire block via regex
            result += ch;
            const remaining = text.substring(i + 1);
            const match = remaining.match(weechatStyleRegex);
            if (match) {
                result += match[0];
                i += match[0].length;
            }
            break;
        }
        case '\x1a': case '\x1b': case '\x1c':
            // WeeChat control codes — pass through unchanged
            result += ch;
            break;
        case '\x02':
            result += isWeechatAttr ? ch : '\x1a*';
            break;   // mIRC bold → WeeChat *
        case '\x1d':
            result += isWeechatAttr ? ch : '\x1a/';
            break;   // mIRC italic → WeeChat /
        case '\x1f':
            result += isWeechatAttr ? ch : '\x1a_';
            break;   // mIRC underline → WeeChat _
        case '\x16':
            result += isWeechatAttr ? ch : '\x1a!';
            break;   // mIRC reverse → WeeChat !
        case '\x0f':
            result += isWeechatAttr ? ch : '\x1c';
            break;   // mIRC reset → WeeChat \x1c
        case '\x03': {
            if (isWeechatAttr) {
                result += ch;
                break;
            }
            let j = i + 1;
            // Parse fg color digits
            let fg = '';
            while (j < text.length && text[j]! >= '0' && text[j]! <= '9') {
                fg += text[j]!;
                j++;
            }
            if (fg.length === 0) {
                result += '\x1c';
            } else {
                // Pad single-digit fg to 2 digits for downstream style matchers
                if (fg.length === 1) {
                    fg = '0' + fg;
                }
                // Check for optional ,NN (bg color)
                let bg = '';
                if (j < text.length && text[j]! === ',') {
                    j++;
                    while (j < text.length && text[j]! >= '0' && text[j]! <= '9') {
                        bg += text[j]!;
                        j++;
                    }
                    // Pad single-digit bg to 2 digits
                    if (bg.length === 1) {
                        bg = '0' + bg;
                    }
                    // mIRC codes 0-16 map to option indices, not WeeChat palette.
                    // \x19*fg,bg routes through getColorObj → weechat names.
                    // For codes ≤ 16, emit separate bare codes so pattern 0
                    // handles them with option names instead.
                    if (parseInt(fg, 10) <= 16) {
                        result += '\x19' + fg + '\x19B' + bg;
                    } else {
                        result += '\x19*' + fg + ',' + bg;
                    }
                } else {
                    result += '\x19' + fg;
                }
            }
            i = j - 1;
            break;
        }
        case '\x01': case '\x04': case '\x05': case '\x06':
            // mIRC-style attribute bytes — preserve as-is
            result += ch;
            break;
        default:
            result += ch;
        }
    }
    return result;
}

export function rawText2Rich(rawText: string): RichPart[] {
    if (!rawText) {
        return [{ text: '', fgColor: getDefaultColor(), bgColor: getDefaultColor(), attrs: getDefaultAttributes() }];
    }

    const cleaned = convertIrcCodes(rawText);
    // eslint-disable-next-line no-control-regex -- WeeChat rich format delimiters
    const parts = cleaned.split(/(\x19|\x1a|\x1b|\x1c)/);

    if (parts.length === 1) {
        return [{
            fgColor: getDefaultColor(),
            bgColor: getDefaultColor(),
            attrs: getDefaultAttributes(),
            text: parts[0]!
        }];
    }

    let curFgColor = getDefaultColor();
    let curBgColor = getDefaultColor();
    let curAttrs = getDefaultAttributes();
    let curSpecialToken: number | null = null;

    const result: RichPart[] = [];

    for (const p of parts) {
        if (p.length === 0) {
            continue;
        }

        const firstCharCode = p.charCodeAt(0);
        const firstChar = p.charAt(0);

        if (firstCharCode >= 0x19 && firstCharCode <= 0x1c) {
            // Special control token
            if (firstCharCode === 0x1c) {
                // Always reset colors
                curFgColor = getDefaultColor();
                curBgColor = getDefaultColor();
                if (curSpecialToken !== 0x19) {
                    // Also reset attributes
                    curAttrs = getDefaultAttributes();
                }
            }
            curSpecialToken = firstCharCode;
            continue;
        }

        let text = p;
        if (curSpecialToken === 0x19) {
            // Get new style from _getStyle
            const style = getStyle(p);
            if (style.fgColor !== null) {
                curFgColor = style.fgColor;
            }
            if (style.bgColor !== null) {
                curBgColor = style.bgColor;
            }
            if (style.attrs !== null) {
                // Old JS replaces curAttrs with style.attrs unconditionally (\x19 resets attrs)
                curAttrs = style.attrs;
            }
            text = style.text;
        } else if (curSpecialToken === 0x1a || curSpecialToken === 0x1b) {
            // Set/reset attribute
            const orideVal = curSpecialToken === 0x1a;
            if (firstChar !== '|') {
                const orideName = attrNameChars[firstChar];
                if (orideName) {
                    curAttrs.override[orideName] = orideVal;
                    text = p.substring(1);
                }
            }
        }

        curSpecialToken = null;

        if (text.length === 0) {
            continue;
        }

        result.push({
            fgColor: { ...curFgColor },
            bgColor: { ...curBgColor },
            attrs: { name: curAttrs.name, override: { ...curAttrs.override } },
            text
        });
    }

    return result;
}

export function richText2Str(parts: RichPart[]): string {
    // Pre-sized array avoids .map() intermediate allocation.
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
