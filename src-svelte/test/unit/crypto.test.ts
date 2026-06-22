import { describe, it, expect } from 'vitest';
import { sha256, pbkdf2, hmacSha256, toHexString } from '$lib/utils/crypto';

describe('sha256', () => {
    it('hashes empty string', () => {
        const input = new TextEncoder().encode('');
        const hash = sha256(input);
        // NIST FIPS 180-4 test vector
        expect(toHexString(hash)).toBe(
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
        );
    });

    it('hashes "abc"', () => {
        const input = new TextEncoder().encode('abc');
        const hash = sha256(input);
        // NIST FIPS 180-4 test vector
        expect(toHexString(hash)).toBe(
            'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
        );
    });

    it('hashes "message digest"', () => {
        const input = new TextEncoder().encode('message digest');
        const hash = sha256(input);
        // NIST FIPS 180-4 test vector
        expect(toHexString(hash)).toBe(
            'f7846f55cf23e14eebeab5b4e1550cad5b509e3348fbc4efa3a1413d393cb650'
        );
    });

    it('hashes longer message', () => {
        const input = new TextEncoder().encode(
            'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
        );
        const hash = sha256(input);
        // NIST FIPS 180-4 test vector
        expect(toHexString(hash)).toBe(
            '540363d1071a002997290cd8f4a2bdf3acd0355ffad3b3f25f52aad6ebad936a'
        );
    });

    it('returns correct length output', () => {
        const input = new TextEncoder().encode('test');
        const hash = sha256(input);
        expect(hash.length).toBe(32);
    });

    it('produces deterministic output', () => {
        const input = new TextEncoder().encode('deterministic test');
        const hash1 = sha256(input);
        const hash2 = sha256(input);
        expect(toHexString(hash1)).toBe(toHexString(hash2));
    });

    it('produces different output for different inputs', () => {
        const hash1 = sha256(new TextEncoder().encode('hello'));
        const hash2 = sha256(new TextEncoder().encode('world'));
        expect(toHexString(hash1)).not.toBe(toHexString(hash2));
    });
});

describe('hmacSha256', () => {
    it('HMAC with key="key", message="The quick brown fox jumps over the lazy dog"', () => {
        const key = new TextEncoder().encode('key');
        const message = new TextEncoder().encode('The quick brown fox jumps over the lazy dog');
        const mac = hmacSha256(key, message);
        // RFC 4231 test vector 4
        expect(toHexString(mac)).toBe(
            'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8'
        );
    });

    it('HMAC with single-byte key and short message', () => {
        const key = new TextEncoder().encode('Jefe');
        const message = new TextEncoder().encode('what do ya want for nothing?');
        const mac = hmacSha256(key, message);
        // RFC 4231 test vector 1
        expect(toHexString(mac)).toBe(
            '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843'
        );
    });

    it('HMAC with key longer than block size (64 bytes)', () => {
        // Key is hashed down to 32 bytes first (RFC 2104 §2)
        const key = new TextEncoder().encode('a'.repeat(100));
        const message = new TextEncoder().encode('test');
        const mac1 = hmacSha256(key, message);
        const keyHash = sha256(key);
        const mac2 = hmacSha256(keyHash, message);
        expect(toHexString(mac1)).toBe(toHexString(mac2));
    });
});

describe('pbkdf2', () => {
    it('RFC 6070 test vector 1: password="password", salt="salt", iterations=1, keyLen=24', () => {
        const password = new TextEncoder().encode('password');
        const salt = new TextEncoder().encode('salt');
        const dk = pbkdf2(password, salt, 1, 24);
        // RFC 6070 PBKDF2-HMAC-SHA256 test vector 1
        expect(toHexString(dk)).toBe(
            '120fb6cffcf8b32c43e7225256c4f837a86548c92ccc3548'
        );
    });

    it('RFC 6070 test vector 2: password="password", salt="salt", iterations=2, keyLen=24', () => {
        const password = new TextEncoder().encode('password');
        const salt = new TextEncoder().encode('salt');
        const dk = pbkdf2(password, salt, 2, 24);
        // RFC 6070 PBKDF2-HMAC-SHA256 test vector 2
        expect(toHexString(dk)).toBe(
            'ae4d0c95af6b46d32d0adff928f06dd02a303f8ef3c251df'
        );
    });

    it('RFC 6070 test vector 3: password="password", salt="salt", iterations=4096, keyLen=24', () => {
        const password = new TextEncoder().encode('password');
        const salt = new TextEncoder().encode('salt');
        const dk = pbkdf2(password, salt, 4096, 24);
        // RFC 6070 PBKDF2-HMAC-SHA256 test vector 3
        expect(toHexString(dk)).toBe(
            'c5e478d59288c841aa530db6845c4c8d962893a001ce4e11'
        );
    });

    it('RFC 6070 test vector 6: password="password PASSWORD", salt="salt SALT", iterations=4096, keyLen=32', () => {
        const password = new TextEncoder().encode('password PASSWORD');
        const salt = new TextEncoder().encode('salt SALT');
        const dk = pbkdf2(password, salt, 4096, 32);
        // RFC 6070 PBKDF2-HMAC-SHA256 test vector 6
        expect(toHexString(dk)).toBe(
            'b4fd29ec6ad42fb07064c01e37efee6bcb421ad9952a0f90d2216ad983f336ba'
        );
    });

    it('produces correct length output', () => {
        const password = new TextEncoder().encode('test');
        const salt = new TextEncoder().encode('salt');
        const dk = pbkdf2(password, salt, 1000, 64);
        expect(dk.length).toBe(64);
    });

    it('produces different output for different passwords', () => {
        const salt = new TextEncoder().encode('salt');
        const dk1 = pbkdf2(new TextEncoder().encode('pass1'), salt, 1000, 32);
        const dk2 = pbkdf2(new TextEncoder().encode('pass2'), salt, 1000, 32);
        expect(toHexString(dk1)).not.toBe(toHexString(dk2));
    });

    it('produces different output for different salts', () => {
        const password = new TextEncoder().encode('password');
        const dk1 = pbkdf2(password, new TextEncoder().encode('salt1'), 1000, 32);
        const dk2 = pbkdf2(password, new TextEncoder().encode('salt2'), 1000, 32);
        expect(toHexString(dk1)).not.toBe(toHexString(dk2));
    });

    it('handles large iteration count', () => {
        const password = new TextEncoder().encode('test');
        const salt = new TextEncoder().encode('salt');
        // Should complete in reasonable time (< 5s)
        const start = Date.now();
        const dk = pbkdf2(password, salt, 100000, 32);
        const elapsed = Date.now() - start;
        expect(dk.length).toBe(32);
        expect(elapsed).toBeLessThan(5000);
    });
});

describe('toHexString', () => {
    it('converts empty array', () => {
        expect(toHexString(new Uint8Array([]))).toBe('');
    });

    it('converts single byte', () => {
        expect(toHexString(new Uint8Array([0x00]))).toBe('00');
        expect(toHexString(new Uint8Array([0xff]))).toBe('ff');
        expect(toHexString(new Uint8Array([0x0a]))).toBe('0a');
    });

    it('converts multiple bytes', () => {
        expect(toHexString(new Uint8Array([0xde, 0xad, 0xbe, 0xef]))).toBe('deadbeef');
    });
});
