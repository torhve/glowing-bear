import * as fflate from 'fflate';

// --- Type definitions ---

export interface ColorInfo {
    type: 'option' | 'weechat' | 'ext';
    name: string;
}

export interface TextAttrs {
    name: string | null;
    override: Record<string, boolean>;
}

interface RichPart {
    text: string;
    fgColor: ColorInfo;
    bgColor: ColorInfo;
    attrs: TextAttrs;
}

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

const unzlibSync = fflate.unzlibSync;
const utf8Decoder = new TextDecoder('utf-8');

function decompressZlib(raw: Uint8Array): ArrayBuffer {
    try {
        const result = unzlibSync(raw);
        return result.buffer as ArrayBuffer;
    } catch (e) {
        console.error('zlib decompression failed:', e);
        throw e;
    }
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

function cloneColor(color: ColorInfo): ColorInfo {
    return { ...color };
}

function cloneAttrs(attrs: TextAttrs): TextAttrs {
    return { name: attrs.name, override: { ...attrs.override } };
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

function getStyle(txt: string): StyleResult {
    const matchers: { regex: RegExp; fn: (m: RegExpMatchArray) => StyleResult }[] = [
        // STD color codes: 2 digits (00-43) → option colors (foreground only)
        {
            regex: /^(\d{2})/,
            fn: (m) => {
                const code = parseInt(m[1]!, 10);
                if (code >= colorsOptionsNames.length) {
                    // Out-of-range: preserve current colors (matches old JS behavior)
                    return { fgColor: null, bgColor: null, attrs: null, text: txt.substring(2) };
                }
                const optionName = colorsOptionsNames[code] || 'default';
                const color = { type: 'option' as const, name: optionName };
                // STD color codes only change foreground (old JS bug: cloned fg to bg)
                return {
                    fgColor: color,
                    bgColor: null,
                    attrs: { name: optionName, override: {} },
                    text: txt.substring(m[0].length)
                };
            }
        },
        // Extended color codes: @ followed by 5 digits (unimplemented in original — colors ignored but text still stripped)
        {
            regex: /^@(\d{5})/,
            fn: (m) => ({
                fgColor: null,
                bgColor: null,
                attrs: null,
                text: txt.substring(m[0].length)
            })
        },
        // Foreground color: F + optional attributes + STD or EXT
        {
            // eslint-disable-next-line no-control-regex -- WeeChat color format control chars
            regex: /^F(?:([*!_|]*)(\d{2})|@([\x01\x02\x03\x04*!_|]*)(\d{5}))/,
            fn: (m) => {
                let ret: StyleResult;
                if (m[2]) {
                    ret = { fgColor: getColorObj(m[2]), bgColor: null, attrs: attrsFromStr(m[1] ?? ''), text: txt.substring(m[0].length) };
                } else {
                    ret = { fgColor: getColorObj(m[4]!), bgColor: null, attrs: attrsFromStr(m[3] ?? ''), text: txt.substring(m[0].length) };
                }
                return ret;
            }
        },
        // Background color: B + STD or EXT
        {
            regex: /^B(\d{2}|@\d{5})/,
            fn: (m) => ({
                fgColor: null,
                bgColor: getColorObj(m[1]!),
                attrs: null,
                text: txt.substring(m[0].length)
            })
        },
        // Foreground + background with optional attributes (WeeChat 2.6+ uses ~ or ,)
        {
            // eslint-disable-next-line no-control-regex -- WeeChat color format control chars
            regex: /^\*(?:([\x01\x02\x03\x04*!_|]*)(\d{2})|@([\x01\x02\x03\x04*!_|]*)(\d{5}))[,~](\d{2}|@\d{5})/,
            fn: (m) => {
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
        // Foreground color with * (+ attributes) - fallback, checked after previous case
        {
            // eslint-disable-next-line no-control-regex -- WeeChat color format control chars
            regex: /^\*([\x01\x02\x03\x04*!_|]*)(\d{2}|@\d{5})/,
            fn: (m) => ({
                fgColor: getColorObj(m[2]!),
                bgColor: null,
                attrs: attrsFromStr(m[1] ?? ''),
                text: txt.substring(m[0].length)
            })
        },
        // Emphasis
        {
            regex: /^E/,
            fn: () => ({
                fgColor: { type: 'option', name: 'emphasis' },
                bgColor: null,
                attrs: { name: 'emphasis', override: {} },
                text: txt.substring(1)
            })
        }
    ];

    const ret: StyleResult = { fgColor: null, bgColor: null, attrs: null, text: txt };
    for (const matcher of matchers) {
        const m = txt.match(matcher.regex);
        if (m) {
            const result = matcher.fn(m);
            return result;
        }
    }
    return ret;
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
    return text
        // eslint-disable-next-line no-control-regex -- IRC format control chars
        .replace(/\x02/g, '\x1a*')      // bold → WeeChat set-bold
        // eslint-disable-next-line no-control-regex -- IRC format control chars
        .replace(/\x1d/g, '\x1a/')      // italic → WeeChat set-italic
        // eslint-disable-next-line no-control-regex -- IRC format control chars
        .replace(/\x1f/g, '\x1a_')      // underline → WeeChat set-underline
        // eslint-disable-next-line no-control-regex -- IRC format control chars
        .replace(/\x16/g, '\x1a!')      // reverse → WeeChat set-reverse
        // eslint-disable-next-line no-control-regex -- IRC format control chars
        .replace(/\x0f/g, '\x1c')       // reset all → WeeChat reset
        // eslint-disable-next-line no-control-regex -- IRC color format control char
        .replace(/\x03(\d{1,2}(,\d{1,2})?)?/g, (match) => {
            if (match.length === 1) {
                // bare \x03 with no digits → reset colors
                return '\x1c';
            }
            const digits = match.substring(1);
            if (digits.includes(',')) {
                // fg+bg: \x03NN,MM → \x19*NN,MM
                return '\x19*' + digits;
            }
            // fg only: \x03NN → \x19NN
            return '\x19' + digits;
        });
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

        // Remove false overrides when name is null and all are false
        if (curAttrsOnlyFalseOverrides && curAttrs.name === null) {
            const allReset = Object.values(curAttrs.override).every(v => !v);
            if (allReset) {
                curAttrs.override = {};
            } else {
                curAttrsOnlyFalseOverrides = false;
            }
        }

        result.push({
            fgColor: cloneColor(curFgColor),
            bgColor: cloneColor(curBgColor),
            attrs: cloneAttrs(curAttrs),
            text
        });
    }

    return result;
}

export function richText2Str(parts: RichPart[]): string {
    return parts.map(part => {
        let str = '';

        // Colors
        if (part.fgColor.type === 'weechat') {
            const idx = colorNameToIndex.get(part.fgColor.name);
            if (idx !== undefined) {
                str += '%' + idx.toString().padStart(2, '0');
            }
        } else if (part.fgColor.type === 'ext') {
            str += '%' + part.fgColor.name;
        } else if (part.fgColor.type === 'option') {
            str += '^' + part.fgColor.name;
        }

        if (part.bgColor.type === 'weechat') {
            const idx = colorNameToIndex.get(part.bgColor.name);
            if (idx !== undefined) {
                str += ',' + idx.toString().padStart(2, '0');
            }
        } else if (part.bgColor.type === 'ext') {
            str += ',' + part.bgColor.name;
        } else if (part.bgColor.type === 'option') {
            str += ',' + part.bgColor.name;
        }

        // Attributes
        if (part.attrs.name) {
            str += '/' + part.attrs.name;
        }
        for (const attr in part.attrs.override) {
            if (part.attrs.override[attr]) {
                const char = attrValueToChar[attr];
                if (char) {
                    str += '/' + char;
                }
            }
        }

        str += ':' + part.text;
        return str;
    }).join('');
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
    const parts = [];
    const dictStr = _formatDict({
        password_hash_algo: merged.password_hash_algo ?? defaults.password_hash_algo,
        compression: merged.compression ?? defaults.compression
    });
    if (dictStr) {
        parts.push(dictStr);
    }
    return _formatCmd(null, 'handshake', parts);
}

// Format init command: "init password_hash=...,totp=...\n"
// Signature matches original JS: (password_hash, totp)
export function formatInit(passwordHash: string | null, totp: string | null): string {
    const parts = [];
    const keys: string[] = [];
    if (passwordHash !== null) {
        keys.push('password_hash=' + passwordHash);
    }
    if (totp !== null) {
        keys.push('totp=' + totp);
    }
    if (keys.length > 0) {
        parts.push(keys.join(','));
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
    private static readonly _types: HandlerMap = {
        chr: function (this: Protocol) { return this._getChar(); },
        int: function (this: Protocol) { return this._getInt(); },
        str: function (this: Protocol) { return this._getString(); },
        inf: function (this: Protocol) { return this._getInfo(); },
        hda: function (this: Protocol) { return this._getHdata(); },
        ptr: function (this: Protocol) { return this._getPointer(); },
        lon: function (this: Protocol) { return this._getStrNumber(); },
        tim: function (this: Protocol) { return this._getTime(); },
        buf: function (this: Protocol) { return this._getString(); },
        arr: function (this: Protocol) { return this._getArray(); },
        htb: function (this: Protocol) { return this._getHashTable(); },
        inl: function (this: Protocol) { return this._getInfolist(); }
    };

    private static readonly _typesStr: StrHandlerMap = {
        chr: function (this: Protocol, obj: unknown) { return this._strDirect(obj); },
        str: function (this: Protocol, obj: unknown) { return this._strDirect(obj); },
        int: function (this: Protocol, obj: unknown) { return this._strToString(obj); },
        tim: function (this: Protocol, obj: unknown) { return this._strToString(obj); },
        ptr: function (this: Protocol, obj: unknown) { return this._strDirect(obj); }
    };

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
    private _data!: ArrayBuffer;
    private _dataAt = 0;

    private _getType(): string {
        const t = this._getSlice(3);
        if (!t) {
            return '';
        }
        const data = new Uint8Array(t);
        return utf8Decoder.decode(data);
    }

    private _runType(type: string): unknown {
        const handler = Protocol._types[type];
        if (!handler) {
            throw new Error('Unknown type: ' + type);
        }
        return handler.call(this);
    }

    private _strDirect(obj: unknown): string {
        return obj as string;
    }

    private _strToString(value: unknown): string {
        if (value instanceof Date) {
            return value.toISOString();
        }
        return String(value);
    }

    private _objToString(obj: Record<string, unknown>, type: string): string {
        const cb = Protocol._typesStr[type];
        if (!cb) {
            return String(obj);
        }
        return cb.call(this, obj);
    }

    private _getInfo(): { key: string; value: string } {
        return {
            key: this._getString(),
            value: this._getString()
        };
    }

    private _getHdata(): Array<Record<string, unknown>> {
        const hpath = this._getString();
        const keys = this._getString().split(',').map(k => k.split(':'));
        const paths = hpath.split('/');
        const count = this._getInt();
        const objs: Array<Record<string, unknown>> = [];

        for (let i = 0; i < count; i++) {
            const tmp: Record<string, unknown> = {};
            tmp.pointers = paths.map(() => this._getPointer());
            for (const keyEntry of keys) {
                const key = keyEntry[0]!;
                const type = keyEntry[1] ?? '';
                tmp[key] = this._runType(type);
            }
            objs.push(tmp);
        }

        return objs;
    }

    private _getPointer(): string {
        return this._getStrNumber();
    }

    private _getTime(): Date {
        const str = this._getStrNumber();
        return new Date(parseInt(str, 10) * 1000);
    }

    private _getInt(): number {
        const parsedData = new Uint8Array(this._getSlice(4));
        return ((parsedData[0]! & 0xff) << 24) |
            ((parsedData[1]! & 0xff) << 16) |
            ((parsedData[2]! & 0xff) << 8) |
            (parsedData[3]! & 0xff);
    }

    private _getByte(): number {
        const parsedData = new Uint8Array(this._getSlice(1));
        return parsedData[0]!;
    }

    private _getChar(): number {
        return this._getByte();
    }

    private _getString(): string {
        const l = this._getInt();
        if (l > 0) {
            const s = this._getSlice(l);
            const parsedData = new Uint8Array(s);
            return uia2s(parsedData);
        }
        return '';
    }

    private _getHeader(): { length: number; compression: number } {
        const len = this._getInt();
        const comp = this._getByte();
        return { length: len, compression: comp };
    }

    private _getId(): string {
        return this._getString();
    }

    private _getObject(): ParsedObject | undefined {
        const type = this._getType();
        if (type) {
            return {
                type,
                content: this._runType(type)
            };
        }
        return undefined;
    }

    private _getHashTable(): Record<string, unknown> {
        const typeKeys = this._getType();
        const typeValues = this._getType();
        const count = this._getInt();
        const dict: Record<string, unknown> = {};

        for (let i = 0; i < count; i++) {
            const key = this._runType(typeKeys);
            const keyStr = this._objToString(key as Record<string, unknown>, typeKeys);
            const value = this._runType(typeValues);
            dict[keyStr] = value;
        }

        return dict;
    }

    private _getArray(): unknown[] {
        const type = this._getType();
        const count = this._getInt();
        const values: unknown[] = [];

        for (let i = 0; i < count; i++) {
            values.push(this._runType(type));
        }

        return values;
    }

    private _getInfolist(): Array<Array<Record<string, unknown>>> {
        this._getString(); // discard infolist name
        const count = this._getInt();
        const values: Array<Array<Record<string, unknown>>> = [];

        for (let i = 0; i < count; i++) {
            const itemcount = this._getInt();
            const litem: Array<Record<string, unknown>> = [];
            for (let j = 0; j < itemcount; j++) {
                const item: Record<string, unknown> = {};
                item[this._getString()] = this._runType(this._getType());
                litem.push(item);
            }
            values.push(litem);
        }

        return values;
    }

    private _getSlice(length: number): ArrayBuffer {
        if (this._dataAt + length > this._data.byteLength) {
            return new ArrayBuffer(0);
        }
        const slice = this._data.slice(this._dataAt, this._dataAt + length);
        this._dataAt += length;
        return slice;
    }

    private _setData(data: ArrayBuffer): void {
        this._data = data;
    }

    // Reads a string with 1-byte length prefix (used by ptr, lon, tim per protocol spec)
    private _getStrNumber(): string {
        const len = this._getByte();
        if (len <= 0) {
            return '';
        }
        const s = this._getSlice(len);
        const parsedData = new Uint8Array(s);
        return uia2s(parsedData);
    }

    setId(id: number, command: string): string {
        return '(' + id + ') ' + command;
    }

    parse(data: ArrayBuffer): ParsedMessage {
        this._setData(data);
        this._dataAt = 0;

        const header = this._getHeader();

        if (header.compression) {
            const raw = new Uint8Array(data, 5);
            const plain = decompressZlib(raw);
            this._setData(plain);
            this._dataAt = 0;
        }

        const id = this._getId();
        const objects: ParsedObject[] = [];
        let object = this._getObject();

        while (object) {
            objects.push(object);
            object = this._getObject();
        }

        return { header, id, objects };
    }
}
