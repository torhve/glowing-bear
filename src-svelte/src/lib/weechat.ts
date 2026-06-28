import type { ColorInfo, TextAttrs, RichTextPart } from '$lib/types';

// --- Type definitions ---

type RichPart = RichTextPart;
export type { RichPart };

interface FormatHandshakeOpts {
    password_hash_algo?: string;
    compression?: string;
}

interface FormatHdataOpts {
    id?: number | null;
    path: string;
    keys?: string[];
}

interface FormatInputOpts {
    id?: number | null;
    buffer: string;
    data: string;
}

interface FormatNicklistOpts {
    id?: number | null;
    buffer: string;
}

interface FormatLocalvarSetOpts {
    buffer: string;
    name: string;
    value: string;
}

interface FormatInfolistOpts {
    id?: number | null;
    name: string;
    pointer?: number | null;
    args?: string | null;
}

interface FormatInfoOpts {
    id?: number | null;
    name: string;
}

export interface ParsedObject {
    type: string;
    content: unknown;
}

export interface ParsedMessage {
    header: { length: number; compression: number };
    id: string;
    objects: ParsedObject[];
}

// --- Decompression ---

import { Unzlib } from 'fflate';
const utf8Decoder = new TextDecoder('utf-8');

async function decompressZlib(raw: Uint8Array): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
        const chunks: Uint8Array[] = [];
        let totalLength = 0;
        try {
            const inflator = new Unzlib((data, final) => {
                chunks.push(data);
                totalLength += data.length;
                if (final) {
                    const result = new Uint8Array(totalLength);
                    let offset = 0;
                    for (let i = 0; i < chunks.length; i++) {
                        result.set(chunks[i]!, offset);
                        offset += chunks[i]!.length;
                    }
                    resolve(result);
                }
            });
            inflator.push(raw, true);
        } catch (err) {
            reject(err);
        }
    });
}

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

// --- String utilities ---

function uia2s(data: Uint8Array): string {
    const nullIdx = data.indexOf(0x00);
    const slice = nullIdx >= 0 ? data.subarray(0, nullIdx) : data;
    return utf8Decoder.decode(slice);
}

// --- Static format methods ---

// Format command with optional ID prefix, space-separated args, trailing newline.
// Matches WeeChat relay protocol: "(id) name arg1 arg2\n"
function _formatCmd(id: number | null, name: string, parts: string[]): string {
    const cmdIdName = id !== null ? '(' + id + ') ' : '';
    parts.unshift(cmdIdName + name);
    return parts.join(' ') + '\n';
}

// Format dict entries as comma-separated key=value pairs (per relay protocol spec).
function _formatDict(dict: Record<string, unknown>): string {
    const entries = Object.entries(dict);
    if (entries.length === 0) {
        return '';
    }
    return entries.map(([key, value]) =>
        key + '=' + (typeof value === 'string' ? value : JSON.stringify(value))
    ).join(',');
}

export function formatHandshake(opts: FormatHandshakeOpts): string {
    const defaults: FormatHandshakeOpts = {
        password_hash_algo: 'pbkdf2+sha512',
        compression: 'zlib'
    };
    const merged = { ...defaults, ...opts };
    // Build key=value pairs in the same order as the old JS parser:
    // compression first, then password_hash_algo.
    const keys: string[] = [];
    const compression = merged.compression ?? defaults.compression;
    if (compression !== null) {
        keys.push('compression=' + compression);
    }
    const algo = merged.password_hash_algo ?? defaults.password_hash_algo;
    if (algo !== null) {
        keys.push('password_hash_algo=' + algo);
    }
    const dictStr = keys.join(',');
    const parts = dictStr ? [dictStr] : [];
    return _formatCmd(null, 'handshake', parts);
}

// Format init command: "init totp=...,password_hash=...\n"
// Signature matches original JS: (password_hash, totp)
// Parameter order matches old JS parser: totp first, then password_hash.
export function formatInit(passwordHash: string | null, totp: string | null): string {
    const parts = [];
    const keys: string[] = [];
    if (totp !== null) {
        keys.push('totp=' + totp);
    }
    if (passwordHash !== null) {
        keys.push('password_hash=' + passwordHash);
    }
    if (keys.length > 0) {
        parts.push(keys.join(','));
    } else {
        // Old JS: "init \n" with trailing space when no params
        parts.push('');
    }
    return _formatCmd(null, 'init', parts);
}

export function formatHdata(opts: FormatHdataOpts): string {
    const parts = [opts.path];
    if (opts.keys && opts.keys.length > 0) {
        parts.push(opts.keys.join(','));
    }
    return _formatCmd(opts.id ?? null, 'hdata', parts);
}

