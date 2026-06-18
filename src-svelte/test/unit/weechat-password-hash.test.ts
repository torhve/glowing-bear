import { describe, it, expect, beforeEach } from 'vitest';
import { Protocol } from '$lib/weechat';

function expectHandshakeContains(result: string, expected: Record<string, string>) {
    expect(result).toMatch(/^handshake\s/);
    for (const [key, value] of Object.entries(expected)) {
        expect(result).toContain(`${key}=${value}`);
    }
}

describe('formatHandshake for all password hash algorithms', () => {
    it('produces correct format for plain algorithm', () => {
        const result = Protocol.formatHandshake({
            password_hash_algo: 'plain',
            compression: 'off'
        });
        expectHandshakeContains(result, { password_hash_algo: 'plain', compression: 'off' });
    });

    it('produces correct format for sha256 algorithm', () => {
        const result = Protocol.formatHandshake({
            password_hash_algo: 'sha256',
            compression: 'zlib'
        });
        expectHandshakeContains(result, { password_hash_algo: 'sha256', compression: 'zlib' });
    });

    it('produces correct format for sha512 algorithm', () => {
        const result = Protocol.formatHandshake({
            password_hash_algo: 'sha512',
            compression: 'zlib'
        });
        expectHandshakeContains(result, { password_hash_algo: 'sha512', compression: 'zlib' });
    });

    it('produces correct format for pbkdf2+sha256 algorithm', () => {
        const result = Protocol.formatHandshake({
            password_hash_algo: 'pbkdf2+sha256',
            compression: 'zlib'
        });
        expectHandshakeContains(result, { password_hash_algo: 'pbkdf2+sha256', compression: 'zlib' });
    });

    it('produces correct format for pbkdf2+sha512 algorithm', () => {
        const result = Protocol.formatHandshake({
            password_hash_algo: 'pbkdf2+sha512',
            compression: 'zlib'
        });
        expectHandshakeContains(result, { password_hash_algo: 'pbkdf2+sha512', compression: 'zlib' });
    });

    it('uses defaults when no opts provided', () => {
        const result = Protocol.formatHandshake({});
        expectHandshakeContains(result, { password_hash_algo: 'pbkdf2+sha512', compression: 'zlib' });
    });

    it('accepts colon-separated algorithm list', () => {
        const result = Protocol.formatHandshake({
            password_hash_algo: 'pbkdf2+sha512:pbkdf2+sha256:sha512:sha256:plain',
            compression: 'off'
        });
        expectHandshakeContains(result, { password_hash_algo: 'pbkdf2+sha512:pbkdf2+sha256:sha512:sha256:plain', compression: 'off' });
    });
});

describe('formatInit for all password hash algorithms', () => {
    it('formats plain password correctly', () => {
        const result = Protocol.formatInit('plain:testpassword', null);
        expect(result).toBe('init password_hash=plain:testpassword\n');
    });

    it('formats sha256 hash correctly', () => {
        const result = Protocol.formatInit(
            'sha256:85b1ee00695a5b254e14f4885538df0da4b73207f5aae4:2c6ed12eb0109fca3aedc03bf03d9b6e804cd60a23e1731fd17794da423e21db',
            null
        );
        expect(result).toBe('init password_hash=sha256:85b1ee00695a5b254e14f4885538df0da4b73207f5aae4:2c6ed12eb0109fca3aedc03bf03d9b6e804cd60a23e1731fd17794da423e21db\n');
    });

    it('formats sha512 hash correctly', () => {
        const result = Protocol.formatInit(
            'sha512:85b1ee00695a5b254e14f4885538df0da4b73207f5aae4:0a1f0172a542916bd86e0cbceebc1c38ed791f6be246120452825f0d74ef1078c79e9812de8b0ab3dfaf598b6ca14522374ec6a8653a46df3f96a6b54ac1f0f8',
            null
        );
        expect(result).toBe('init password_hash=sha512:85b1ee00695a5b254e14f4885538df0da4b73207f5aae4:0a1f0172a542916bd86e0cbceebc1c38ed791f6be246120452825f0d74ef1078c79e9812de8b0ab3dfaf598b6ca14522374ec6a8653a46df3f96a6b54ac1f0f8\n');
    });

    it('formats pbkdf2+sha256 hash correctly', () => {
        const result = Protocol.formatInit(
            'pbkdf2+sha256:85b1ee00695a5b254e14f4885538df0da4b73207f5aae4:100000:ba7facc3edb89cd06ae810e29ced85980ff36de2bb596fcf513aaab626876440',
            null
        );
        expect(result).toBe('init password_hash=pbkdf2+sha256:85b1ee00695a5b254e14f4885538df0da4b73207f5aae4:100000:ba7facc3edb89cd06ae810e29ced85980ff36de2bb596fcf513aaab626876440\n');
    });

    it('formats pbkdf2+sha512 hash correctly', () => {
        const result = Protocol.formatInit(
            'pbkdf2+sha512:85b1ee00695a5b254e14f4885538df0da4b73207f5aae4:100000:ba7facc3edb89cd06ae810e29ced85980ff36de2bb596fcf513aaab626876440',
            null
        );
        expect(result).toBe('init password_hash=pbkdf2+sha512:85b1ee00695a5b254e14f4885538df0da4b73207f5aae4:100000:ba7facc3edb89cd06ae810e29ced85980ff36de2bb596fcf513aaab626876440\n');
    });

    it('formats init with totp for sha256 algorithm', () => {
        const result = Protocol.formatInit(
            'sha256:85b1ee00695a5b254e14f4885538df0da4b73207f5aae4:2c6ed12eb0109fca3aedc03bf03d9b6e804cd60a23e1731fd17794da423e21db',
            '123456'
        );
        expect(result).toBe('init totp=123456,password_hash=sha256:85b1ee00695a5b254e14f4885538df0da4b73207f5aae4:2c6ed12eb0109fca3aedc03bf03d9b6e804cd60a23e1731fd17794da423e21db\n');
    });

    it('formats init with totp for pbkdf2+sha256 algorithm', () => {
        const result = Protocol.formatInit(
            'pbkdf2+sha256:85b1ee00695a5b254e14f4885538df0da4b73207f5aae4:100000:ba7facc3edb89cd06ae810e29ced85980ff36de2bb596fcf513aaab626876440',
            '654321'
        );
        expect(result).toBe('init totp=654321,password_hash=pbkdf2+sha256:85b1ee00695a5b254e14f4885538df0da4b73207f5aae4:100000:ba7facc3edb89cd06ae810e29ced85980ff36de2bb596fcf513aaab626876440\n');
    });

    it('handles null password_hash and totp', () => {
        const result = Protocol.formatInit(null, null);
        expect(result).toBe('init \n');
    });
});

