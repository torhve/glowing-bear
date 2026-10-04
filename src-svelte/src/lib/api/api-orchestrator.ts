// Bootstrap and reconnect orchestration for the Relay API session (phase 6).
//
// Protocol-level and store-agnostic: it drives one connection attempt per
// generation (handshake → version gate → WebSocket → ordered
// buffers→sync→hotlist batch) against injected ApiReducers and sync-phase
// tokens. Concrete store wiring lands in phase 13; tests use recording test
// reducers, exactly as the migration plan requires.
//
// Sync-phase rule (AGENTS.md): the phase opens before this attempt can
// receive any state and closes only on a protocol event — baseline applied,
// init failure, or disconnect. Never a timer.

import type { ApiEndpoint } from '#lib/api/api-endpoint.ts';
import { performHandshake, apiRequest, ApiHttpError } from '#lib/api/api-client.ts';
import { validateVersionResponse } from '#lib/api/api-validation.ts';
import type { VersionResponse } from '#lib/weechat-rest-types.ts';
import { ApiSession, ApiSessionError, type ApiSessionClose, type ApiSessionResponse } from '#lib/api/api-session.ts';
import { dispatchEvent, mapBufferList, mapHotlist } from '#lib/api/api-mapping.ts';
import type { ApiReducers } from '#lib/api/api-contracts.ts';

/** Mirrors models.ts beginSyncPhase/endSyncPhase generation-token API. */
export interface SyncPhaseTokens {
    begin(): number;
    end(token?: number): void;
}

export type OrchestratorState =
    | 'idle' | 'connecting' | 'bootstrapping' | 'connected'
    | 'reconnecting' | 'disconnected' | 'failed';

export interface OrchestratorStatus {
    state: OrchestratorState;
    generation: number;
    attempt: number;
    error?: string;
    /** Epoch ms of the scheduled retry, when reconnecting. */
    nextRetryAt?: number;
    serverVersion?: VersionResponse;
}

export interface BackoffPolicy {
    baseMs: number;
    maxMs: number;
    factor: number;
}

const DEFAULT_BACKOFF: BackoffPolicy = { baseMs: 1000, maxMs: 30_000, factor: 2 };

/** Live-verified baseline: Relay API 0.6.0 (number 1536). Older API servers
 *  lack endpoints this migration depends on (completion, batched arrays). */
export const MIN_API_VERSION_NUMBER = 1536;

export interface OrchestratorOptions {
    endpoint: ApiEndpoint;
    getPassword: () => string;
    reducers: ApiReducers;
    sync: SyncPhaseTokens;
    webSocketFactory?: (url: string, protocols: string[]) => WebSocket;
    autoReconnect?: boolean;
    backoff?: BackoffPolicy;
    minApiVersionNumber?: number;
    keepAliveMs?: number;
    requestTimeoutMs?: number;
    onStatus?: (status: OrchestratorStatus) => void;
}

class VersionTooOldError extends Error {}

export class ApiOrchestrator {
    private readonly opts: OrchestratorOptions;
    private generation = 0;
    private attempt = 0;
    private session: ApiSession | null = null;
    private abort: AbortController | null = null;
    private retryTimer: ReturnType<typeof setTimeout> | null = null;
    private stopped = true;
    private status: OrchestratorStatus = { state: 'idle', generation: 0, attempt: 0 };

    constructor(opts: OrchestratorOptions) {
        this.opts = opts;
    }

    get currentStatus(): OrchestratorStatus { return this.status; }
    get currentGeneration(): number { return this.generation; }

    /** Current live session for feature callers (input/completion/history in
     *  phases 7–11); null while disconnected. */
    getSession(): ApiSession | null {
        return this.session && this.session.isOpen ? this.session : null;
    }

    /** Start (or take over) a connection attempt. Bumps the generation so
     *  any in-flight older attempt is superseded. */
    start(): void {
        this.stopped = false;
        this.attempt = 0;
        this.beginAttempt();
    }

    /** Manual reconnect takeover: cancels any scheduled retry and starts a
     *  fresh attempt immediately. */
    reconnectNow(): void {
        if (this.stopped) return;
        this.clearRetry();
        this.attempt = 0;
        this.supersedeCurrent();
        this.beginAttempt();
    }