export function formatInfo(opts: FormatInfoOpts): string {
    return _formatCmd(opts.id ?? null, 'info', [opts.name]);
}

export function formatSync(dict: Record<string, unknown>): string {
    const dictStr = _formatDict(dict);
    const parts = dictStr ? [dictStr] : [];
    return _formatCmd(null, 'sync', parts);
}

export function formatInput(opts: FormatInputOpts): string {
    return _formatCmd(opts.id ?? null, 'input', [opts.buffer, opts.data]);
}

export function formatNicklist(opts: FormatNicklistOpts): string {
    return _formatCmd(opts.id ?? null, 'nicklist', [opts.buffer]);
}

export function formatInfolist(opts: FormatInfolistOpts): string {
    const parts = [opts.name];
    if (opts.pointer !== null && opts.pointer !== undefined) {
        parts.push(String(opts.pointer));
    }
    if (opts.args) {
        parts.push(opts.args);
    }
    return _formatCmd(opts.id ?? null, 'infolist', parts);
}

export function formatLocalvarSet(opts: FormatLocalvarSetOpts): string {
    return formatInput({
        buffer: opts.buffer,
        data: '/buffer set localvar_set_' + opts.name + ' ' + opts.value
    });
}

export function formatQuit(): string {
    return _formatCmd(null, 'quit', []);
}

interface FormatCompletionOpts {
    buffer: string;
    position?: number;
    data?: string;
    id?: number | null;
}

// Format completion command: "(id) completion buffer position [data]\n"
// Matches WeeChat relay protocol spec for completion requests.
export function formatCompletion(opts: FormatCompletionOpts): string {
    const position = opts.position ?? -1;
    const parts = [opts.buffer, String(position)];
    if (opts.data !== undefined && opts.data !== null) {
        parts.push(opts.data);
    }
    return _formatCmd(opts.id ?? null, 'completion', parts);
}

interface FormatDesyncOpts {
    buffers: string[];
    options?: string[];
    id?: number | null;
}

// Format desync command: "(id) desync buffer1,buffer2[,option1,option2]\n"
// Matches WeeChat relay protocol spec for desync requests.
export function formatDesync(opts: FormatDesyncOpts): string {
    const parts = [opts.buffers.join(',')];
    if (opts.options !== null && opts.options !== undefined) {
        parts.push(opts.options.join(','));
    }
    return _formatCmd(opts.id ?? null, 'desync', parts);
}

interface FormatTestOpts {
    id?: number | null;
}

// Format test command: "(id) test\n"
// Matches WeeChat relay protocol spec for test requests.
export function formatTest(opts: FormatTestOpts): string {
    return _formatCmd(opts.id ?? null, 'test', []);
}

interface FormatPingOpts {
    args?: string[];
    id?: number | null;
}

// Format ping command: "(id) ping [args...]\n"
// Matches WeeChat relay protocol spec for ping requests.
export function formatPing(opts: FormatPingOpts): string {
    const parts: string[] = [];
    if (opts.args !== null && opts.args !== undefined) {
        parts.push(opts.args.join(' '));
    }
    return _formatCmd(opts.id ?? null, 'ping', parts);
}

// --- Protocol class ---

interface TypeHandler {
    (this: Protocol): unknown;
}

interface TypeStrHandler {
     (this: Protocol, obj: unknown): string;
 }

type HandlerMap = Record<string, TypeHandler>;
type StrHandlerMap = Record<string, TypeStrHandler>;

export class Protocol {
    private static readonly types: HandlerMap = {
        chr: function (this: Protocol) { return this.getByte(); },
        int: function (this: Protocol) { return this.getInt(); },
        str: function (this: Protocol) { return this.getString(); },
        inf: function (this: Protocol) { return this.getInfo(); },
        hda: function (this: Protocol) { return this.getHdata(); },
        ptr: function (this: Protocol) { return this.getPointer(); },
        lon: function (this: Protocol) { return this.getStrNumber(); },
        tim: function (this: Protocol) { return this.getTime(); },
        buf: function (this: Protocol) { return this.getString(); },
        arr: function (this: Protocol) { return this.getArray(); },
        htb: function (this: Protocol) { return this.getHashTable(); },
        inl: function (this: Protocol) { return this.getInfolist(); }
    };

    private static readonly typesStr: StrHandlerMap = {
        chr: function (this: Protocol, obj: unknown) { return this.strDirect(obj); },
        str: function (this: Protocol, obj: unknown) { return this.strDirect(obj); },
        int: function (this: Protocol, obj: unknown) { return this.strToString(obj); },
        tim: function (this: Protocol, obj: unknown) { return this.strToString(obj); },
        ptr: function (this: Protocol, obj: unknown) { return this.strDirect(obj); }
    };

