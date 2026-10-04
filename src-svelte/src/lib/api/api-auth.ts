// WeeChat Relay API authentication (phase 4).
//
// Credential payloads (live-verified against 4.10.1, relay-auth.c):
//   plain:<password>
//   hash:<sha256|sha512>:<timestamp>:<hex>
//       hex = SHA-256/512(UTF-8 "<timestamp><password>")
//   hash:pbkdf2+<sha256|sha512>:<timestamp>:<iterations>:<hex>
//       hex = PBKDF2-HMAC-SHA<alg>(password, salt=UTF-8 "<timestamp>",
//             iterations, dkLen=digest length 32/64)
// The timestamp is Unix seconds and must be within relay.network.time_window
// (default 5 s) of server time, so credentials are generated fresh per
// connection/retry and never cached. Hex is compared case-insensitively.
//
// Transport encodings:
//   HTTP: Authorization: Basic base64(UTF-8 payload)
//   WebSocket: subprotocols ["api.weechat",
//              "base64url.bearer.authorization.weechat.<base64url(payload)>"]

import type { HashAlgorithm } from '#lib/weechat-rest-types.ts';
import { sha256, pbkdf2, toHexString } from '#lib/utils/crypto.ts';

export interface NegotiatedAuth {
    algo: HashAlgorithm;
    iterations: number;
    totp: boolean;
}

const UTF8 = new TextEncoder();

/* Web Crypto (secure contexts) unlocks the SHA-512 family; without it we
 * advertise only the algorithms the pure-JS fallback can compute. Never
 * silently downgrade after a failed authentication. */
export function hasSubtleCrypto(): boolean {
    return typeof crypto !== 'undefined' && typeof crypto.subtle !== 'undefined';
}

export function supportedAlgorithms(): HashAlgorithm[] {
    return hasSubtleCrypto()
        ? ['pbkdf2+sha512', 'pbkdf2+sha256', 'sha512', 'sha256', 'plain']
        : ['pbkdf2+sha256', 'sha256', 'plain'];
}

function currentTimestamp(): number {
    return Math.floor(Date.now() / 1000);
}

async function subtleDigest(algo: 'sha256' | 'sha512', data: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
    const digest = await crypto.subtle.digest(algo === 'sha256' ? 'SHA-256' : 'SHA-512', data);
    return new Uint8Array(digest);
}

/* PBKDF2 via Web Crypto; salt is the decimal timestamp string (UTF-8). */
async function subtlePbkdf2(
    algo: 'sha256' | 'sha512',
    password: string,
    salt: Uint8Array<ArrayBuffer>,
    iterations: number,
): Promise<Uint8Array> {
    const key = await crypto.subtle.importKey(
        'raw', UTF8.encode(password), 'PBKDF2', false, ['deriveBits'],
    );
    const bits = await crypto.subtle.deriveBits(
        {
            name: 'PBKDF2',
            salt,
            iterations,
            hash: algo === 'sha256' ? 'SHA-256' : 'SHA-512',
        },
        key,
        (algo === 'sha256' ? 256 : 512),
    );
    return new Uint8Array(bits);
}

/**
 * Build one timestamped credential payload for the negotiated algorithm.
 * `timestampSec` defaults to now; pass explicitly only for tests.
 */
export async function generateCredential(
    algo: HashAlgorithm,
    password: string,
    iterations: number,
    timestampSec: number = currentTimestamp(),
): Promise<string> {
    if (algo === 'plain') {
        return `plain:${password}`;
    }

    const ts = String(timestampSec);

    if (algo === 'sha256' || algo === 'sha512') {
        if (algo === 'sha512' && !hasSubtleCrypto()) {
            throw new Error('Algorithm sha512 requires Web Crypto in this browser');
        }
        if (hasSubtleCrypto()) {
            const subtleHash = await subtleDigest(algo, UTF8.encode(ts + password));
            return `hash:${algo}:${ts}:${toHexString(subtleHash)}`;
        }
        // Fallback: pure-JS SHA-256 (matches the advertised fallback list).
        const jsHash = sha256(UTF8.encode(ts + password));
        return `hash:${algo}:${ts}:${toHexString(jsHash)}`;
    }

    if (algo === 'pbkdf2+sha256' || algo === 'pbkdf2+sha512') {
        const sub = algo === 'pbkdf2+sha256' ? 'sha256' : 'sha512';
        const salt = UTF8.encode(ts);
        if (hasSubtleCrypto()) {
            const dk = await subtlePbkdf2(sub, password, salt, iterations);
            return `hash:${algo}:${ts}:${iterations}:${toHexString(dk)}`;
        }
        // Fallback path: pure-JS PBKDF2-SHA256 only (matches advertised list).
        if (sub !== 'sha256') {
            throw new Error(`Algorithm ${algo} requires Web Crypto in this browser`);
        }
        if (!Number.isInteger(iterations) || iterations < 1) {
            throw new Error(`Invalid PBKDF2 iteration count: ${iterations}`);
        }
        const dk = pbkdf2(UTF8.encode(password), salt, iterations, 32);
        return `hash:${algo}:${ts}:${iterations}:${toHexString(dk)}`;
    }

    throw new Error(`Unsupported hash algorithm: ${algo}`);
}

/** HTTP Authorization header value for a credential payload. */
export function httpAuthHeader(credential: string): string {
    return `Basic ${base64Standard(UTF8.encode(credential))}`;
}

/**
 * WebSocket subprotocol list carrying the credential. Browser WebSocket cannot
 * set headers, so 4.5+ relays accept the credential as a subprotocol label.
 */
export function wsSubprotocols(credential: string): string[] {
    return [
        'api.weechat',
        `base64url.bearer.authorization.weechat.${base64Url(UTF8.encode(credential))}`,
    ];
}

function base64Standard(bytes: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
    return btoa(binary);
}

function base64Url(bytes: Uint8Array): string {
    return base64Standard(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Decide what to do with the server's TOTP flag. Browser WebSocket cannot
 * carry the x-weechat-totp header at all, and cross-origin HTTP preflight
 * does not allow it either (allowed headers: origin, content-type, accept,
 * authorization). Until an approved browser-compatible mechanism exists (gate
 * G3), a TOTP-protected relay is reported as unsupported rather than
 * half-supported.
 */
export function assertTotpSupported(totp: boolean): void {
    if (totp) {
        throw new Error(
            'This WeeChat relay requires TOTP two-factor authentication, which the ' +
            'browser client cannot provide (WebSocket has no TOTP header and CORS ' +
            'preflight forbids x-weechat-totp). Disable relay TOTP or use a client ' +
            'that supports it.',
        );
    }
}
