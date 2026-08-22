import { hdataKeyTypes } from '$lib/weechat';

// Builds WeeChat relay protocol binary messages for unit testing.
// Format: [4B length][1B compression][ID: 4B+len+str][objects...]

export function buildUint32BE(n: number): Uint8Array {
    return new Uint8Array([
        (n >> 24) & 0xff,
        (n >> 16) & 0xff,
        (n >> 8) & 0xff,
        n & 0xff
    ]);
}

export function strToBytes(s: string): Uint8Array {
    const encoder = new TextEncoder();
    return encoder.encode(s);
}

export type TestObject = { type: string; content: unknown };

/**
 * Build a string object with 4-byte BE length prefix (str, buf, inf key/value, hda path/keys).
 * Returns [lengthBytes, dataBytes] — both Uint8Arrays.
 */
function buildStr(obj: string): [Uint8Array, Uint8Array] {
    const bytes = strToBytes(obj);
    return [buildUint32BE(bytes.length), bytes];
}

/**
 * Build a string number with 1-byte length prefix (ptr, lon, tim per protocol spec).
 * Returns [lengthByte, dataBytes] — both Uint8Arrays.
 */
function buildStrNumber(obj: string | number): [Uint8Array, Uint8Array] {
    const s = String(obj);
    const bytes = strToBytes(s);
    return [new Uint8Array([bytes.length]), bytes];
}

/**
 * Encode a single value per its declared relay wire type (str, buf, int, chr,
 * lon, ptr, tim). Used by hda items, htb entries, and inl fields so the byte
 * layout always matches Protocol.parse. undefined/null becomes the zero/NULL
 * value for the type (no stream desync).
 */
function encodeTypedValue(type: string, value: unknown, parts: Uint8Array[]): void {
    if (value === undefined || value === null) {
        if (type === 'int') { parts.push(buildUint32BE(0)); return; }
        if (type === 'chr') { parts.push(new Uint8Array([0])); return; }
        if (type === 'lon' || type === 'ptr' || type === 'tim') { parts.push(new Uint8Array([0])); return; }
        parts.push(buildUint32BE(0xFFFFFFFF)); // NULL string (str/buf/other)
        return;
    }
    switch (type) {
    case 'str': case 'buf': {
        const [l, d] = buildStr(String(value));
        parts.push(l, d);
        break;
    }
    case 'int': {
        parts.push(buildUint32BE(valueAsNumber(value)));
        break;
    }
    case 'chr': {
        parts.push(new Uint8Array([valueAsNumber(value) & 0xff]));
        break;
    }
    case 'lon': case 'ptr': {
        const [l, d] = buildStrNumber(String(value));
        parts.push(l, d);
        break;
    }
    case 'tim': {
        const [l, d] = buildStrNumber(valueAsSeconds(value));
        parts.push(l, d);
        break;
    }
    default:
        throw new Error(`buildMessage: unsupported wire type '${type}'`);
    }
}

// Coerce a JS value to a 32-bit integer (booleans -> 0/1).
function valueAsNumber(value: unknown): number {
    if (typeof value === 'boolean') return value ? 1 : 0;
    return Number(value);
}

// Coerce a JS value to epoch seconds (string) for the `tim` wire type.
function valueAsSeconds(value: unknown): string {
    if (value instanceof Date) return String(Math.floor(value.getTime() / 1000));
    return String(value);
}

