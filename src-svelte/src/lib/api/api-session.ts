// Generation-scoped WeeChat relay API session.
//
// One instance = one WebSocket attempt. The orchestrator (phase 6) owns
// reconnects and generations; this class guarantees that every callback,
// pending request, deadline and socket belongs to exactly one generation, so
// superseded or disconnected sessions can never touch newer state.
//
// Wire contract (live-verified, see test/fixtures/api-dossier):
// - text frames only; requests are objects or arrays of objects
// - responses echo `request_id`; events are flat `code:0` envelopes with
//   `event_name`/`buffer_id`/`body_type`/`body`
// - an unmatched or late response is a diagnostic, never an event

import type { ApiEndpoint } from '#lib/api/api-endpoint.ts';
import { generateCredential, wsSubprotocols, type NegotiatedAuth } from '#lib/api/api-auth.ts';
import type { ApiEventName, WebSocketResponse } from '#lib/weechat-rest-types.ts';

export interface ApiSessionRequest {
    method: 'GET' | 'POST' | 'PUT' | 'DELETE';
    /** Inner JSON request path, always `/api/...` even behind a proxy prefix. */
    path: string;
    body?: unknown;
}

export interface ApiSessionResponse {
    code: number;
    request: string;
    request_id: string;
    body_type: string | null;
    body: unknown;
}

export interface ApiSessionEvent {
    event_name: ApiEventName;
    buffer_id: number;
    body_type: string | null;
    body: unknown;
}

export interface ApiSessionClose {
    code: number;
    reason: string;
    wasClean: boolean;
    /** True once any valid frame proved the upgrade authenticated. */
    authenticated: boolean;
}

export type ApiSessionDiagnostic =
    | { kind: 'unmatched_response'; frame: unknown }
    | { kind: 'malformed_frame'; raw: string; error: string }
    | { kind: 'send_failed'; error: string };

export interface ApiSessionOptions {
    endpoint: ApiEndpoint;
    /** Result of the unauthenticated HTTP handshake for this attempt. */
    auth: NegotiatedAuth;
    password: string;
    /** Connection generation token owned by the orchestrator. */
    generation: number;
    /** Injectable for deterministic tests; defaults to the global WebSocket. */
    webSocketFactory?: (url: string, protocols: string[]) => WebSocket;
    requestTimeoutMs?: number;
    /** Application-level keepalive; 0/undefined disables it. */
    keepAliveMs?: number;
    onEvent: (event: ApiSessionEvent) => void;
    /**
     * Synchronous response stream, called in socket delivery order **before**
     * the matching request promise settles. Reducers that must keep responses
     * and events in one ordered application stream subscribe here; promise
     * continuations are for request-local data flow only.
     */
    onResponse?: (response: ApiSessionResponse) => void;
    onDiagnostic?: (d: ApiSessionDiagnostic) => void;
    onClose: (close: ApiSessionClose) => void;
}

export class ApiSessionError extends Error {
    readonly code: 'closed' | 'timeout' | 'send_failed' | 'superseded';
    constructor(code: ApiSessionError['code'], message: string) {
        super(message);
        this.code = code;
        this.name = 'ApiSessionError';
    }
}

