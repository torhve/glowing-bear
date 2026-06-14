import { describe, it, expect } from 'vitest';
import { Protocol } from '$lib/weechat';

describe('Protocol static methods', () => {
    it('formatHandshake produces correct format', () => {
        const result = Protocol.formatHandshake({
            password_hash_algo: 'pbkdf2+sha512',
            compression: 'zlib'
        });
        expect(result).toContain('handshake');
        expect(result).toContain('password_hash_algo=pbkdf2+sha512');
        expect(result).toContain('compression=zlib');
    });

    it('formatHandshake with plain password', () => {
        const result = Protocol.formatHandshake({
            password_hash_algo: 'plain',
            compression: 'off'
        });
        expect(result).toContain('password_hash_algo=plain');
        expect(result).toContain('compression=off');
    });

    it('formatInit produces correct format', () => {
        const result = Protocol.formatInit('plain:testpassword', null);
        expect(result).toContain('init');
        expect(result).toContain('plain:testpassword');
    });

    it('formatInit with PBKDF2', () => {
        const result = Protocol.formatInit('pbkdf2+sha512:salt:1000:hash', null);
        expect(result).toContain('init');
        expect(result).toContain('pbkdf2+sha512:salt:1000:hash');
    });

    it('formatHdata produces correct format', () => {
        const result = Protocol.formatHdata({
            path: 'buffer:gui_buffers(*)',
            keys: ['local_variables,notify,number']
        });
        expect(result).toContain('hdata');
        expect(result).toContain('buffer:gui_buffers(*)');
    });

    it('formatInfo produces correct format', () => {
        const result = Protocol.formatInfo({ name: 'version' });
        expect(result).toContain('info');
        expect(result).toContain('version');
    });

    it('formatSync produces correct format', () => {
        const result = Protocol.formatSync({});
        expect(result).toContain('sync');
    });

    it('formatInput produces correct format', () => {
        const result = Protocol.formatInput({
            buffer: '0x12345',
            data: 'hello world'
        });
        expect(result).toContain('input');
        expect(result).toContain('0x12345');
        expect(result).toContain('hello world');
    });

    it('formatQuit produces correct format', () => {
        const result = Protocol.formatQuit();
        expect(result).toContain('quit');
    });

    it('formatNicklist produces correct format', () => {
        const result = Protocol.formatNicklist({ buffer: '0x12345' });
        expect(result).toContain('nicklist');
        expect(result).toContain('0x12345');
    });

    it('formatInfolist produces correct format', () => {
        const result = Protocol.formatInfolist({
            name: 'option',
            pointer: 0,
            args: 'weechat.look.buffer_time_format'
        });
        expect(result).toContain('infolist');
        expect(result).toContain('option');
    });

    it('formatLocalvarSet produces correct format for pinning', () => {
        const result = Protocol.formatLocalvarSet({
            buffer: '0x12345',
            name: 'pinned',
            value: 'true'
        });
        expect(result).toContain('input');
        expect(result).toContain('0x12345');
        expect(result).toContain('/buffer set localvar_set_pinned true');
    });

    it('formatLocalvarSet produces correct format for unpining', () => {
        const result = Protocol.formatLocalvarSet({
            buffer: '0x67890',
            name: 'pinned',
            value: 'false'
        });
        expect(result).toContain('input');
        expect(result).toContain('0x67890');
        expect(result).toContain('/buffer set localvar_set_pinned false');
    });
});

describe('Protocol instance methods', () => {
    it('setId adds ID prefix to command', () => {
        const protocol = new Protocol();
        const result = protocol.setId(42, 'test command');
        expect(result).toBe('(42) test command');
    });

    it('setId with different IDs', () => {
        const protocol = new Protocol();
        expect(protocol.setId(1, 'cmd1')).toBe('(1) cmd1');
        expect(protocol.setId(999, 'cmd2')).toBe('(999) cmd2');
    });
});
