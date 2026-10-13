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
import { performHandshake, apiRequest } from '#lib/api/api-client.ts';
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

/**
 * The retry policy, injected rather than owned.
 *
 * The orchestrator used to run its own retry loop: a timer, an attempt counter
 * and a backoff ladder that duplicated the legacy transport's. Keeping it here
 * meant the same policy had two owners with different indexing, and a change to
 * one had to be remembered for the other.
 *
 * What the orchestrator still owns, and deliberately so: the generation, the
 * abort/supersede machinery, the session teardown, and the sync-phase token. The
 * sync phase must open inside an attempt and close on a protocol event — never
 * from a retry timer — so the attempt stays here even though the timer does not.
 */
export interface RetryDriver {
    /** Schedule the next attempt. Reports whether one was actually scheduled. */
    scheduleRetry(error: string, generation: number): boolean;
    /** Cancel a scheduled attempt without deciding to stop reconnecting. */
    cancelPendingRetry(): void;
    /** Which attempt is about to run: 0 is the first connect, 1 the first retry. */
    attemptNumber(): number;
    /** Restart the ladder from the beginning. */
    restartLadder(): void;
}

/** Live-verified baseline: Relay API 0.6.0 (number 1536). Older API servers
 *  lack endpoints this migration depends on (completion, batched arrays). */
export const MIN_API_VERSION_NUMBER = 1536;

export interface OrchestratorOptions {
    endpoint: ApiEndpoint;
    getPassword: () => string;
    reducers: ApiReducers;
    sync: SyncPhaseTokens;
    webSocketFactory?: (url: string, protocols: string[]) => WebSocket;
    retry?: RetryDriver;
    minApiVersionNumber?: number;
    keepAliveMs?: number;
    requestTimeoutMs?: number;
    /** Passed to the session: the WebSocket-open deadline the transport decided on. */
    connectTimeoutMs?: number;
    onStatus?: (status: OrchestratorStatus) => void;
    /**
     * Fired once per attempt, from `beginAttempt()`, before any request runs.
     * The transport owns what that means; the orchestrator only guarantees it
     * happens for every attempt and for no other reason.
     */
    onAttemptStart?: () => void;
}

/**
 * An attempt whose outcome is already final. Throwing this means "the status has
 * been written and no retry can change the result" — the catch must not hand the
 * attempt to the retry driver, because the driver would schedule an attempt
 * against a condition it cannot fix.
 */
class TerminalAttemptError extends Error {}
class VersionTooOldError extends TerminalAttemptError {}
class RelayRequiresTotpError extends TerminalAttemptError {}