    /** Local disconnect. Never sends /quit — WeeChat must not be shut down
     *  by a client leaving. */
    stop(): void {
        this.stopped = true;
        this.clearRetry();
        this.supersedeCurrent();
        this.setStatus({ state: 'disconnected' });
    }

    /** Full teardown (HMR cleanup / component destroy). */
    dispose(): void {
        this.stop();
    }

    // ---- attempt machinery ----

    private beginAttempt(): void {
        const generation = ++this.generation;
        this.supersedeCurrent();
        const abort = new AbortController();
        this.abort = abort;
        const syncToken = this.opts.sync.begin();
        this.setStatus({
            state: this.attempt === 0 ? 'connecting' : 'reconnecting',
            generation,
            attempt: this.attempt,
            error: undefined,
            nextRetryAt: undefined,
        });

        void this.runAttempt(generation, abort, syncToken);
    }

    private async runAttempt(generation: number, abort: AbortController, syncToken: number): Promise<void> {
        let session: ApiSession | null = null;
        try {
            // 1. Unauthenticated handshake (aborts with the attempt).
            const auth = await performHandshake(this.opts.endpoint, abort.signal);
            if (!this.isCurrent(generation)) { this.opts.sync.end(syncToken); return; }
            if (auth.totp) {
                // G3 unresolved: browser cannot deliver x-weechat-totp over WS.
                throw new ApiHttpError(401, null,
                    'This WeeChat requires TOTP, which the browser client cannot provide; disable relay.network.totp or use a password-only relay');
            }

            // 2. Version gate before publishing readiness.
            const version = await apiRequest<VersionResponse>(
                this.opts.endpoint, auth, this.opts.getPassword(), 'GET', '/api/version', undefined,
                { signal: abort.signal },
            );
            if (!this.isCurrent(generation)) { this.opts.sync.end(syncToken); return; }
            const vv = validateVersionResponse(version);
            if (!vv.value) throw new Error(`Invalid version response: ${vv.issues.join('; ')}`);
            if (vv.value.relay_api_version_number < (this.opts.minApiVersionNumber ?? MIN_API_VERSION_NUMBER)) {
                // Retrying cannot change the server version: hard failure,
                // reported before the staleness gate in the catch.
                const message = `WeeChat Relay API ${vv.value.relay_api_version} is too old; `
                    + 'Glowing Bear requires API 0.6.0 (WeeChat 4.10.1+)';
                this.stopped = true;
                this.setStatus({ state: 'failed', error: message }, { generation });
                throw new VersionTooOldError(message);
            }
            this.setStatus({ serverVersion: vv.value }, { generation });

            // 3. WebSocket session for this generation only.
            session = new ApiSession({
                endpoint: this.opts.endpoint,
                auth,
                password: this.opts.getPassword(),
                generation,
                webSocketFactory: this.opts.webSocketFactory,
                requestTimeoutMs: this.opts.requestTimeoutMs,
                keepAliveMs: this.opts.keepAliveMs,
                onEvent: (event) => {
                    if (!this.isCurrent(generation)) return;
                    dispatchEvent(event, this.opts.reducers);
                },
                onClose: (close) => this.handleSessionClose(generation, close),
            });
            this.session = session;
            await session.connect();
            if (!this.isCurrent(generation)) { session.destroy(); this.opts.sync.end(syncToken); return; }

            this.setStatus({ state: 'bootstrapping' }, { generation });

            // 4. Ordered batch: buffers → sync subscription → hotlist baseline.
            // Events already flow from step 3; the hotlist baseline then
            // becomes authoritative while the sync phase is still open.
            const settled = await session.batch([
                { method: 'GET', path: '/api/buffers?lines=0' },
                { method: 'POST', path: '/api/sync', body: { sync: true, nicks: true, input: true, colors: 'weechat' } },
                { method: 'GET', path: '/api/hotlist' },
            ], this.opts.requestTimeoutMs);
            if (!this.isCurrent(generation)) { this.opts.sync.end(syncToken); return; }

            const buffersRes = unwrapSettled(settled[0], [200]);
            if (!buffersRes) throw new Error(`buffers bootstrap failed: ${settledReason(settled[0])}`);
            const buffers = mapBufferList(buffersRes.body, this.opts.reducers);
            if (buffers === null) throw new Error('buffers bootstrap returned an invalid body');

            const syncRes = unwrapSettled(settled[1], [204, 200]);
            if (!syncRes) throw new Error(`sync bootstrap failed: ${settledReason(settled[1])}`);

            const hotlistRes = unwrapSettled(settled[2], [200]);
            if (!hotlistRes) throw new Error(`hotlist bootstrap failed: ${settledReason(settled[2])}`);
            const hotlist = mapHotlist(hotlistRes.body, this.opts.reducers);
            if (hotlist === null) throw new Error('hotlist bootstrap returned an invalid body');

            this.opts.reducers.buffers(buffers);
            this.opts.reducers.hotlist(hotlist);

            // Baseline applied — the only protocol event that closes a
            // successful sync phase.
            this.opts.sync.end(syncToken);
            this.attempt = 0;
            this.setStatus({ state: 'connected', error: undefined, nextRetryAt: undefined }, { generation });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            // Failure exit closes the sync phase with this attempt's token.
            this.opts.sync.end(syncToken);
            if (err instanceof VersionTooOldError) return; // status already failed
            if (!this.isCurrent(generation)) return;
            session?.destroy();
            if (session) this.session = null;
            if (err instanceof ApiSessionError && err.code === 'superseded') return;
            this.handleFailure(generation, message);
        }
    }

