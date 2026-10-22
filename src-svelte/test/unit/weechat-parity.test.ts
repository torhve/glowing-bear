// Parity tests: compare new TypeScript weechat.ts parser against original AngularJS weechat.js
// Both parsers should produce identical results for the same binary input.

import { describe, it, expect, beforeEach } from 'vitest';
import { buildMessage } from './buildMessage';
import { Protocol as NewProtocol } from '#lib/weechat.ts';
import type { ParsedMessage } from '#lib/weechat.ts';

/**
 * What the old parser hands back. It is deliberately NOT `ParsedMessage`: this
 * file's whole job is to compare the two parsers, and typing the old one as the
 * new one's result would make a disagreement between them unrepresentable.
 */
type OldParsed = Record<string, unknown>;
type OldProtocolCtor = new () => { parse(data: ArrayBuffer): Promise<OldParsed> };

// Loaded dynamically: the fixture pulls in its own decompression, which the bundler
// does not want to see at module scope.
async function loadOldProtocol(): Promise<OldProtocolCtor> {
    const mod = await import('../fixtures/weechat-old.js');
    // The fixture is untyped JavaScript; this is the constructor shape the parity
    // test actually calls.
    return (mod as { Protocol: unknown }).Protocol as OldProtocolCtor;
}

let OldProtocol: OldProtocolCtor | null = null;

beforeEach(async () => {
    if (!OldProtocol) {
        try {
            OldProtocol = await loadOldProtocol();
        } catch {
            OldProtocol = null;
        }
    }
});

/** A fresh old-parser instance, or the reason this run cannot compare anything. */
function newOldProtocol(): { parse(data: ArrayBuffer): Promise<OldParsed> } {
    if (!OldProtocol) throw new Error('the old-parser fixture did not load');
    return new OldProtocol();
}

/**
 * One old-parser object row. `OldParsed` is a record of unknowns on purpose, so
 * reading a field out of it is written here once instead of casting at each site.
 */
function oldObjects(msg: OldParsed): Array<{ type?: string; content?: unknown }> {
    return (msg['objects'] ?? []) as Array<{ type?: string; content?: unknown }>;
}

// Helper to deep-compare parsed results, normalizing Date objects
function compareMessages(newMsg: ParsedMessage, oldMsg: OldParsed): boolean {
    const newHeader = newMsg.header as { length: number; compression: number };
    const oldHeader = oldMsg.header as { length: number; compression: number };
    if (newHeader.length !== oldHeader.length || newHeader.compression !== oldHeader.compression) {
        return false;
    }
    if (newMsg.id !== (oldMsg.id as string)) {
        return false;
    }
    const newObjs = newMsg.objects;
    const oldObjs = oldMsg.objects as Array<{ type: string; content: unknown }>;
    if (newObjs.length !== oldObjs.length) {
        return false;
    }
    for (let i = 0; i < newObjs.length; i++) {
        if (newObjs[i]?.type !== oldObjs[i]?.type) {
            return false;
        }
        if (!compareValues(newObjs[i]?.content, oldObjs[i]?.content)) {
            return false;
        }
    }
    return true;
}

function compareValues(a: unknown, b: unknown): boolean {
    if (a instanceof Date && b instanceof Date) {
        return a.getTime() === b.getTime();
    }
    if (a instanceof Date || b instanceof Date) {
        return false;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (!compareValues(a[i], b[i])) return false;
        }
        return true;
    }
    if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
        const keysA = Object.keys(a as object);
        const keysB = Object.keys(b as object);
        if (keysA.length !== keysB.length) return false;
        for (const key of keysA) {
            if (!(key in (b as object))) return false;
            if (!compareValues((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) {
                return false;
            }
        }
        return true;
    }
    return a === b;
}

