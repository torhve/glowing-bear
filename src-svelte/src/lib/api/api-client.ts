// Authenticated HTTP layer for the WeeChat Relay API (phase 4).
//
// Every resource request is independently authenticated with a FRESH
// timestamped credential (hash timestamps expire within
// relay.network.time_window). HTTP auth failures are distinguishable from
// transport failures here; WebSocket auth failures are not (close 1006) and
// are classified by the session layer.

import type { HashAlgorithm } from '#lib/weechat-rest-types.ts';
import { validateHandshakeResponse, validateErrorBody } from '#lib/api/api-validation.ts';
import {
    generateCredential,
    httpAuthHeader,
    supportedAlgorithms,
    type NegotiatedAuth,
} from '#lib/api/api-auth.ts';
import type { ApiEndpoint } from '#lib/api/api-endpoint.ts';

export class ApiHttpError extends Error {
    status: number;
    /** Server's `{"error":"..."}` message when present. */
    apiError: string | null;

    constructor(status: number, apiError: string | null, fallback: string) {
        super(apiError ?? fallback);
        this.name = 'ApiHttpError';
        this.status = status;
        this.apiError = apiError;
    }
}

export interface HttpOptions {
    timeoutMs?: number;
    signal?: AbortSignal;
}

const DEFAULT_TIMEOUT = 10000;

async function fetchWithTimeout(url: string, init: RequestInit, options: HttpOptions): Promise<Response> {
    const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const onOuterAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onOuterAbort);
    try {
        return await fetch(url, { ...init, signal: controller.signal });
    } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onOuterAbort);
    }
}

/**
 * Unauthenticated POST /api/handshake. Sends only the algorithms this client
 * can actually compute; a null negotiation means the server allows none of
 * them (or no password scheme at all) and is surfaced, not guessed.
 */
export async function performHandshake(
    endpoint: ApiEndpoint,
    signal?: AbortSignal,
): Promise<NegotiatedAuth> {
    const res = await fetchWithTimeout(
        `${endpoint.httpBase}/api/handshake`,
        {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ password_hash_algo: supportedAlgorithms() }),
        },
        { signal },
    );
    if (!res.ok) {
        throw new ApiHttpError(res.status, await extractApiError(res), 'Handshake failed');
    }
    let json: unknown;
    try {
        json = await res.json();
    } catch {
        throw new ApiHttpError(res.status, null, 'Handshake returned invalid JSON');
    }
    const validated = validateHandshakeResponse(json);
    if (!validated.value) {
        throw new ApiHttpError(res.status, null, `Invalid handshake response: ${validated.issues.join('; ')}`);
    }
    const algo = validated.value.password_hash_algo;
    if (algo === null) {
        throw new ApiHttpError(
            res.status,
            null,
            'WeeChat accepted none of the supported hash algorithms (check relay.network.password_hash_algo)',
        );
    }
    return {
        algo: algo as HashAlgorithm,
        iterations: validated.value.password_hash_iterations,
        totp: validated.value.totp,
    };
}

async function extractApiError(res: Response): Promise<string | null> {
    try {
        const json = await res.json() as unknown;
        const validated = validateErrorBody(json);
        return validated.value?.error ?? null;
    } catch {
        return null;
    }
}

/**
 * Authenticated JSON request over HTTP. `path` is the full URL path
 * (endpoint-relative), e.g. "/api/buffers?lines=0".
 */
export async function apiRequest<T>(
    endpoint: ApiEndpoint,
    auth: NegotiatedAuth,
    password: string,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    options: HttpOptions = {},
): Promise<T> {
    // Fresh credential per request: hash timestamps are time-windowed.
    const credential = await generateCredential(auth.algo, password, auth.iterations);
    const headers: Record<string, string> = {
        authorization: httpAuthHeader(credential),
        accept: 'application/json',
    };
    if (body !== undefined) headers['content-type'] = 'application/json';

    const res = await fetchWithTimeout(
        `${endpoint.httpBase}${path.startsWith('/') ? path : `/${path}`}`,
        { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined },
        options,
    );
    if (res.status === 204) return undefined as T;
    if (!res.ok) {
        throw new ApiHttpError(res.status, await extractApiError(res), `Request failed: ${method} ${path}`);
    }
    const text = await res.text();
    if (!text) return undefined as T;
    try {
        return JSON.parse(text) as T;
    } catch {
        throw new ApiHttpError(res.status, null, `Invalid JSON response for ${method} ${path}`);
    }
}
