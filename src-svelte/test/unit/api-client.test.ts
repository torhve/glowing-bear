import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { performHandshake, apiRequest, ApiHttpError } from '#lib/api/api-client.ts';
import { resolveApiEndpoint } from '#lib/api/api-endpoint.ts';

const endpoint = resolveApiEndpoint({ host: 'localhost', port: 9010, tls: false });

function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

describe('performHandshake', () => {
    beforeEach(() => { vi.restoreAllMocks(); });
    afterEach(() => { vi.restoreAllMocks(); });

    it('posts the supported algorithm list and returns the negotiation', async () => {
        const fetchMock = vi.fn(async () => jsonResponse(200, {
            password_hash_algo: 'pbkdf2+sha256',
            password_hash_iterations: 100000,
            totp: false,
        }));
        vi.stubGlobal('fetch', fetchMock);
        const auth = await performHandshake(endpoint);
        expect(auth).toEqual({ algo: 'pbkdf2+sha256', iterations: 100000, totp: false });
        const [url, init] = fetchMock.mock.calls[0]!;
        expect(url).toBe('http://localhost:9010/api/handshake');
        expect(init.method).toBe('POST');
        const sent = JSON.parse(init.body as string);
        expect(sent.password_hash_algo).toContain('pbkdf2+sha256');
    });

    it('surfaces a null negotiation instead of guessing an algorithm', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, {
            password_hash_algo: null, password_hash_iterations: 100000, totp: false,
        })));
        await expect(performHandshake(endpoint)).rejects.toThrow(/accepted none/);
    });

    it('surfaces server error bodies', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(405, { error: 'Method not allowed' })));
        await expect(performHandshake(endpoint)).rejects.toThrow(/Method not allowed/);
    });

    it('rejects invalid JSON without crashing', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>', { status: 200 })));
        await expect(performHandshake(endpoint)).rejects.toThrow(/invalid JSON/i);
    });
});

describe('apiRequest', () => {
    beforeEach(() => { vi.restoreAllMocks(); });
    afterEach(() => { vi.restoreAllMocks(); });

    const auth = { algo: 'pbkdf2+sha256' as const, iterations: 1000, totp: false };

    it('sends a fresh Basic credential header and parses JSON', async () => {
        const fetchMock = vi.fn(async () => jsonResponse(200, [{ id: 1 }]));
        vi.stubGlobal('fetch', fetchMock);
        const body = await apiRequest<unknown[]>(endpoint, auth, 'pw', 'GET', '/api/buffers?lines=0');
        expect(body).toEqual([{ id: 1 }]);
        const headers = fetchMock.mock.calls[0]![1].headers as Record<string, string>;
        expect(headers.authorization.startsWith('Basic ')).toBe(true);
        const decoded = Buffer.from(headers.authorization.slice(6), 'base64').toString('utf8');
        expect(decoded.startsWith('hash:pbkdf2+sha256:')).toBe(true);
        expect(decoded).toContain(':1000:');
    });

    it('treats 204 as a successful empty result', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
        const result = await apiRequest(endpoint, auth, 'pw', 'POST', '/api/input', { command: '/say hi' });
        expect(result).toBeUndefined();
    });

    it('maps API error bodies to ApiHttpError with status', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(404, { error: 'Buffer not found' })));
        const err = await apiRequest(endpoint, auth, 'pw', 'GET', '/api/buffers/999')
            .catch((e) => e);
        expect(err).toBeInstanceOf(ApiHttpError);
        expect(err.status).toBe(404);
        expect(err.apiError).toBe('Buffer not found');
    });

    it('generates a new timestamped credential per request', async () => {
        const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
        vi.stubGlobal('fetch', fetchMock);
        await apiRequest(endpoint, auth, 'pw', 'POST', '/api/ping', {});
        await new Promise((r) => setTimeout(r, 1100)); // cross a second boundary
        await apiRequest(endpoint, auth, 'pw', 'POST', '/api/ping', {});
        const dec = (i: number) => Buffer.from(
            (fetchMock.mock.calls[i]![1].headers as Record<string, string>).authorization.slice(6),
            'base64',
        ).toString('utf8');
        const tsOf = (cred: string) => cred.split(':')[2];
        expect(tsOf(dec(0))).not.toBe(tsOf(dec(1)));
    });

    it('aborts on timeout', async () => {
        vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) =>
            new Promise((_res, reject) => {
                init.signal!.addEventListener('abort', () => reject(new Error('aborted')));
            })));
        await expect(apiRequest(endpoint, auth, 'pw', 'GET', '/api/version', undefined, { timeoutMs: 50 }))
            .rejects.toThrow(/aborted/);
    });
});
