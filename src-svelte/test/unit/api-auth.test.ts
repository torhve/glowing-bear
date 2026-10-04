import { describe, it, expect, afterEach, vi } from 'vitest';
import { createHash, pbkdf2Sync, webcrypto } from 'node:crypto';

// jsdom provides no crypto.subtle; install Node's Web Crypto implementation
// so these tests exercise the secure-context (browser) path. The fallback
// test below explicitly removes subtle to exercise the non-secure path.
if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
}
import {
    generateCredential,
    httpAuthHeader,
    wsSubprotocols,
    supportedAlgorithms,
    assertTotpSupported,
} from '#lib/api/api-auth.ts';

// Cross-verification: our Web Crypto / fallback implementations must match
// node:crypto (independent implementation) for identical inputs. The same
// recipes are verified against a live WeeChat server by
// test/fixtures/api-dossier/probes/probe-auth-algorithms.mjs.

const TS = 1791129600;

describe('api-auth credentials', () => {
    it('plain payload', async () => {
        expect(await generateCredential('plain', 'hunter2', 0)).toBe('plain:hunter2');
    });

    it('sha256 matches node:crypto: SHA-256(timestamp + password)', async () => {
        const cred = await generateCredential('sha256', 'hunter2', 0, TS);
        const expected = createHash('sha256').update(`${TS}hunter2`).digest('hex');
        expect(cred).toBe(`hash:sha256:${TS}:${expected}`);
    });

    it('sha512 matches node:crypto', async () => {
        const cred = await generateCredential('sha512', 'hunter2', 0, TS);
        const expected = createHash('sha512').update(`${TS}hunter2`).digest('hex');
        expect(cred).toBe(`hash:sha512:${TS}:${expected}`);
    });

    it('pbkdf2+sha256 matches node:crypto (salt = decimal timestamp string)', async () => {
        const cred = await generateCredential('pbkdf2+sha256', 'hunter2', 100000, TS);
        const expected = pbkdf2Sync('hunter2', String(TS), 100000, 32, 'sha256').toString('hex');
        expect(cred).toBe(`hash:pbkdf2+sha256:${TS}:100000:${expected}`);
    });

    it('pbkdf2+sha512 matches node:crypto with 64-byte key', async () => {
        const cred = await generateCredential('pbkdf2+sha512', 'hunter2', 1000, TS);
        const expected = pbkdf2Sync('hunter2', String(TS), 1000, 64, 'sha512').toString('hex');
        expect(cred).toBe(`hash:pbkdf2+sha512:${TS}:1000:${expected}`);
    });

    it('handles non-ASCII passwords deterministically', async () => {
        const cred = await generateCredential('sha256', 'löwe🦁', 0, TS);
        const expected = createHash('sha256').update(`${TS}löwe🦁`).digest('hex');
        expect(cred).toBe(`hash:sha256:${TS}:${expected}`);
    });

    it('pure-JS fallback path matches Web Crypto for pbkdf2+sha256', async () => {
        const subtle = globalThis.crypto.subtle;
        // Simulate a non-secure context: no crypto.subtle.
        Object.defineProperty(globalThis.crypto, 'subtle', { value: undefined, configurable: true });
        try {
            expect(supportedAlgorithms()).toEqual(['pbkdf2+sha256', 'sha256', 'plain']);
            const cred = await generateCredential('pbkdf2+sha256', 'hunter2', 1000, TS);
            const expected = pbkdf2Sync('hunter2', String(TS), 1000, 32, 'sha256').toString('hex');
            expect(cred).toBe(`hash:pbkdf2+sha256:${TS}:1000:${expected}`);
            const shaCred = await generateCredential('sha256', 'hunter2', 0, TS);
            const shaExpected = createHash('sha256').update(`${TS}hunter2`).digest('hex');
            expect(shaCred).toBe(`hash:sha256:${TS}:${shaExpected}`);
            await expect(generateCredential('sha512', 'hunter2', 0, TS)).rejects.toThrow(/Web Crypto/);
            await expect(generateCredential('pbkdf2+sha512', 'hunter2', 1000, TS)).rejects.toThrow(/Web Crypto/);
        } finally {
            Object.defineProperty(globalThis.crypto, 'subtle', { value: subtle, configurable: true });
        }
    });

    it('rejects invalid PBKDF2 iterations in the fallback path', async () => {
        const subtle = globalThis.crypto.subtle;
        Object.defineProperty(globalThis.crypto, 'subtle', { value: undefined, configurable: true });
        try {
            await expect(generateCredential('pbkdf2+sha256', 'pw', 0, TS)).rejects.toThrow(/iteration/);
        } finally {
            Object.defineProperty(globalThis.crypto, 'subtle', { value: subtle, configurable: true });
        }
    });
});

describe('transport encodings', () => {
    it('HTTP header is standard base64 of the UTF-8 payload', async () => {
        const cred = await generateCredential('plain', 'löwe🦁', 0);
        const header = httpAuthHeader(cred);
        const expected = 'Basic ' + Buffer.from(cred, 'utf8').toString('base64');
        expect(header).toBe(expected);
    });

    it('WS subprotocols carry an unpadded base64url credential', async () => {
        const cred = await generateCredential('plain', 'löwe🦁??', 0);
        const subs = wsSubprotocols(cred);
        expect(subs[0]).toBe('api.weechat');
        const label = subs[1]!;
        expect(label.startsWith('base64url.bearer.authorization.weechat.')).toBe(true);
        const b64 = label.slice('base64url.bearer.authorization.weechat.'.length);
        expect(b64).not.toContain('+');
        expect(b64).not.toContain('/');
        expect(b64).not.toContain('=');
        const decoded = Buffer.from(b64, 'base64url').toString('utf8');
        expect(decoded).toBe(cred);
    });
});

describe('TOTP gate (G3)', () => {
    it('reports TOTP relays as unsupported instead of half-supporting them', () => {
        expect(() => assertTotpSupported(true)).toThrow(/TOTP/);
        expect(() => assertTotpSupported(false)).not.toThrow();
    });
});

afterEach(() => {
    vi.restoreAllMocks();
});
