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
                // values by key name matching keys order
                const keysList = hda.keys.split(',');
                for (const keyDef of keysList) {
                    const [keyName] = keyDef.split(':');
                    const val = item.values[keyName];
                    if (val === undefined || val === null) {
                        parts.push(buildUint32BE(0xFFFFFFFF)); // NULL string
                    } else if (typeof val === 'string') {
                        const [vl, vd] = buildStr(val);
                        parts.push(vl, vd);
                    } else if (typeof val === 'number') {
                        if (Number.isInteger(val)) {
                            parts.push(buildUint32BE(val));
                        } else {
                            // float stored as string number
                            const vStr = String(val);
                            const vBytes = strToBytes(vStr);
                            parts.push(new Uint8Array([vBytes.length]), vBytes);
                        }
                    } else if (typeof val === 'boolean') {
                        parts.push(new Uint8Array([val ? 1 : 0]));
                    }
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
                const keyBytes = strToBytes(key);
                parts.push(buildUint32BE(keyBytes.length), keyBytes);
                if (typeof value === 'number') {
                    parts.push(buildUint32BE(value));
                } else {
                    const valBytes = strToBytes(value as string);
                    parts.push(buildUint32BE(valBytes.length), valBytes);
                }
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
                    const [ftLen, ftData] = buildStr(field.type);
                    parts.push(ftLen, ftData);
                    if (typeof field.value === 'number') {
                        parts.push(buildUint32BE(field.value));
                    } else {
                        const [fvLen, fvData] = buildStr(field.value as string);
                        parts.push(fvLen, fvData);
                    }
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