    // Default type mappings for hdata keys without explicit type specifiers.
    // WeeChat relay sends keys as bare names (e.g., "number" not "number:int").
    private static readonly hdataKeyTypes: Readonly<Record<string, string>> = Object.freeze({
        number: 'int',
        hidden: 'chr',
        notify: 'int',
        type: 'int',
        full_name: 'str',
        short_name: 'str',
        title: 'str',
        local_variables: 'htb',
        nicklist: 'chr',
        prev_buffer: 'ptr',
        next_buffer: 'ptr',
        plugin: 'str',
        name: 'str'
    });

    // Static utility: parse raw WeeChat formatted text into rich text parts
    static rawText2Rich(text: string): RichPart[] {
        return rawText2Rich(text);
    }

    // Static factory methods for backward compatibility with Protocol.formatXxx() calls
    static formatHandshake(opts: FormatHandshakeOpts): string { return formatHandshake(opts); }
    static formatInit(passwordHash: string | null, totp: string | null): string { return formatInit(passwordHash, totp); }
    static formatHdata(opts: FormatHdataOpts): string { return formatHdata(opts); }
    static formatInfo(opts: FormatInfoOpts): string { return formatInfo(opts); }
    static formatSync(dict: Record<string, unknown>): string { return formatSync(dict); }
    static formatInput(opts: FormatInputOpts): string { return formatInput(opts); }
    static formatNicklist(opts: FormatNicklistOpts): string { return formatNicklist(opts); }
    static formatInfolist(opts: FormatInfolistOpts): string { return formatInfolist(opts); }
    static formatLocalvarSet(opts: FormatLocalvarSetOpts): string { return formatLocalvarSet(opts); }
    static formatQuit(): string { return formatQuit(); }
    static formatCompletion(opts: FormatCompletionOpts): string { return formatCompletion(opts); }
    static formatDesync(opts: FormatDesyncOpts): string { return formatDesync(opts); }
    static formatTest(opts: FormatTestOpts): string { return formatTest(opts); }
    static formatPing(opts: FormatPingOpts): string { return formatPing(opts); }

    // Internal state for parsing
    private view!: DataView;
    private offset = 0;

    private static readonly MAX_STRING_LENGTH = 10 * 1024 * 1024;

    private getSlice(length: number): Uint8Array {
        if (this.offset >= this.view.byteLength) {
            return new Uint8Array(0);
        }
        if (this.offset + length > this.view.byteLength) {
            throw new RangeError(
                `Short read during protocol parsing: offset=${this.offset} length=${length} ` +
                `available=${this.view.byteLength - this.offset}`
            );
        }
        const slice = new Uint8Array(this.view.buffer, this.view.byteOffset + this.offset, length);
        this.offset += length;
        return slice;
    }

    private setData(data: Uint8Array): void {
        this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        this.offset = 0;
    }

    private getInt(): number {
        const val = this.view.getInt32(this.offset);
        this.offset += 4;
        return val;
    }

    private getByte(): number {
        return this.view.getUint8(this.offset++);
    }

    private getString(): string {
        const l = this.getInt();
        if (l > 0) {
            if (l > Protocol.MAX_STRING_LENGTH) {
                throw new RangeError(`String length ${l} exceeds max ${Protocol.MAX_STRING_LENGTH}`);
            }
            return uia2s(this.getSlice(l));
        }
        return '';
    }

    private getStrNumber(): string {
        const len = this.getByte();
        if (len <= 0) {
            return '';
        }
        if (len > Protocol.MAX_STRING_LENGTH) {
            throw new RangeError(`String length ${len} exceeds max ${Protocol.MAX_STRING_LENGTH}`);
        }
        return uia2s(this.getSlice(len));
    }

    private getType(): string {
        // Type codes are always 3 ASCII bytes ("chr", "int", "str", etc.).
        // Using String.fromCharCode avoids TextDecoder overhead for each call.
        if (this.offset >= this.view.byteLength) {
            return '';
        }
        if (this.offset + 3 > this.view.byteLength) {
            throw new RangeError(
                `Short read during protocol parsing: offset=${this.offset} length=3 ` +
                `available=${this.view.byteLength - this.offset}`
            );
        }
        const b1 = this.view.getUint8(this.offset);
        const b2 = this.view.getUint8(this.offset + 1);
        const b3 = this.view.getUint8(this.offset + 2);
        this.offset += 3;
        if (b1 === 0 && b2 === 0 && b3 === 0) return '';
        return String.fromCharCode(b1, b2, b3);
    }

    private runType(type: string): unknown {
        const handler = Protocol.types[type];
        if (!handler) {
            throw new Error('Unknown type: ' + type);
        }
        return handler.call(this);
    }

    private strDirect(obj: unknown): string {
        return obj as string;
    }

