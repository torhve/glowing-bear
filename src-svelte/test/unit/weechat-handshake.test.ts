import { describe, it, expect } from 'vitest';
import { Protocol } from '$lib/weechat';
import { buildMessage } from './buildMessage';

describe('Protocol handshake parsing', () => {
    it('parses handshake response with plain password method', async () => {
        const binary = buildMessage('cbid1', [
            { type: 'inf', content: { key: 'password_hash_algo', value: 'plain' } }
        ]);
        const protocol = new Protocol();
        const result = await protocol.parse(binary);
        expect(result.id).toBe('cbid1');
        expect(result.objects).toHaveLength(1);
        expect(result.objects[0]!.type).toBe('inf');
        expect(result.objects[0]!.content).toEqual({ key: 'password_hash_algo', value: 'plain' });
    });

    it('parses handshake response with PBKDF2 password method', async () => {
        const binary = buildMessage('cbid1', [
            { type: 'inf', content: { key: 'password_hash_algo', value: 'pbkdf2+sha512' } }
        ]);
        const protocol = new Protocol();
        const result = await protocol.parse(binary);
        expect(result.objects[0]!.content.key).toBe('password_hash_algo');
        expect((result.objects[0]!.content as { value: string }).value).toBe('pbkdf2+sha512');
    });

    it('parses handshake with multiple info items (algo + iterations + nonce)', async () => {
        const binary = buildMessage('cbid1', [
            { type: 'inf', content: { key: 'password_hash_algo', value: 'pbkdf2+sha512' } },
            { type: 'int', content: 1000 },
            { type: 'str', content: 'abc123def456' }
        ]);
        const protocol = new Protocol();
        const result = await protocol.parse(binary);
        expect(result.objects).toHaveLength(3);
        expect(result.objects[0]!.type).toBe('inf');
        expect(result.objects[1]!.type).toBe('int');
        expect((result.objects[1]!.content as number)).toBe(1000);
        expect(result.objects[2]!.type).toBe('str');
        expect(result.objects[2]!.content).toBe('abc123def456');
    });
});

describe('Protocol version info parsing', () => {
    it('parses version info with short_version and full_version', async () => {
        const binary = buildMessage('cbid2', [
            { type: 'inf', content: { key: 'short_version', value: '3.10.1' } },
            { type: 'inf', content: { key: 'full_version', value: 'WeeChat 3.10.1' } }
        ]);
        const protocol = new Protocol();
        const result = await protocol.parse(binary);
        expect(result.id).toBe('cbid2');
        expect(result.objects).toHaveLength(2);
        expect((result.objects[0]!.content as { key: string }).key).toBe('short_version');
        expect((result.objects[1]!.content as { value: string }).value).toBe('WeeChat 3.10.1');
    });
});