describe('formatHandshake parity: new vs old parser', () => {
    let OldProtocol: typeof Protocol | null = null;

    beforeEach(async () => {
        if (!OldProtocol) {
            try {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const mod = await import('../fixtures/weechat-old.js');
                OldProtocol = (mod as any).Protocol;
            } catch {
                OldProtocol = null;
            }
        }
    });

    it('should format handshake plain identically', async () => {
        expect(OldProtocol).not.toBeNull();
        const newResult = Protocol.formatHandshake({ password_hash_algo: 'plain', compression: 'off' });
        const oldResult = OldProtocol!.formatHandshake({ password_hash_algo: 'plain', compression: 'off' });
        expect(newResult).toBe(oldResult);
    });

    it('should format handshake sha256 identically', async () => {
        expect(OldProtocol).not.toBeNull();
        const newResult = Protocol.formatHandshake({ password_hash_algo: 'sha256', compression: 'zlib' });
        const oldResult = OldProtocol!.formatHandshake({ password_hash_algo: 'sha256', compression: 'zlib' });
        expect(newResult).toBe(oldResult);
    });

    it('should format handshake with defaults identically', async () => {
        expect(OldProtocol).not.toBeNull();
        const newResult = Protocol.formatHandshake({});
        const oldResult = OldProtocol!.formatHandshake({});
        expect(newResult).toBe(oldResult);
    });
});

describe('formatInit parity: new vs old parser', () => {
    let OldProtocol: typeof Protocol | null = null;

    beforeEach(async () => {
        if (!OldProtocol) {
            try {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const mod = await import('../fixtures/weechat-old.js');
                OldProtocol = (mod as any).Protocol;
            } catch {
                OldProtocol = null;
            }
        }
    });

    it('should format init plain identically', async () => {
        expect(OldProtocol).not.toBeNull();
        const newResult = Protocol.formatInit('plain:testpassword', null);
        const oldResult = OldProtocol!.formatInit('plain:testpassword', null);
        expect(newResult).toBe(oldResult);
    });

    it('should format init sha256 hash identically', async () => {
        expect(OldProtocol).not.toBeNull();
        const hash = 'sha256:85b1ee00695a5b254e14f4885538df0da4b73207f5aae4:2c6ed12eb0109fca3aedc03bf03d9b6e804cd60a23e1731fd17794da423e21db';
        const newResult = Protocol.formatInit(hash, null);
        const oldResult = OldProtocol!.formatInit(hash, null);
        expect(newResult).toBe(oldResult);
    });

    it('should format init with totp identically', async () => {
        expect(OldProtocol).not.toBeNull();
        const hash = 'pbkdf2+sha512:salt:1000:hash';
        const newResult = Protocol.formatInit(hash, '123456');
        const oldResult = OldProtocol!.formatInit(hash, '123456');
        expect(newResult).toBe(oldResult);
    });

    it('should handle null password_hash and totp identically', async () => {
        expect(OldProtocol).not.toBeNull();
        const newResult = Protocol.formatInit(null, null);
        const oldResult = OldProtocol!.formatInit(null, null);
        expect(newResult).toBe(oldResult);
    });
});
