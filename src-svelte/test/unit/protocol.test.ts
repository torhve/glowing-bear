import { describe, it, expect } from 'vitest';
import { Protocol } from '$lib/weechat';

describe('Protocol static methods', () => {
    it('formatHandshake produces correct format', () => {
        const result = Protocol.formatHandshake({
            password_hash_algo: 'pbkdf2+sha512',
            compression: 'zlib'
        });
        expect(result).toBe('handshake password_hash_algo=pbkdf2+sha512,compression=zlib\n');
    });

    it('formatHandshake with plain password', () => {
        const result = Protocol.formatHandshake({
            password_hash_algo: 'plain',
            compression: 'off'
        });
        expect(result).toBe('handshake password_hash_algo=plain,compression=off\n');
    });

    it('formatHandshake uses defaults when no opts provided', () => {
        const result = Protocol.formatHandshake({});
        expect(result).toBe('handshake password_hash_algo=pbkdf2+sha512,compression=zlib\n');
    });

    it('formatInit produces correct format for plain password', () => {
        const result = Protocol.formatInit('plain:testpassword', null);
        expect(result).toBe('init password_hash=plain:testpassword\n');
    });

    it('formatInit with PBKDF2 hash', () => {
        const result = Protocol.formatInit('pbkdf2+sha512:salt:1000:hash', null);
        expect(result).toBe('init password_hash=pbkdf2+sha512:salt:1000:hash\n');
    });

    it('formatInit with totp', () => {
        const result = Protocol.formatInit('pbkdf2+sha512:salt:1000:hash', '123456');
        expect(result).toBe('init password_hash=pbkdf2+sha512:salt:1000:hash,totp=123456\n');
    });

    it('formatHdata produces correct format', () => {
        const result = Protocol.formatHdata({
            path: 'buffer:gui_buffers(*)',
            keys: ['local_variables,notify,number']
        });
        expect(result).toBe('hdata buffer:gui_buffers(*) local_variables,notify,number\n');
    });

    it('formatHdata with ID prefix', () => {
        const result = Protocol.formatHdata({
            id: 42,
            path: 'buffer',
            keys: ['name']
        });
        expect(result).toBe('(42) hdata buffer name\n');
    });

    it('formatInfo produces correct format', () => {
        const result = Protocol.formatInfo({ name: 'version' });
        expect(result).toBe('info version\n');
    });

    it('formatInfo with ID prefix', () => {
        const result = Protocol.formatInfo({ id: 1, name: 'weechate_version' });
        expect(result).toBe('(1) info weechate_version\n');
    });

    it('formatSync with empty dict', () => {
        const result = Protocol.formatSync({});
        expect(result).toBe('sync\n');
    });

    it('formatSync with options', () => {
        const result = Protocol.formatSync({ short: null, with_flags: null });
        expect(result).toBe('sync short=null,with_flags=null\n');
    });

    it('formatInput produces correct format', () => {
        const result = Protocol.formatInput({
            buffer: '0x12345',
            data: 'hello world'
        });
        expect(result).toBe('input 0x12345 hello world\n');
    });

    it('formatInput with ID prefix', () => {
        const result = Protocol.formatInput({
            id: 5,
            buffer: '0x12345',
            data: '/join #test'
        });
        expect(result).toBe('(5) input 0x12345 /join #test\n');
    });

    it('formatQuit produces correct format', () => {
        const result = Protocol.formatQuit();
        expect(result).toBe('quit\n');
    });

    it('formatNicklist produces correct format', () => {
        const result = Protocol.formatNicklist({ buffer: '0x12345' });
        expect(result).toBe('nicklist 0x12345\n');
    });

    it('formatInfolist produces correct format', () => {
        const result = Protocol.formatInfolist({
            name: 'option',
            pointer: 0,
            args: 'weechat.look.buffer_time_format'
        });
        expect(result).toBe('infolist option 0 weechat.look.buffer_time_format\n');
    });

    it('formatInfolist without pointer or args', () => {
        const result = Protocol.formatInfolist({ name: 'buffer' });
        expect(result).toBe('infolist buffer\n');
    });

    it('formatLocalvarSet produces correct format for pinning', () => {
        const result = Protocol.formatLocalvarSet({
            buffer: '0x12345',
            name: 'pinned',
            value: 'true'
        });
        expect(result).toBe('input 0x12345 /buffer set localvar_set_pinned true\n');
    });

    it('formatLocalvarSet produces correct format for unpining', () => {
        const result = Protocol.formatLocalvarSet({
            buffer: '0x67890',
            name: 'pinned',
            value: 'false'
        });
        expect(result).toBe('input 0x67890 /buffer set localvar_set_pinned false\n');
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

describe('Protocol formatCompletion', () => {
    it('formatCompletion without ID or data', () => {
        const result = Protocol.formatCompletion({ buffer: '0x12345' });
        expect(result).toBe('completion 0x12345 -1\n');
    });

    it('formatCompletion with position', () => {
        const result = Protocol.formatCompletion({ buffer: '0x67890', position: 5 });
        expect(result).toBe('completion 0x67890 5\n');
    });

    it('formatCompletion with data', () => {
        const result = Protocol.formatCompletion({ buffer: '0xabcde', data: 'hel' });
        expect(result).toBe('completion 0xabcde -1 hel\n');
    });

    it('formatCompletion with all params', () => {
        const result = Protocol.formatCompletion({ id: 42, buffer: '0x12345', position: 3, data: 'foo' });
        expect(result).toBe('(42) completion 0x12345 3 foo\n');
    });
});

describe('Protocol formatDesync', () => {
    it('formatDesync without options', () => {
        const result = Protocol.formatDesync({ buffers: ['0x123', '0x456'] });
        expect(result).toBe('desync 0x123,0x456\n');
    });

    it('formatDesync with options', () => {
        const result = Protocol.formatDesync({ buffers: ['0x123'], options: ['short'] });
        expect(result).toBe('desync 0x123 short\n');
    });

    it('formatDesync with ID prefix', () => {
        const result = Protocol.formatDesync({ id: 7, buffers: ['0xabc'], options: ['with_flags', 'short'] });
        expect(result).toBe('(7) desync 0xabc with_flags,short\n');
    });
});

describe('Protocol formatTest', () => {
    it('formatTest without ID', () => {
        const result = Protocol.formatTest({});
        expect(result).toBe('test\n');
    });

    it('formatTest with ID', () => {
        const result = Protocol.formatTest({ id: 99 });
        expect(result).toBe('(99) test\n');
    });
});

describe('Protocol formatPing', () => {
    it('formatPing without args', () => {
        const result = Protocol.formatPing({});
        expect(result).toBe('ping\n');
    });

    it('formatPing with args', () => {
        const result = Protocol.formatPing({ args: ['arg1', 'arg2'] });
        expect(result).toBe('ping arg1 arg2\n');
    });

    it('formatPing with ID and args', () => {
        const result = Protocol.formatPing({ id: 3, args: ['keepalive'] });
        expect(result).toBe('(3) ping keepalive\n');
    });
});