    private handleSessionClose(generation: number, close: ApiSessionClose): void {
        if (!this.isCurrent(generation)) return;
        this.session = null;
        // Disconnect is a protocol-level exit; any still-open sync phase for
        // this generation is closed here, never by a timer.
        this.opts.sync.end();
        if (this.stopped) {
            this.setStatus({ state: 'disconnected' }, { generation });
            return;
        }
        this.handleFailure(generation, `connection closed (code ${close.code}${close.authenticated ? '' : ', never authenticated'})`);
    }

    private handleFailure(generation: number, error: string): void {
        if (this.opts.autoReconnect === false || this.stopped) {
            this.setStatus({ state: 'failed', error }, { generation });
            return;
        }
        const backoff = this.opts.backoff ?? DEFAULT_BACKOFF;
        const delay = Math.min(backoff.baseMs * Math.pow(backoff.factor, this.attempt), backoff.maxMs);
        this.attempt += 1;
        const nextRetryAt = Date.now() + delay;
        this.setStatus({ state: 'reconnecting', error, nextRetryAt }, { generation });
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            if (!this.stopped) this.beginAttempt();
        }, delay);
    }

    private supersedeCurrent(): void {
        if (this.abort) {
            this.abort.abort();
            this.abort = null;
        }
        if (this.session) {
            const old = this.session;
            this.session = null;
            // Destroy after clearing the reference so the old session's
            // onClose sees a stale generation and cannot touch the new one.
            old.destroy();
        }
    }

    private clearRetry(): void {
        if (this.retryTimer !== null) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
    }

    private isCurrent(generation: number): boolean {
        return generation === this.generation && !this.stopped;
    }

    private setStatus(partial: Partial<OrchestratorStatus>, guard?: { generation: number }): void {
        if (guard && guard.generation !== this.generation) return;
        this.status = {
            ...this.status,
            ...partial,
            generation: this.generation,
            attempt: this.attempt,
        };
        this.opts.onStatus?.(this.status);
    }
}

function unwrapSettled(
    res: PromiseSettledResult<ApiSessionResponse> | undefined,
    okCodes: number[],
): ApiSessionResponse | null {
    if (!res || res.status === 'rejected') return null;
    return okCodes.includes(res.value.code) ? res.value : null;
}

function settledReason(res: PromiseSettledResult<ApiSessionResponse> | undefined): string {
    if (!res) return 'missing result';
    if (res.status === 'rejected') {
        const r = res.reason as Error;
        return r?.message ?? 'rejected';
    }
    const body = res.value.body;
    const detail = typeof body === 'string' ? body : JSON.stringify(body);
    return `code ${res.value.code}${detail ? `: ${detail}` : ''}`;
}
