// Native TypeScript SHA-256 and PBKDF2-SHA256 implementations.
// Fallback for environments without crypto.subtle (non-secure context).
// SHA-256 follows FIPS 180-4; PBKDF2 follows RFC 2898 §5.2.

// ── SHA-256 ──────────────────────────────────────────────────────────────────

const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
] as const;

function rotr(x: number, n: number): number {
    return (x >>> n) | (x << (32 - n));
}

function ch(x: number, y: number, z: number): number {
    return (x & y) ^ (~x & z);
}

function maj(x: number, y: number, z: number): number {
    return (x & y) ^ (x & z) ^ (y & z);
}

function bigSigma0(x: number): number {
    return rotr(x, 2) ^ rotr(x, 13) ^ rotr(x, 22);
}

function bigSigma1(x: number): number {
    return rotr(x, 6) ^ rotr(x, 11) ^ rotr(x, 25);
}

function smallSigma0(x: number): number {
    return rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
}

function smallSigma1(x: number): number {
    return rotr(x, 17) ^ rotr(x, 19) ^ (x >>> 10);
}

// Parse a Uint8Array into an array of 32-bit words (big-endian).
function parseMessage(message: Uint8Array): number[] {
    const numWords = Math.ceil((message.length * 8 + 65) / 512) * 16;
    const m: number[] = new Array(numWords).fill(0);

    for (let i = 0; i < message.length; i++) {
        m[i >>> 2]! |= message[i]! << (24 - (i % 4) * 8);
    }

    // Append 0x80 padding byte (FIPS 180-4 §5.1.1)
    m[message.length >>> 2]! |= 0x80 << (24 - (message.length % 4) * 8);

    // Append bit length as 64-bit big-endian (high 32 bits first, then low 32 bits)
    const bitLen = message.length * 8;
    m[(numWords - 2) >>> 0]! = (bitLen / 0x100000000) | 0;
    m[(numWords - 1) >>> 0]! = bitLen >>> 0;

    return m;
}

export function sha256(message: Uint8Array): Uint8Array {
    let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
    let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

    const m = parseMessage(message);

    for (let i = 0; i < m.length; i += 16) {
        // Message schedule W[0..63]
        const w = new Array(64).fill(0) as number[];

        for (let j = 0; j < 16; j++) {
            w[j] = m[i + j]!;
        }

        for (let j = 16; j < 64; j++) {
            w[j] = (smallSigma1(w[j - 2]!) + w[j - 7]! + smallSigma0(w[j - 15]!) + w[j - 16]!) | 0;
        }

        let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, hh = h7;

        for (let j = 0; j < 64; j++) {
            const t1 = (hh + bigSigma1(e) + ch(e, f, g) + K[j]! + w[j]!) | 0;
            const t2 = (bigSigma0(a) + maj(a, b, c)) | 0;
            hh = g;
            g = f;
            f = e;
            e = (d + t1) | 0;
            d = c;
            c = b;
            b = a;
            a = (t1 + t2) | 0;
        }

        h0 = (h0 + a) | 0;
        h1 = (h1 + b) | 0;
        h2 = (h2 + c) | 0;
        h3 = (h3 + d) | 0;
        h4 = (h4 + e) | 0;
        h5 = (h5 + f) | 0;
        h6 = (h6 + g) | 0;
        h7 = (h7 + hh) | 0;
    }

    const output = new Uint8Array(32);
    output[0] = (h0 >>> 24) & 0xff; output[1] = (h0 >>> 16) & 0xff;
    output[2] = (h0 >>> 8) & 0xff;   output[3] = h0 & 0xff;
    output[4] = (h1 >>> 24) & 0xff; output[5] = (h1 >>> 16) & 0xff;
    output[6] = (h1 >>> 8) & 0xff;   output[7] = h1 & 0xff;
    output[8] = (h2 >>> 24) & 0xff; output[9] = (h2 >>> 16) & 0xff;
    output[10] = (h2 >>> 8) & 0xff;  output[11] = h2 & 0xff;
    output[12] = (h3 >>> 24) & 0xff; output[13] = (h3 >>> 16) & 0xff;
    output[14] = (h3 >>> 8) & 0xff;  output[15] = h3 & 0xff;
    output[16] = (h4 >>> 24) & 0xff; output[17] = (h4 >>> 16) & 0xff;
    output[18] = (h4 >>> 8) & 0xff;  output[19] = h4 & 0xff;
    output[20] = (h5 >>> 24) & 0xff; output[21] = (h5 >>> 16) & 0xff;
    output[22] = (h5 >>> 8) & 0xff;  output[23] = h5 & 0xff;
    output[24] = (h6 >>> 24) & 0xff; output[25] = (h6 >>> 16) & 0xff;
    output[26] = (h6 >>> 8) & 0xff;  output[27] = h6 & 0xff;
    output[28] = (h7 >>> 24) & 0xff; output[29] = (h7 >>> 16) & 0xff;
    output[30] = (h7 >>> 8) & 0xff;  output[31] = h7 & 0xff;

    return output;
}

// ── HMAC-SHA256 ──────────────────────────────────────────────────────────────

export function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
    if (key.length > 64) {
        key = sha256(key);
    }

    if (key.length < 64) {
        const padded = new Uint8Array(64);
        padded.set(key);
        key = padded;
    }

    const oKeyPad = new Uint8Array(64);
    const iKeyPad = new Uint8Array(64);
    for (let i = 0; i < 64; i++) {
        const ki = key[i]!;
        oKeyPad[i] = ki ^ 0x5c;
        iKeyPad[i] = ki ^ 0x36;
    }

    const innerHash = sha256(new Uint8Array([...iKeyPad, ...message]));
    return sha256(new Uint8Array([...oKeyPad, ...innerHash]));
}

// ── PBKDF2-SHA256 ────────────────────────────────────────────────────────────

function uint32ToBytesBE(n: number): Uint8Array {
    return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

export function pbkdf2(password: Uint8Array, salt: Uint8Array, iterations: number, keyLen: number): Uint8Array {
    const hashLen = 32; // SHA-256 output length in bytes
    const blocksNeeded = Math.ceil(keyLen / hashLen);
    const dk = new Uint8Array(keyLen);

    for (let block = 1; block <= blocksNeeded; block++) {
        // U_1 = PRF(password, salt || INT_32_BE(block))
        let u = hmacSha256(password, new Uint8Array([...salt, ...uint32ToBytesBE(block)]));
        const remaining = keyLen - (block - 1) * hashLen;
        dk.set(u.subarray(0, Math.min(u.length, remaining)), (block - 1) * hashLen);

        for (let j = 2; j <= iterations; j++) {
            u = hmacSha256(password, u);
            const offset = (block - 1) * hashLen;
            for (let k = 0; k < Math.min(u.length, keyLen - offset); k++) {
                dk[offset + k]! ^= u[k]!;
            }
        }
    }

    return dk.subarray(0, keyLen);
}

// ── Hex encoding helpers ─────────────────────────────────────────────────────

export function toHexString(bytes: Uint8Array): string {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}