interface PendingRequest {
    settle: (response: ApiSessionResponse) => void;
    reject: (error: Error) => void;
    deadline: ReturnType<typeof setTimeout>;
    path: string;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

/** Collision-free request ids: random per-session prefix + monotonic counter. */
function makeSessionId(): string {
    const bytes = new Uint8Array(6);
    if (typeof globalThis.crypto?.getRandomValues === 'function') {
        globalThis.crypto.getRandomValues(bytes);
    } else {
        for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    return Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('');
}

export class ApiSession {
    private readonly opts: ApiSessionOptions;
    private readonly sessionId = makeSessionId();
    private counter = 0;
    private socket: WebSocket | null = null;
    private pending = new Map<string, PendingRequest>();
    private deadlines = new Set<ReturnType<typeof setTimeout>>();
    private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
    private invalidated = false;
    private opened = false;
    private authenticated = false;
    private lastActivityAt = 0;
    private requestTimeoutMs: number;

    constructor(opts: ApiSessionOptions) {
        this.opts = opts;
        this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    }

    get generation(): number { return this.opts.generation; }
    get isOpen(): boolean {
        return this.socket !== null && this.socket.readyState === WebSocket.OPEN && !this.invalidated;
    }
    get lastActivity(): number { return this.lastActivityAt; }
    get pendingCount(): number { return this.pending.size; }

    /** Opens the socket; resolves on open, rejects on pre-open failure. */
    async connect(): Promise<void> {
        if (this.invalidated) throw new ApiSessionError('superseded', 'session already invalidated');
        const url = this.opts.endpoint.wsUrl;
        // Fresh timestamped credential per connection attempt.
        const credential = await generateCredential(this.opts.auth.algo, this.opts.password, this.opts.auth.iterations);
        if (this.invalidated) throw new ApiSessionError('superseded', 'session invalidated during credential derivation');
        const protocols = wsSubprotocols(credential);
        const factory = this.opts.webSocketFactory ?? ((u, p) => new WebSocket(u, p));
        const socket = factory(url, protocols);
        this.socket = socket;
        const mySocket = socket;

        return new Promise<void>((resolve, reject) => {
            let settledOpen = false;
            socket.onopen = () => {
                if (this.isStale(mySocket)) return;
                settledOpen = true;
                this.opened = true;
                this.lastActivityAt = Date.now();
                if (this.opts.keepAliveMs && this.opts.keepAliveMs > 0) {
                    this.keepAliveTimer = setInterval(() => {
                        // Fire-and-forget liveness; failures surface via close.
                        this.request({ method: 'POST', path: '/api/ping', body: {} }).catch(() => undefined);
                    }, this.opts.keepAliveMs);
                }
                resolve();
            };
            socket.onmessage = (ev: MessageEvent) => this.handleFrame(ev, mySocket);
            socket.onerror = () => {
                // Browser WS errors carry no detail; classification happens on close.
            };
            socket.onclose = (ev: CloseEvent) => {
                if (this.isStale(mySocket)) {
                    this.closeSocketQuietly(mySocket);
                    return;
                }
                this.teardown();
                const close: ApiSessionClose = {
                    code: ev.code,
                    reason: ev.reason,
                    wasClean: ev.wasClean,
                    authenticated: this.authenticated,
                };
                if (!settledOpen) {
                    // Auth-rejected upgrades surface as 1006 with no frame; do not
                    // pretend this is an HTTP 401.
                    reject(new ApiSessionError('closed', `WebSocket connect failed (close code ${ev.code})`));
                }
                this.opts.onClose(close);
            };
        });
    }

    /** Sends one request and resolves with its correlated response frame. */
    request(req: ApiSessionRequest, timeoutMs = this.requestTimeoutMs): Promise<ApiSessionResponse> {
        if (this.invalidated) return Promise.reject(new ApiSessionError('superseded', 'session invalidated'));
        if (!this.isOpen) return Promise.reject(new ApiSessionError('closed', 'session is not open'));
        const id = `${this.sessionId}-${++this.counter}`;
        const frame = this.buildFrame(id, req);
        return this.sendAndAwait(id, frame, timeoutMs);
    }

    /**
     * Sends multiple requests as one array frame (batched request support is
     * live-verified on 4.10.1). All requests are registered before the single
     * send; each settles independently so partial failure is reportable.
     */
    batch(reqs: ApiSessionRequest[], timeoutMs = this.requestTimeoutMs): Promise<PromiseSettledResult<ApiSessionResponse>[]> {
        if (this.invalidated) {
            return Promise.resolve(reqs.map(() => ({
                status: 'rejected' as const,
                reason: new ApiSessionError('superseded', 'session invalidated'),
            })));
        }
        if (!this.isOpen || reqs.length === 0) {
            return Promise.resolve(reqs.map(() => ({
                status: 'rejected' as const,
                reason: new ApiSessionError('closed', 'session is not open'),
            })));
        }
        const frames: unknown[] = [];
        const ids: string[] = [];
        const waiters = reqs.map((req) => {
            const id = `${this.sessionId}-${++this.counter}`;
            ids.push(id);
            frames.push(this.buildFrame(id, req));
            return this.sendAndAwait(id, null, timeoutMs, true);
        });
        // One socket send for the whole batch, after every id is registered.
        try {
            this.socket!.send(JSON.stringify(frames));
            this.lastActivityAt = Date.now();
        } catch (e) {
            const error = new ApiSessionError('send_failed', `batch send failed: ${(e as Error).message}`);
            for (const id of ids) this.rejectPending(id, error);
            this.opts.onDiagnostic?.({ kind: 'send_failed', error: (e as Error).message });
        }
        return Promise.allSettled(waiters);
    }

    /** Invalidates this generation and tears everything down. Idempotent. */
    destroy(): void {
        this.invalidated = true;
        const socket = this.socket;
        this.teardown();
        if (socket) {
            socket.onclose = null;
            socket.onmessage = null;
            socket.onopen = null;
            socket.onerror = null;
            this.closeSocketQuietly(socket);
        }
    }

    // ---- internals ----

    private buildFrame(id: string, req: ApiSessionRequest): Record<string, unknown> {
        const frame: Record<string, unknown> = { request: `${req.method} ${req.path}`, request_id: id };
        if (req.body !== undefined) frame.body = req.body;
        return frame;
    }

    private sendAndAwait(
        id: string,
        frame: Record<string, unknown> | null,
        timeoutMs: number,
        alreadySent = false,
    ): Promise<ApiSessionResponse> {
        return new Promise<ApiSessionResponse>((resolve, reject) => {
            const deadline = setTimeout(() => {
                this.pending.delete(id);
                this.deadlines.delete(deadline);
                reject(new ApiSessionError('timeout', `request ${id} (${frame?.request ?? 'batched'}) timed out`));
            }, timeoutMs);
            this.deadlines.add(deadline);
            this.pending.set(id, {
                settle: resolve,
                reject,
                deadline,
                path: typeof frame?.request === 'string' ? frame.request : 'batched',
            });
            if (!alreadySent && frame) {
                try {
                    this.socket!.send(JSON.stringify(frame));
                    this.lastActivityAt = Date.now();
                } catch (e) {
                    clearTimeout(deadline);
                    this.deadlines.delete(deadline);
                    this.pending.delete(id);
                    reject(new ApiSessionError('send_failed', `send failed: ${(e as Error).message}`));
                    this.opts.onDiagnostic?.({ kind: 'send_failed', error: (e as Error).message });
                }
            }
        });
    }

    private rejectPending(id: string, error: Error): void {
        const p = this.pending.get(id);
        if (!p) return;
        clearTimeout(p.deadline);
        this.deadlines.delete(p.deadline);
        this.pending.delete(id);
        p.reject(error);
    }

    /** Synchronous parse + dispatch: no await between frames, so store
     *  updates from responses and events keep socket delivery order. */
    private handleFrame(ev: MessageEvent, mySocket: WebSocket): void {
        if (this.isStale(mySocket)) return;
        this.lastActivityAt = Date.now();
        let frame: unknown;
        if (typeof ev.data !== 'string') {
            this.opts.onDiagnostic?.({ kind: 'malformed_frame', raw: '<non-text frame>', error: 'binary frame' });
            return;
        }
        try {
            frame = JSON.parse(ev.data);
        } catch (e) {
            this.opts.onDiagnostic?.({ kind: 'malformed_frame', raw: ev.data.slice(0, 200), error: (e as Error).message });
            return;
        }
        if (frame === null || typeof frame !== 'object') {
            this.opts.onDiagnostic?.({ kind: 'malformed_frame', raw: ev.data.slice(0, 200), error: 'non-object frame' });
            return;
        }
        const f = frame as Partial<WebSocketResponse> & { event_name?: unknown; buffer_id?: unknown };
        this.authenticated = true;

        // Batched responses may arrive as an array of frames.
        if (Array.isArray(f)) {
            for (const sub of f as Array<Partial<WebSocketResponse>>) this.dispatchFrame(sub);
            return;
        }
        this.dispatchFrame(f);
    }

    private dispatchFrame(f: Partial<WebSocketResponse> & { event_name?: unknown; buffer_id?: unknown }): void {
        if (f === null || typeof f !== 'object') {
            this.opts.onDiagnostic?.({ kind: 'malformed_frame', raw: JSON.stringify(f).slice(0, 200), error: 'bad sub-frame' });
            return;
        }
        const id = f.request_id;
        if (typeof id === 'string' && this.pending.has(id)) {
            const p = this.pending.get(id)!;
            clearTimeout(p.deadline);
            this.deadlines.delete(p.deadline);
            this.pending.delete(id);
            const response: ApiSessionResponse = {
                code: typeof f.code === 'number' ? f.code : -1,
                request: typeof f.request === 'string' ? f.request : '',
                request_id: id,
                body_type: f.body_type ?? null,
                body: f.body ?? null,
            };
            // Ordered application stream: sync hook first, promise after.
            this.opts.onResponse?.(response);
            p.settle(response);
            return;
        }
        // Flat event envelope: code 0 with event_name. An unmatched response
        // (late/timed-out) must never be treated as an event.
        if (f.code === 0 && typeof f.event_name === 'string') {
            this.opts.onEvent({
                event_name: f.event_name as ApiEventName,
                buffer_id: typeof f.buffer_id === 'number' ? f.buffer_id : -1,
                body_type: f.body_type ?? null,
                body: f.body ?? null,
            });
            return;
        }
        this.opts.onDiagnostic?.({ kind: 'unmatched_response', frame: f });
    }

    private isStale(mySocket: WebSocket): boolean {
        return this.invalidated || this.socket !== mySocket;
    }

    private teardown(): void {
        this.invalidated = true;
        if (this.keepAliveTimer !== null) {
            clearInterval(this.keepAliveTimer);
            this.keepAliveTimer = null;
        }
        for (const d of this.deadlines) clearTimeout(d);
        this.deadlines.clear();
        const error = new ApiSessionError('closed', 'session closed');
        for (const [id, p] of this.pending) {
            p.reject(error);
        }
        this.pending.clear();
    }

    private closeSocketQuietly(socket: WebSocket): void {
        try {
            if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
                socket.close(1000, 'session replaced');
            }
        } catch {
            // Closing an already-closed socket is fine.
        }
    }
}