export function buildMessage(callbackId: string, objects: TestObject[]): ArrayBuffer {
    const parts: Uint8Array[] = [];

    // Callback ID: 4B length + bytes
    const cbBytes = strToBytes(callbackId);
    parts.push(buildUint32BE(cbBytes.length));
    parts.push(cbBytes);

    for (const obj of objects) {
        // Object type: 3 raw bytes, no length prefix (per protocol spec §message_format)
        parts.push(strToBytes(obj.type));

        if (obj.type === 'inf') {
            const info = obj.content as { key: string; value: string };
            const [kLen, kData] = buildStr(info.key);
            parts.push(kLen, kData);
            const [vLen, vData] = buildStr(info.value);
            parts.push(vLen, vData);
        } else if (obj.type === 'str' || obj.type === 'buf') {
            const [sLen, sData] = buildStr(obj.content as string);
            parts.push(sLen, sData);
        } else if (obj.type === 'int') {
            parts.push(buildUint32BE(obj.content as number));
        } else if (obj.type === 'lon') {
            // Long integer: 1B length + numeric string (per protocol spec §object_long_integer)
            const [lLen, lData] = buildStrNumber(String(obj.content));
            parts.push(lLen, lData);
        } else if (obj.type === 'tim') {
            // Time: 1B length + seconds string (per protocol spec §object_time)
            // Accepts either a Date object or a number (seconds since epoch)
            let seconds: number;
            if (obj.content instanceof Date) {
                seconds = Math.floor(obj.content.getTime() / 1000);
            } else {
                seconds = obj.content as number;
            }
            const timeStr = String(seconds);
            const [tLen, tData] = buildStrNumber(timeStr);
            parts.push(tLen, tData);
        } else if (obj.type === 'ptr') {
            // Pointer: 1B length + hex string (per protocol spec §object_pointer)
            const [pLen, pData] = buildStrNumber(String(obj.content));
            parts.push(pLen, pData);
        } else if (obj.type === 'chr') {
            parts.push(new Uint8Array([obj.content as number]));
        } else if (obj.type === 'hda') {
            const hda = obj.content as {
                path: string; keys: string; items: Array<{
                    pointers: string[]; values: Record<string, unknown>
                }>;
            };
            const [pLen, pData] = buildStr(hda.path);
            parts.push(pLen, pData);
            const [kLen, kData] = buildStr(hda.keys);
            parts.push(kLen, kData);
            parts.push(buildUint32BE(hda.items.length));
            for (const item of hda.items) {
                // pointer path: 1B length + bytes per protocol spec (matching _getStrNumber → _getPointer)
                for (const ptr of item.pointers) {
                    const [pl, pd] = buildStrNumber(ptr);
                    parts.push(pl, pd);
                }
                // Values encoded per declared key type so the byte layout matches
                // Protocol.parse. Bare keys resolve through the shared fallback map.
                const keysList = hda.keys.split(',');
                for (const keyDef of keysList) {
                    const keyParts = keyDef.split(':');
                    const keyName = keyParts[0]!;
                    const type = keyParts[1] || hdataKeyTypes[keyName] || 'str';
                    encodeTypedValue(type, item.values[keyName], parts);
                }
            }
        } else if (obj.type === 'htb') {
            // Hashtable: type_keys(3B) + type_values(3B) + count(4B) + key-value pairs
            const htb = obj.content as {
                typeKeys: string; typeValues: string;
                items: Array<[string, unknown]>;
            };
            parts.push(strToBytes(htb.typeKeys));
            parts.push(strToBytes(htb.typeValues));
            parts.push(buildUint32BE(htb.items.length));
            for (const [key, value] of htb.items) {
                encodeTypedValue(htb.typeKeys, key, parts);
                encodeTypedValue(htb.typeValues, value, parts);
            }
        } else if (obj.type === 'inl') {
            // Infolist: name(str) + count(int) + items...
            const inl = obj.content as {
                name: string;
                items: Array<Array<{ name: string; type: string; value: unknown }>>;
            };
            const [nLen, nData] = buildStr(inl.name);
            parts.push(nLen, nData);
            parts.push(buildUint32BE(inl.items.length));
            for (const item of inl.items) {
                parts.push(buildUint32BE(item.length));
                for (const field of item) {
                    const [fnLen, fnData] = buildStr(field.name);
                    parts.push(fnLen, fnData);
                    // Field type is 3 raw bytes on the wire (matches Protocol.getType).
                    parts.push(strToBytes(field.type));
                    encodeTypedValue(field.type, field.value, parts);
                }
            }
        } else if (obj.type === 'arr') {
            const arr = obj.content as unknown[];
            if (arr.length > 0) {
                const itemType = typeof arr[0] === 'string' ? 'str' : 'int';
                // Array type: 3 raw bytes (no length prefix)
                parts.push(strToBytes(itemType));
                parts.push(buildUint32BE(arr.length));
                for (const item of arr) {
                    if (itemType === 'str') {
                        const itemData = strToBytes(item as string);
                        parts.push(buildUint32BE(itemData.length), itemData);
                    } else {
                        parts.push(buildUint32BE(item as number));
                    }
                }
            }
        }
    }

    const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
    const message = new Uint8Array(totalLength);
    let offset = 0;
    for (const part of parts) {
        message.set(part, offset);
        offset += part.length;
    }

    // Build relay frame: [4B length][1B compression][message]
    const frame = new Uint8Array(5 + totalLength);
    frame[4] = 0; // no compression
    frame.set(message, 5);

    return frame.buffer;
}