describe('weechat parity: new vs old parser', () => {
    it('should parse handshake response identically', async () => {
        const msg = buildMessage('1', [
            { type: 'inf', content: { key: 'protocol_version', value: '2' } },
            { type: 'inf', content: { key: 'nick', value: 'testuser' } },
            { type: 'inf', content: { key: 'user', value: 'testuser' } },
        ]);

        const newProtocol = new NewProtocol();
        const newMsg = await newProtocol.parse(msg);

        const oldProtocol = newOldProtocol();
        const oldMsg = await oldProtocol.parse(msg);

        expect(compareMessages(newMsg, oldMsg)).toBe(true);
    });

    it('should parse buffer name (buf) identically', async () => {
        const msg = buildMessage('2', [{ type: 'buf', content: '#general' }]);

        const newProtocol = new NewProtocol();
        const newMsg = await newProtocol.parse(msg);

        const oldProtocol = newOldProtocol();
        const oldMsg = await oldProtocol.parse(msg);

        expect(compareMessages(newMsg, oldMsg)).toBe(true);
        expect((newMsg.objects[0]!.content as string)).toBe((oldObjects(oldMsg)[0]?.content as string));
    });

    it('should parse str type identically', async () => {
        const formattedText = '\x0302Bold\x03 Normal';
        const msg = buildMessage('3', [
            { type: 'str', content: formattedText },
        ]);

        const newProtocol = new NewProtocol();
        const newMsg = await newProtocol.parse(msg);

        const oldProtocol = newOldProtocol();
        const oldMsg = await oldProtocol.parse(msg);

        expect(compareMessages(newMsg, oldMsg)).toBe(true);
    });

    it('should parse multiple objects in one message identically', async () => {
        const msg = buildMessage('8', [
            { type: 'buf', content: '#multi' },
            { type: 'str', content: 'Hello world' },
            { type: 'ptr', content: 'deadbeef' },
            { type: 'int', content: 42 },
            { type: 'chr', content: 35 },
        ]);

        const newProtocol = new NewProtocol();
        const newMsg = await newProtocol.parse(msg);

        const oldProtocol = newOldProtocol();
        const oldMsg = await oldProtocol.parse(msg);

        expect(compareMessages(newMsg, oldMsg)).toBe(true);
    });

    it('should parse empty string values identically', async () => {
        const msg = buildMessage('9', [
            { type: 'str', content: '' },
            { type: 'buf', content: '' },
            { type: 'ptr', content: '' },
        ]);

        const newProtocol = new NewProtocol();
        const newMsg = await newProtocol.parse(msg);

        const oldProtocol = newOldProtocol();
        const oldMsg = await oldProtocol.parse(msg);

        expect(compareMessages(newMsg, oldMsg)).toBe(true);
    });

    it('should parse UTF-8 content identically', async () => {
        const utf8Text = 'Hello 世界 🌍 café résumé';
        const msg = buildMessage('10', [
            { type: 'str', content: utf8Text },
            { type: 'buf', content: '#日本語' },
            { type: 'ptr', content: 'тест' },
        ]);

        const newProtocol = new NewProtocol();
        const newMsg = await newProtocol.parse(msg);

        const oldProtocol = newOldProtocol();
        const oldMsg = await oldProtocol.parse(msg);

        expect(compareMessages(newMsg, oldMsg)).toBe(true);
        expect((newMsg.objects[0]!.content as string)).toBe(utf8Text);
        expect((oldObjects(oldMsg)[0]?.content as string)).toBe(utf8Text);
    });

    it('should handle large buffer names identically', async () => {
        const longName = '#' + 'a'.repeat(500);
        const msg = buildMessage('13', [
            { type: 'buf', content: longName },
            { type: 'str', content: longName },
        ]);

        const newProtocol = new NewProtocol();
        const newMsg = await newProtocol.parse(msg);

        const oldProtocol = newOldProtocol();
        const oldMsg = await oldProtocol.parse(msg);

        expect(compareMessages(newMsg, oldMsg)).toBe(true);
    });

    it('should parse time values identically', async () => {
        const timestamps = [0, 1700000000, 1718000000, 2147483647];

        for (const ts of timestamps) {
            const msg = buildMessage(`time-${ts}`, [
                { type: 'tim', content: ts },
            ]);

            const newProtocol = new NewProtocol();
            const newMsg = await newProtocol.parse(msg);

            const oldProtocol = newOldProtocol();
            const oldMsg = await oldProtocol.parse(msg);

            expect(compareMessages(newMsg, oldMsg)).toBe(true);
            expect((newMsg.objects[0]!.content as Date).getTime()).toBe(ts * 1000);
            expect((oldObjects(oldMsg)[0]?.content as Date).getTime()).toBe(ts * 1000);
        }
    });

    it('should parse pointer values identically', async () => {
        const pointers = ['', 'abc123', 'deadbeef', '0'];

        for (const ptr of pointers) {
            const msg = buildMessage(`ptr-${ptr || 'empty'}`, [{ type: 'ptr', content: ptr }]);

            const newProtocol = new NewProtocol();
            const newMsg = await newProtocol.parse(msg);

            const oldProtocol = newOldProtocol();
            const oldMsg = await oldProtocol.parse(msg);

            expect(compareMessages(newMsg, oldMsg)).toBe(true);
            expect((newMsg.objects[0]!.content as string)).toBe(ptr);
            expect((oldObjects(oldMsg)[0]?.content as string)).toBe(ptr);
        }
    });

    it('should parse char values identically', async () => {
        const chars = [0, 35, 42, 127, 255];

        for (const ch of chars) {
            const msg = buildMessage(`chr-${ch}`, [{ type: 'chr', content: ch }]);

            const newProtocol = new NewProtocol();
            const newMsg = await newProtocol.parse(msg);

            const oldProtocol = newOldProtocol();
            const oldMsg = await oldProtocol.parse(msg);

            expect(compareMessages(newMsg, oldMsg)).toBe(true);
            expect((newMsg.objects[0]!.content as number)).toBe(ch);
            expect((oldObjects(oldMsg)[0]?.content as number)).toBe(ch);
        }
    });

    it('should parse integer values identically', async () => {
        const ints = [0, 1, 255, 65535, 16777215, 2147483647];

        for (const n of ints) {
            const msg = buildMessage(`int-${n}`, [{ type: 'int', content: n }]);

            const newProtocol = new NewProtocol();
            const newMsg = await newProtocol.parse(msg);

            const oldProtocol = newOldProtocol();
            const oldMsg = await oldProtocol.parse(msg);

            expect(compareMessages(newMsg, oldMsg)).toBe(true);
            expect((newMsg.objects[0]!.content as number)).toBe(n);
            expect((oldObjects(oldMsg)[0]?.content as number)).toBe(n);
        }
    });

    it('should parse array of strings identically', async () => {
        const msg = buildMessage('6', [{ type: 'arr', content: ['item1', 'item2', 'item3'] }]);

        const newProtocol = new NewProtocol();
        const newMsg = await newProtocol.parse(msg);

        const oldProtocol = newOldProtocol();
        const oldMsg = await oldProtocol.parse(msg);

        expect(compareMessages(newMsg, oldMsg)).toBe(true);
    });

    it('should parse hash table with int values identically', async () => {
        const msg = buildMessage('7', [{
            type: 'htb',
            content: {
                typeKeys: 'str',
                typeValues: 'int',
                items: [
                    ['count', 42],
                    ['active', 1],
                    ['flags', 0],
                ],
            },
        }]);

        const newProtocol = new NewProtocol();
        const newMsg = await newProtocol.parse(msg);

        const oldProtocol = newOldProtocol();
        const oldMsg = await oldProtocol.parse(msg);

        expect(compareMessages(newMsg, oldMsg)).toBe(true);
    });

    it('should parse hash table with string values identically', async () => {
        const msg = buildMessage('htb-str', [{
            type: 'htb',
            content: {
                typeKeys: 'str',
                typeValues: 'str',
                items: [
                    ['key1', 'value1'],
                    ['key2', 'value with spaces'],
                    ['emoji', '🎉'],
                ],
            },
        }]);

        const newProtocol = new NewProtocol();
        const newMsg = await newProtocol.parse(msg);

        const oldProtocol = newOldProtocol();
        const oldMsg = await oldProtocol.parse(msg);

        expect(compareMessages(newMsg, oldMsg)).toBe(true);
    });

    it('should parse callback ID identically', async () => {
        const ids = ['1', 'abc', 'init', 'nicklist_0', ''];

        for (const id of ids) {
            const msg = buildMessage(id, [{ type: 'buf', content: '#test' }]);

            const newProtocol = new NewProtocol();
            const newMsg = await newProtocol.parse(msg);

            const oldProtocol = newOldProtocol();
            const oldMsg = await oldProtocol.parse(msg);

            expect(newMsg.id).toBe(oldMsg.id as string);
            expect(newMsg.id).toBe(id);
        }
    });

    it('should parse header correctly', async () => {
        const msg = buildMessage('hdr-test', [
            { type: 'buf', content: '#test' },
            { type: 'str', content: 'hello' },
        ]);

        const newProtocol = new NewProtocol();
        const newMsg = await newProtocol.parse(msg);

        const oldProtocol = newOldProtocol();
        const oldMsg = await oldProtocol.parse(msg);

        const newHeader = newMsg.header as { length: number; compression: number };
        const oldHeader = oldMsg.header as { length: number; compression: number };

        expect(newHeader.length).toBe(oldHeader.length);
        expect(newHeader.compression).toBe(oldHeader.compression);
        expect(newHeader.compression).toBe(0);
    });
});
