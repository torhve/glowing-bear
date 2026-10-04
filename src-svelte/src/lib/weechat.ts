import { rawText2Rich, type RichPart } from '#lib/weechat-colors.ts';

export * from '#lib/weechat-colors.ts';

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

// Fallback type mapping for hdata keys without an explicit type specifier.
// Real WeeChat sends typed keys in all supported versions (e.g., "number:int",
// "id:lon"); this map is a defensive fallback for untyped (bare) keys only, so a
// bare `id` key can never be mis-parsed as `str` and desync the stream.
export const hdataKeyTypes: Readonly<Record<string, string>> = Object.freeze({
    number: 'int',
    hidden: 'int',
    notify: 'int',
    type: 'int',
    full_name: 'str',
    short_name: 'str',
    title: 'str',
    local_variables: 'htb',
    nicklist: 'int',
    prev_buffer: 'ptr',
    next_buffer: 'ptr',
    plugin: 'ptr',
    name: 'str',
    id: 'lon',
    nicklist_last_id_assigned: 'lon',
    time_usec: 'lon'
});

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
                type = hdataKeyTypes[key] ?? 'str';
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
