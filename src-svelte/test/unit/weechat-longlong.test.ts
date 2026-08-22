// Tests for the WeeChat long/long-long (lon) relay hardening.
//
// WeeChat `main` (4.11-dev) adds `long`/`long long` infolist types and converts
// the buffer/nicklist `id` hdata/infolist variables to `long long`. On the
// classic relay wire both serialize as the `lon` object (1B length + decimal
// string). These tests pin the parser (and the shared buildMessage encoder) to
// that shape so a `lon` value can never be mis-parsed as a 4-byte `str` and
// desync the stream.
import { describe, it, expect } from 'vitest';
import { Protocol } from '$lib/weechat';
import { buildMessage } from './buildMessage';

// 16-digit value that exceeds the 32-bit signed range (like a real 4.10 `id`).
const BIG_ID = '1787394306627471';

describe('Protocol long/long long (lon) hardening', () => {
    it('parses typed-key buffer hdata in the 4.10/main shape (id:lon)', async () => {
        // Mirrors a live WeeChat 4.10.0 capture: typed keys, id as a 16-digit
        // decimal string serialized with the `lon` wire type.
        const binary = buildMessage('_buffer_info', [
            { type: 'hda', content: {
                path: 'buffer',
                keys: 'id:lon,notify:int,number:int,full_name:str,short_name:str,title:str,hidden:int,type:int',
                items: [
                    {
                        pointers: ['0x100'],
                        values: {
                            id: BIG_ID,
                            notify: 3,
                            number: 1,
                            full_name: 'core.weechat',
                            short_name: 'weechat',
                            title: 'WeeChat 4.10.0',
                            hidden: 0,
                            type: 0
                        }
                    },
                    {
                        pointers: ['0x200'],
                        values: {
                            id: '1787394306627472',
                            notify: 3,
                            number: 2,
                            full_name: 'irc.libera.#test',
                            short_name: '#test',
                            title: 'Test channel',
                            hidden: 0,
                            type: 0
                        }
                    }
                ]
            }}
        ]);
        const protocol = new Protocol();
        const result = await protocol.parse(binary);
        const hda = result.objects[0]!.content as Array<Record<string, unknown>>;

        expect(hda).toHaveLength(2);
        // `id` must come back as the exact decimal string (lon -> getStrNumber).
        expect(hda[0]!.id).toBe(BIG_ID);
        expect(hda[1]!.id).toBe('1787394306627472');
        // int/str fields stay in their correct lanes (no desync after the lon).
        expect(hda[0]!.number).toBe(1);
        expect(hda[0]!.notify).toBe(3);
        expect(hda[0]!.hidden).toBe(0);
        expect(hda[0]!.type).toBe(0);
        expect(hda[0]!.full_name).toBe('core.weechat');
        expect(hda[0]!.short_name).toBe('weechat');
        expect(hda[0]!.title).toBe('WeeChat 4.10.0');
        expect(hda[1]!.full_name).toBe('irc.libera.#test');
        expect(hda[1]!.number).toBe(2);
    });

    it('parses buffer hdata without an id key (3.x / 4.0-4.2 shape)', async () => {
        // Buffer hdata `id` (LONGLONG) does not exist before WeeChat 4.3.0, so
        // clients must tolerate a key list that omits it entirely.
        const binary = buildMessage('_buffer_info', [
            { type: 'hda', content: {
                path: 'buffer',
                keys: 'notify:int,number:int,full_name:str,short_name:str,title:str,hidden:int,type:int',
                items: [
                    {
                        pointers: ['0x100'],
                        values: {
                            notify: 3,
                            number: 1,
                            full_name: 'core.weechat',
                            short_name: 'weechat',
                            title: 'WeeChat 3.8.0',
                            hidden: 0,
                            type: 0
                        }
                    }
                ]
            }}
        ]);
        const protocol = new Protocol();
        const result = await protocol.parse(binary);
        const hda = result.objects[0]!.content as Array<Record<string, unknown>>;

        expect(hda).toHaveLength(1);
        expect(hda[0]!).not.toHaveProperty('id');
        // All remaining fields parse intact.
        expect(hda[0]!.number).toBe(1);
        expect(hda[0]!.notify).toBe(3);
        expect(hda[0]!.full_name).toBe('core.weechat');
        expect(hda[0]!.short_name).toBe('weechat');
        expect(hda[0]!.title).toBe('WeeChat 3.8.0');
        expect(hda[0]!.hidden).toBe(0);
        expect(hda[0]!.type).toBe(0);
    });

    it('infers a bare (untyped) id key as lon and parses it as a numeric string', async () => {
        // Defensive fallback: a key list without type specifiers must still map
        // `id` to `lon` (via the shared hdataKeyTypes map) so it is never read
        // as a 4-byte `str` and desyncs the following fields.
        const binary = buildMessage('_buffer_info', [
            { type: 'hda', content: {
                path: 'buffer',
                keys: 'id,number',
                items: [
                    { pointers: ['0x100'], values: { id: BIG_ID, number: 5 } }
                ]
            }}
        ]);
        const protocol = new Protocol();
        const result = await protocol.parse(binary);
        const hda = result.objects[0]!.content as Array<Record<string, unknown>>;

        expect(hda).toHaveLength(1);
        expect(hda[0]!.id).toBe(BIG_ID);
        // The field after the inferred lon is still intact (proves no desync).
        expect(hda[0]!.number).toBe(5);
    });

    it('parses a hashtable with lon values (htb typeValues: lon)', async () => {
        const binary = buildMessage('htb-lon', [
            { type: 'htb', content: {
                typeKeys: 'str',
                typeValues: 'lon',
                items: [
                    ['first', BIG_ID],
                    ['second', '42']
                ]
            }}
        ]);
        const protocol = new Protocol();
        const result = await protocol.parse(binary);
        const htb = result.objects[0]!.content as Record<string, unknown>;

        expect(htb.first).toBe(BIG_ID);
        expect(htb.second).toBe('42');
    });

    it('parses an infolist item containing a lon-typed variable as a string', async () => {
        // Forward-compat: if the upstream relay serializer is fixed to emit `lon`
        // for `l`/`L` infolist variables, the parser must read the value as a
        // decimal string (the wire type is 3 raw bytes, then the lon object).
        const binary = buildMessage('inl-lon', [
            { type: 'inl', content: {
                name: 'buffer',
                items: [[
                    { name: 'id', type: 'lon', value: BIG_ID },
                    { name: 'number', type: 'int', value: 1 }
                ]]
            }}
        ]);
        const protocol = new Protocol();
        const result = await protocol.parse(binary);
        const inl = result.objects[0]!.content as Array<Array<Record<string, unknown>>>;

        expect(inl).toHaveLength(1);
        expect(inl[0]).toHaveLength(2);
        expect(inl[0]![0]!.id).toBe(BIG_ID);
        // The int field that follows the lon is intact.
        expect(inl[0]![1]!.number).toBe(1);
    });
});
