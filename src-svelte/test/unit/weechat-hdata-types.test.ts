import { describe, it, expect } from 'vitest';
import { Protocol } from '$lib/weechat';
import { buildMessage } from './buildMessage';

describe('Protocol hdata key type inference', () => {
    it('parses hdata with explicit type specifiers (number:int,full_name:str)', async () => {
        const binary = buildMessage('cbid', [
            { type: 'hda', content: {
                path: 'buffer',
                keys: 'number:int,full_name:str',
                items: [
                    { pointers: ['0xdeadbeef'], values: { number: 1, full_name: 'core.weechat' } },
                    { pointers: ['0xabc123'], values: { number: 2, full_name: 'irc.libera.#test' } }
                ]
            }}
        ]);
        const protocol = new Protocol();
        const result = await protocol.parse(binary);
        expect(result.objects).toHaveLength(1);
        const hdaContent = result.objects[0]!.content as Array<Record<string, unknown>>;
        expect(hdaContent).toHaveLength(2);
        expect(hdaContent[0]!.pointers).toEqual(['0xdeadbeef']);
        expect(hdaContent[0]!.number).toBe(1);
        expect(hdaContent[0]!.full_name).toBe('core.weechat');
        expect(hdaContent[1]!.number).toBe(2);
        expect(hdaContent[1]!.full_name).toBe('irc.libera.#test');
    });

    it('parses hdata without type specifiers (number,full_name) by inferring types from key names', async () => {
        const binary = buildMessage('cbid', [
            { type: 'hda', content: {
                path: 'buffer',
                keys: 'number,full_name,short_name',
                items: [
                    { pointers: ['0xdeadbeef'], values: { number: 1, full_name: 'core.weechat', short_name: 'weechat' } },
                    { pointers: ['0xabc123'], values: { number: 2, full_name: 'irc.libera.#test', short_name: '#test' } },
                    { pointers: ['0x987654'], values: { number: 3, full_name: 'irc.libera.#general', short_name: '#general' } }
                ]
            }}
        ]);
        const protocol = new Protocol();
        const result = await protocol.parse(binary);
        expect(result.objects).toHaveLength(1);
        const hdaContent = result.objects[0]!.content as Array<Record<string, unknown>>;
        expect(hdaContent).toHaveLength(3);

        // Buffer 1: core.weechat
        expect(hdaContent[0]!.pointers).toEqual(['0xdeadbeef']);
        expect(hdaContent[0]!.number).toBe(1);
        expect(hdaContent[0]!.full_name).toBe('core.weechat');
        expect(hdaContent[0]!.short_name).toBe('weechat');

        // Buffer 2: irc.libera.#test
        expect(hdaContent[1]!.pointers).toEqual(['0xabc123']);
        expect(hdaContent[1]!.number).toBe(2);
        expect(hdaContent[1]!.full_name).toBe('irc.libera.#test');
        expect(hdaContent[1]!.short_name).toBe('#test');

        // Buffer 3: irc.libera.#general
        expect(hdaContent[2]!.pointers).toEqual(['0x987654']);
        expect(hdaContent[2]!.number).toBe(3);
        expect(hdaContent[2]!.full_name).toBe('irc.libera.#general');
        expect(hdaContent[2]!.short_name).toBe('#general');
    });

    it('parses hdata with mixed type specifiers (some explicit, some inferred)', async () => {
        const binary = buildMessage('cbid', [
            { type: 'hda', content: {
                path: 'buffer',
                keys: 'number:int,full_name,short_name:str',
                items: [
                    { pointers: ['0xdeadbeef'], values: { number: 5, full_name: '#mixed', short_name: 'mixed' } }
                ]
            }}
        ]);
        const protocol = new Protocol();
        const result = await protocol.parse(binary);
        const hdaContent = result.objects[0]!.content as Array<Record<string, unknown>>;
        expect(hdaContent[0]!.number).toBe(5);
        expect(hdaContent[0]!.full_name).toBe('#mixed');
        expect(hdaContent[0]!.short_name).toBe('mixed');
    });

    it('parses hdata hidden field (chr) without type specifier', async () => {
        const binary = buildMessage('cbid', [
            { type: 'hda', content: {
                path: 'buffer',
                keys: 'hidden,number',
                items: [
                    { pointers: ['0xdead1'], values: { number: 1, hidden: false } },
                    { pointers: ['0xdead2'], values: { number: 2, hidden: true } }
                ]
            }}
        ]);
        const protocol = new Protocol();
        const result = await protocol.parse(binary);
        const hdaContent = result.objects[0]!.content as Array<Record<string, unknown>>;
        expect(hdaContent[0]!.hidden).toBe(0);
        expect(hdaContent[1]!.hidden).toBe(1);
    });

    it('parses hdata notify field (int) without type specifier', async () => {
        const binary = buildMessage('cbid', [
            { type: 'hda', content: {
                path: 'buffer',
                keys: 'notify,number',
                items: [
                    { pointers: ['0xdeadbeef'], values: { number: 1, notify: 3 } },
                    { pointers: ['0xabc123'], values: { number: 2, notify: 2 } }
                ]
            }}
        ]);
        const protocol = new Protocol();
        const result = await protocol.parse(binary);
        const hdaContent = result.objects[0]!.content as Array<Record<string, unknown>>;
        expect(hdaContent[0]!.number).toBe(1);
        expect(hdaContent[0]!.notify).toBe(3);
        expect(hdaContent[1]!.number).toBe(2);
        expect(hdaContent[1]!.notify).toBe(2);
    });

    it('parses full buffer info response without type specifiers (real-world format)', async () => {
        // This mirrors the actual query: keys: ['notify,number,full_name,short_name,title,hidden,type']
        // WeeChat doesn't send type specifiers in responses — only key names.
        const binary = buildMessage('_buffer_info', [
            { type: 'hda', content: {
                path: 'buffer',
                keys: 'notify,number,full_name,short_name,title,hidden,type',
                items: [
                    {
                        pointers: ['0x100'],
                        values: {
                            notify: 3,
                            number: 1,
                            full_name: 'core.weechat',
                            short_name: 'weechat',
                            title: 'WeeChat 4.2.0-dev',
                            hidden: false,
                            type: 0
                        }
                    },
                    {
                        pointers: ['0x200'],
                        values: {
                            notify: 3,
                            number: 2,
                            full_name: 'irc.libera.#test',
                            short_name: '#test',
                            title: 'Test channel',
                            hidden: false,
                            type: 0
                        }
                    }
                ]
            }}
        ]);
        const protocol = new Protocol();
        const result = await protocol.parse(binary);
        expect(result.objects).toHaveLength(1);
        expect(result.id).toBe('_buffer_info');

        const hdaContent = result.objects[0]!.content as Array<Record<string, unknown>>;
        expect(hdaContent).toHaveLength(2);

        // core.weechat buffer
        const buf1 = hdaContent[0]!;
        expect(buf1.pointers).toEqual(['0x100']);
        expect(buf1.number).toBe(1);
        expect(buf1.full_name).toBe('core.weechat');
        expect(buf1.short_name).toBe('weechat');
        expect(buf1.hidden).toBe(0);
        expect(buf1.notify).toBe(3);

        // irc.libera.#test buffer
        const buf2 = hdaContent[1]!;
        expect(buf2.pointers).toEqual(['0x200']);
        expect(buf2.number).toBe(2);
        expect(buf2.full_name).toBe('irc.libera.#test');
        expect(buf2.short_name).toBe('#test');
        expect(buf2.hidden).toBe(0);
        expect(buf2.notify).toBe(3);
    });
});
