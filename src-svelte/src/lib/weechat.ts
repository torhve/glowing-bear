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
    'chat_day_change'
];

const attrNameChars: Record<string, string> = {
    '*': 'b', '!': 'r', '/': 'i', '_': 'u',
    '\x01': 'b', '\x02': 'r', '\x03': 'i', '\x04': 'u'
};

// Reverse lookup: attribute value -> char (avoids Object.entries().find in richText2Str loop)
const attrValueToChar: Record<string, string> = {
    'b': '*', 'r': '!', 'i': '/', 'u': '_'
};

function getDefaultColor(): ColorInfo {
    return { type: 'weechat', name: 'default' };
}

function getDefaultAttributes(): TextAttrs {
    return { name: null, override: { bold: false, reverse: false, italic: false, underline: false } };
}

function getColorObj(str: string): ColorInfo {
    if (str.length === 2) {
        const code = parseInt(str, 10);
        if (code > 16) {
            return getDefaultColor();
        }
        return { type: 'weechat', name: weeChatColorsNames[code]! };
    }
    const codeStr = str.substring(1);
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
    // STD color codes: 2 digits (00-43) → option colors (foreground only)
    // Codes > 16 are out of range per WeeChat spec, return default color.
    {
        regex: /^(\d{2})/,
        fn: (txt, m) => {
            const code = parseInt(m[1]!, 10);
            if (code > 16) {
                return { fgColor: getDefaultColor(), bgColor: null, attrs: null, text: txt.substring(m[0].length) };
            }
            const optionName = colorsOptionsNames[code]!;
            return {
                fgColor: { type: 'option' as const, name: optionName },
                bgColor: null,
                attrs: { name: optionName, override: {} },
                text: txt.substring(m[0].length)
            };
        }
    },
    // Extended color codes: @ followed by 5 digits (unimplemented — colors ignored but text stripped)
    {
        regex: /^@(\d{5})/,
        fn: (txt, m) => ({
            fgColor: null, bgColor: null, attrs: null,
            text: txt.substring(m[0].length)
        })
    },
    // Foreground color: F + optional attributes + STD or EXT
    {
        regex: /^F(?:([*!_|]*)(\d{2})|@([\x01\x02\x03\x04*!_|]*)(\d{5}))/,
        fn: (txt, m) => {
            if (m[2]) {
                return { fgColor: getColorObj(m[2]), bgColor: null, attrs: attrsFromStr(m[1] ?? ''), text: txt.substring(m[0].length) };
            }
            return { fgColor: getColorObj(m[4]!), bgColor: null, attrs: attrsFromStr(m[3] ?? ''), text: txt.substring(m[0].length) };
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
    {
        regex: /^\*(?:([\x01\x02\x03\x04*!_|]*)(\d{2})|@([\x01\x02\x03\x04*!_|]*)(\d{5}))[,~](\d{2}|@\d{5})/,
        fn: (txt, m) => {
            let fgColor: ColorInfo;
            let attrs: TextAttrs | null;
            if (m[2]) {
                attrs = attrsFromStr(m[1] ?? '');
                fgColor = getColorObj(m[2]);
            } else {
                attrs = attrsFromStr(m[3] ?? '');
                fgColor = getColorObj(m[4]!);
            }
            return { fgColor, bgColor: getColorObj(m[5]!), attrs, text: txt.substring(m[0].length) };
        }
    },
    // Foreground color with * (+ attributes) - fallback
    {
        regex: /^\*([\x01\x02\x03\x04*!_|]*)(\d{2}|@\d{5})/,
        fn: (txt, m) => ({
            fgColor: getColorObj(m[2]!), bgColor: null,
            attrs: attrsFromStr(m[1] ?? ''),
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

function getStyle(txt: string): StyleResult {
    for (let i = 0; i < styleMatchers.length; i++) {
        const matcher = styleMatchers[i]!;
        const m = txt.match(matcher.regex);
        if (m) {
            return matcher.fn(txt, m);
        }
    }
    return { fgColor: null, bgColor: null, attrs: null, text: txt };
}

function attrsFromStr(str: string): TextAttrs | null {
    // Matches old JS behavior: '|' anywhere means "keep attributes" (null);
    // an empty string returns a reset (all-false) attributes object.
    const attrs: TextAttrs = { name: null, override: { bold: false, reverse: false, italic: false, underline: false } };
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
    // Manual single-pass conversion avoids V8 .replace() bug where multi-char
    // replacement strings ending with a digit matching the next source char
    // cause that character to be duplicated.
    let result = '';
    for (let i = 0; i < text.length; i++) {
        const ch = text[i]!;
        switch (ch) {
            case '\x02': result += '\x1a*'; break;   // bold
            case '\x1d': result += '\x1a/'; break;   // italic
            case '\x1f': result += '\x1a_'; break;   // underline
            case '\x16': result += '\x1a!'; break;   // reverse
            case '\x0f': result += '\x1c'; break;    // reset all
            case '\x03': {
                let j = i + 1;
                let rest = '';
                // Parse fg color digits
                while (j < text.length && text[j]! >= '0' && text[j]! <= '9') {
                    rest += text[j]!;
                    j++;
                }
                if (rest.length === 0) {
                    result += '\x1c';
                } else {
                    // Check for optional ,NN (bg color)
                    if (j < text.length && text[j]! === ',') {
                        rest += ',';
                        j++;
                        while (j < text.length && text[j]! >= '0' && text[j]! <= '9') {
                            rest += text[j]!;
                            j++;
                        }
                        result += '\x19*' + rest;
                    } else {
                        result += '\x19' + rest;
                    }
                }
                i = j - 1;
                break;
            }
            default: result += ch;
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
    let curAttrsOnlyFalseOverrides = true;

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

        // Remove false overrides when name is null and all are false (avoids Object.values() allocation)
        if (curAttrsOnlyFalseOverrides && curAttrs.name === null) {
            if (!curAttrs.override.b && !curAttrs.override.r && !curAttrs.override.i && !curAttrs.override.u) {
                curAttrs.override = {};
            } else {
                curAttrsOnlyFalseOverrides = false;
            }
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

        for (let i = 0; i < count; i++) {
            const tmp: Record<string, unknown> = {};
            tmp.pointers = paths.map(() => this.getPointer());
            for (const keyEntry of keys) {
                const key = keyEntry[0]!;
                let type = keyEntry[1] ?? '';
                if (!type) {
                    type = Protocol.hdataKeyTypes[key] ?? 'str';
                }
                tmp[key] = this.runType(type);
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

        for (let i = 0; i < count; i++) {
            const key = this.runType(typeKeys);
            const keyStr = this.objToString(key as Record<string, unknown>, typeKeys);
            const value = this.runType(typeValues);
            dict[keyStr] = value;
        }

        return dict;
    }

    private getArray(): unknown[] {
        const type = this.getType();
        const count = this.getInt();
        const values: unknown[] = [];

        for (let i = 0; i < count; i++) {
            values.push(this.runType(type));
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
                item[this.getString()] = this.runType(this.getType());
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
