import { describe, it, expect } from 'vitest';
import { Protocol } from '$lib/weechat';
import { buildMessage } from './buildMessage';

describe('Protocol buffer line parsing', () => {
    it('parses hdata buffer path with pointer', async () => {
        const binary = buildMessage('cbid3', [
            { type: 'hda', content: {
                path: 'buffer',
                keys: 'number:int,name:str',
                items: [
                    { pointers: ['0xdeadbeef'], values: { number: 1, name: 'test buffer' } }
                ]
            }}
        ]);
        const protocol = new Protocol();
        const result = await protocol.parse(binary);
        expect(result.objects).toHaveLength(1);
        expect(result.objects[0]!.type).toBe('hda');
        const hdaContent = result.objects[0]!.content as Array<Record<string, unknown>>;
        expect(hdaContent).toHaveLength(1);
        expect(hdaContent[0]!.pointers).toEqual(['0xdeadbeef']);
        expect(hdaContent[0]!.number).toBe(1);
        expect(hdaContent[0]!.name).toBe('test buffer');
    });

    it('parses timestamp correctly from time object', async () => {
        const timestamp = new Date(2026, 5, 15, 14, 30, 0);
        const binary = buildMessage('cbid4', [
            { type: 'tim', content: timestamp }
        ]);
        const protocol = new Protocol();
        const result = await protocol.parse(binary);
        expect(result.objects[0]!.type).toBe('tim');
        const parsedDate = result.objects[0]!.content as Date;
        expect(parsedDate.getTime()).toBe(timestamp.getTime());
    });

    it('parses empty string field', async () => {
        const binary = buildMessage('cbid5', [
            { type: 'str', content: '' }
        ]);
        const protocol = new Protocol();
        const result = await protocol.parse(binary);
        expect(result.objects[0]!.type).toBe('str');
        expect(result.objects[0]!.content).toBe('');
    });
});

describe('Protocol nicklist parsing', () => {
    it('parses nicklist count and entries', async () => {
        const binary = buildMessage('cbid6', [
            { type: 'int', content: 3 },
            { type: 'str', content: 'alice' },
            { type: 'str', content: 'bob' },
            { type: 'str', content: 'charlie' }
        ]);
        const protocol = new Protocol();
        const result = await protocol.parse(binary);
        expect(result.objects[0]!.content).toBe(3);
        expect(result.objects[1]!.content).toBe('alice');
        expect(result.objects[2]!.content).toBe('bob');
    });
});

describe('Protocol hotlist parsing', () => {
    it('parses hotlist with buffer pointer, message count, and buffer name', async () => {
        const binary = buildMessage('cbid7', [
            { type: 'ptr', content: '0xabc123' },
            { type: 'int', content: 5 },
            { type: 'buf', content: 'irc.libera.chat+#general' }
        ]);
        const protocol = new Protocol();
        const result = await protocol.parse(binary);
        expect(result.objects.length).toBe(3);
        expect((result.objects[0]!.content as string)).toBe('0xabc123');
        expect((result.objects[1]!.content as number)).toBe(5);
        expect(result.objects[2]!.content).toBe('irc.libera.chat+#general');
    });
});