    private strToString(value: unknown): string {
        if (value instanceof Date) {
            return value.toISOString();
        }
        return String(value);
    }

    private objToString(obj: Record<string, unknown>, type: string): string {
        const cb = Protocol.typesStr[type];
        if (!cb) {
            return String(obj);
        }
        return cb.call(this, obj);
    }

    private getInfo(): { key: string; value: string } {
        return {
            key: this.getString(),
            value: this.getString()
        };
    }

    private getHdata(): Array<Record<string, unknown>> {
        const hpath = this.getString();
        const keys = this.getString().split(',').map(k => k.split(':'));
        const paths = hpath.split('/');
        const count = this.getInt();
        const objs: Array<Record<string, unknown>> = [];

        // Pre-bind and cache parsers to avoid lookup and .call() overhead in the loops
        const keysWithHandlers = keys.map(keyEntry => {
            const key = keyEntry[0]!;
            let type = keyEntry[1] ?? '';
            if (!type) {
                type = Protocol.hdataKeyTypes[key] ?? 'str';
            }
            const handler = Protocol.types[type];
            if (!handler) {
                throw new Error('Unknown type: ' + type);
            }
            return { key, parse: handler.bind(this) };
        });

        for (let i = 0; i < count; i++) {
            const tmp: Record<string, unknown> = {};
            tmp.pointers = paths.map(() => this.getPointer());
            for (let j = 0; j < keysWithHandlers.length; j++) {
                const kh = keysWithHandlers[j]!;
                tmp[kh.key] = kh.parse();
            }
            objs.push(tmp);
        }

        return objs;
    }

    private getPointer(): string {
        return this.getStrNumber();
    }

    private getTime(): Date {
        const str = this.getStrNumber();
        return new Date(parseInt(str, 10) * 1000);
    }

    private getHeader(): { length: number; compression: number } {
        const len = this.getInt();
        const comp = this.getByte();
        return { length: len, compression: comp };
    }

    private getId(): string {
        return this.getString();
    }

    private getObject(): ParsedObject | undefined {
        const type = this.getType();
        if (type) {
            return {
                type,
                content: this.runType(type)
            };
        }
        return undefined;
    }

    private getHashTable(): Record<string, unknown> {
        const typeKeys = this.getType();
        const typeValues = this.getType();
        const count = this.getInt();
        const dict: Record<string, unknown> = {};

        // Pre-resolve handlers to avoid lookup overhead inside the loop
        const handlerKeys = Protocol.types[typeKeys];
        const handlerValues = Protocol.types[typeValues];
        if (!handlerKeys) throw new Error('Unknown type: ' + typeKeys);
        if (!handlerValues) throw new Error('Unknown type: ' + typeValues);

        const keyParse = handlerKeys.bind(this);
        const valueParse = handlerValues.bind(this);
        const cbStr = Protocol.typesStr[typeKeys];

        for (let i = 0; i < count; i++) {
            const key = keyParse();
            const keyStr = cbStr ? cbStr.call(this, key) : String(key);
            const value = valueParse();
            dict[keyStr] = value;
        }

        return dict;
    }

    private getArray(): unknown[] {
        const type = this.getType();
        const count = this.getInt();
        const handler = Protocol.types[type];
        if (!handler) {
            throw new Error('Unknown type: ' + type);
        }
        const parse = handler.bind(this);
        const values: unknown[] = new Array(count);

        for (let i = 0; i < count; i++) {
            values[i] = parse();
        }

        return values;
    }

    private getInfolist(): Array<Array<Record<string, unknown>>> {
        this.getString(); // discard infolist name
        const count = this.getInt();
        const values: Array<Array<Record<string, unknown>>> = [];

        for (let i = 0; i < count; i++) {
            const itemcount = this.getInt();
            const litem: Array<Record<string, unknown>> = [];
            for (let j = 0; j < itemcount; j++) {
                const item: Record<string, unknown> = {};
                const keyStr = this.getString();
                const type = this.getType();
                const handler = Protocol.types[type];
                if (!handler) {
                    throw new Error('Unknown type: ' + type);
                }
                item[keyStr] = handler.bind(this)();
                litem.push(item);
            }
            values.push(litem);
        }

        return values;
    }

    setId(id: number, command: string): string {
        return '(' + id + ') ' + command;
    }

    async parse(data: ArrayBuffer): Promise<ParsedMessage> {
        this.setData(new Uint8Array(data));

        const header = this.getHeader();

        if (header.compression) {
            const decompressed = await decompressZlib(new Uint8Array(data, 5));
            this.setData(decompressed);
        }

        const id = this.getId();
        const objects: ParsedObject[] = [];
        let object = this.getObject();

        while (object) {
            objects.push(object);
            object = this.getObject();
        }

        return { header, id, objects };
    }
}