export class ApiOrchestrator {
    private readonly opts: OrchestratorOptions;
    private generation = 0;
    private session: ApiSession | null = null;
    private abort: AbortController | null = null;
    private upgradeTimer: ReturnType<typeof setTimeout> | null = null;
    private stopped = true;
    /**
     * Which attempt is still running, by generation.
     *
     * The status used to answer this question: a failure wrote 'reconnecting', so
     * reading the status told you whether an attempt was in flight. The failure
     * path no longer writes a status — the scheduler does — which left the last
     * status the attempt had started with. A session that died during bootstrap
     * reported 'bootstrapping' forever, and every consumer that asks "is an
     * attempt in flight?" answered yes while the client was actually waiting out a
     * backoff. The banner hid its own countdown because of it.
     *
     * The attempt lifecycle is the orchestrator's, so it reports it directly.
     */
    private runningGeneration: number | null = null;
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
        this.opts.retry?.restartLadder();
        this.beginAttempt();
    }

    /** Manual reconnect takeover: cancels any scheduled retry and starts a
     *  fresh attempt immediately. */
    reconnectNow(resetAttempts = false): void {
        if (this.stopped) return;
        this.clearRetry();
        // Manual "reconnect now" keeps the ladder unless explicitly reset
        // (focus-reconnect), so a failed immediate retry escalates.
        if (resetAttempts) this.opts.retry?.restartLadder();
        this.supersedeCurrent();
        this.beginAttempt();
    }

    /** Start the attempt the shared scheduler has decided to make. Distinct from
     *  reconnectNow(): nothing is cancelled and the ladder is untouched, because
     *  the scheduler has already done both. */
    startScheduledAttempt(): void {
        if (this.stopped) return;
        this.beginAttempt();
    }

    /** Local disconnect. Never sends /quit — WeeChat must not be shut down
     *  by a client leaving. */
    stop(): void {
        this.stopped = true;
        this.runningGeneration = null;
        this.clearRetry();
        this.supersedeCurrent();
        this.setStatus({ state: 'disconnected' });
    }

    /** True while an attempt is running: between an attempt starting and it
     *  succeeding, failing, or being superseded. False while waiting out a
     *  backoff, which is exactly when a manual retry is worth taking over. */
    get attemptInFlight(): boolean {
        return this.runningGeneration !== null && this.runningGeneration === this.generation;
    }

    /** Clear the running mark, but never for a superseded attempt: a late exit
     *  from an older attempt must not claim the current one has finished. */
    private markAttemptSettled(generation: number): void {
        if (generation === this.generation) this.runningGeneration = null;
    }

    /** Full teardown (HMR cleanup / component destroy). */
    dispose(): void {
        this.stop();
    }

    // ---- attempt machinery ----

    private beginAttempt(): void {
        const generation = ++this.generation;
        const attempt = this.opts.retry?.attemptNumber() ?? 0;
        this.supersedeCurrent();
        // Every path that starts an attempt — first connect, scheduled retry,
        // manual takeover — passes here, so this is the one place the API
        // transport can say "this attempt is what the app now describes".
        this.opts.onAttemptStart?.();
        const abort = new AbortController();
        this.abort = abort;
        const syncToken = this.opts.sync.begin();
        this.runningGeneration = generation;
        this.setStatus({
            state: attempt === 0 ? 'connecting' : 'reconnecting',
            generation,
            attempt,
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
                //
                // This is a stop, not a failure. Nothing a retry can do produces a
                // verification code this client cannot send, so handing it to the
                // retry driver would burn the whole backoff ladder against a relay
                // that answers the same way every time — which is what it did
                // before this was written down. Same shape as the version gate.
                const message = 'This WeeChat requires TOTP, which the browser client cannot provide; '
                    + 'disable relay.network.totp or use a password-only relay';
                this.stopped = true;
                this.setStatus({ state: 'failed', error: message }, { generation });
                throw new RelayRequiresTotpError(message);
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
                connectTimeoutMs: this.opts.connectTimeoutMs,
                keepAliveMs: this.opts.keepAliveMs,
                onEvent: (event) => {
                    if (!this.isCurrent(generation)) return;
                    dispatchEvent(event, this.opts.reducers);
                    // Legacy parity (_upgrade/_upgrade_ended): an upgrade kills
                    // the session; reconnect ~2 s later, once WeeChat's relay
                    // is back. 'quit' needs nothing — the socket close drives
                    // the normal failure/reconnect path.
                    if (event.event_name === 'upgrade' || event.event_name === 'upgrade_ended') {
                        this.scheduleUpgradeReconnect();
                    }
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
            this.markAttemptSettled(generation);
            this.opts.retry?.restartLadder();
            this.setStatus({ state: 'connected', error: undefined, nextRetryAt: undefined }, { generation });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            // Failure exit closes the sync phase with this attempt's token.
            this.opts.sync.end(syncToken);
            this.markAttemptSettled(generation);
            if (err instanceof TerminalAttemptError) return; // status already failed
            if (!this.isCurrent(generation)) return;
            session?.destroy();
            if (session) this.session = null;
            if (err instanceof ApiSessionError && err.code === 'superseded') return;
            this.handleFailure(generation, message);
        }
    }

    private handleSessionClose(generation: number, close: ApiSessionClose): void {
        if (!this.isCurrent(generation)) return;
        this.markAttemptSettled(generation);
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
        // 'failed' is reserved for a stop this layer knows about: an explicit stop,
        // or a relay whose API version can never be fixed by retrying. Whether the
        // APP will retry is not protocol knowledge — the shared scheduler decides
        // that and reports the terminal outcome itself when it declines, so this
        // layer stays silent rather than competing with it.
        if (this.stopped) {
            this.setStatus({ state: 'failed', error }, { generation });
            return;
        }
        // Two outcomes, nothing else: stop trying, or hand the attempt to the
        // shared scheduler. The ladder, the countdown, the status write and the
        // wipe that must happen while the client waits all belong to the app, not
        // to the protocol layer.
        this.opts.retry?.scheduleRetry(error, generation);
    }

    /** Legacy parity for upgrade/upgrade_ended: reconnect ~2 s after the
     *  signal so WeeChat's restarted relay has time to listen again. The
     *  2 s timer replaces any slower backoff retry scheduled by the close. */
    private scheduleUpgradeReconnect(): void {
        if (this.stopped) return;
        if (this.upgradeTimer !== null) clearTimeout(this.upgradeTimer);
        this.upgradeTimer = setTimeout(() => {
            this.upgradeTimer = null;
            if (!this.stopped) this.reconnectNow(true);
        }, 2000);
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
        if (this.upgradeTimer !== null) {
            clearTimeout(this.upgradeTimer);
            this.upgradeTimer = null;
        }
        // The retry timer is no longer this object's, but stopping or taking over
        // an attempt still has to reach it.
        this.opts.retry?.cancelPendingRetry();
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
            attempt: this.opts.retry?.attemptNumber() ?? 0,
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
