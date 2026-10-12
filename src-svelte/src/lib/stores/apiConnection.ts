// Connection orchestration for the Relay API transport.
//
// Reached through the connectionManager facade when the API relay is selected
// (WeeChat >= 4.10.1). Every wire interaction goes through the generation-
// scoped ApiOrchestrator + api-features request layer. Buffer ids arriving
// from components are store keys — String(apiBufferId) — and are converted
// HERE, the single central point (identity rule). The legacy transport lives
// in legacyConnection.ts and keeps its own pointer-keyed ids.

import { get } from 'svelte/store';
import {
    setConnectionStatus, setErrors, clearErrors, disconnect as disconnectStore,
    connectionState, recordBytesReceived, recordBytesSent, resetReconnectAttempts,
    setReconnectAttempts, setNextReconnectAt,
} from '#lib/stores/connectionStore.ts';
import { buffers, activeBufferId, getBuffer, connected, setActiveBuffer, beginSyncPhase, endSyncPhase, weechatVersion, relayApiVersion, hasNoHistoryToFetch, markHistoryComplete } from '#lib/stores/models.ts';
import { settings } from '#lib/stores/settings.ts';
import { addToast, removeToast, updateToast, toastStore } from '#lib/toast.ts';

import { resolveApiEndpoint } from '#lib/api/api-endpoint.ts';
import { ApiOrchestrator, type OrchestratorStatus } from '#lib/api/api-orchestrator.ts';
import { createApiStoreReducers, flushApiLineBatch } from '#lib/api/api-store-reducers.ts';
import { mapHotlist, applyNicklistRoot } from '#lib/api/api-mapping.ts';
import { fetchHistory, sendInput, clearHiddenLineIdTracking, type InputOutcome } from '#lib/api/api-features.ts';
import { validateScript } from '#lib/api/api-validation.ts';
import { applyRetainedHandoff, hasRetainedViewForActiveProfile, markCaptureIntent } from '#lib/stores/retainedChat.ts';
import {
    HOTLIST_DEBOUNCE_MS,
    RECONNECT_BACKOFF,
    hotlistPollInterval,
    cleanupFocusReconnect as sharedCleanupFocusReconnect,
    clearDisconnectToast,
    countdownText,
    findDisconnectToast,
    resetAppState,
    showDisconnectToast as sharedShowDisconnectToast,
    type ConnectionProfile,
    type PendingRetry,
    type TransportAdapter,
} from '#lib/stores/connectionLifecycle.ts';
import { clearHistoryOutcomes } from '#lib/stores/historyState.ts';
import type { ApiSession } from '#lib/api/api-session.ts';
import type { ApiBufferId } from '#lib/api/api-ids.ts';
import { DEBUG_NICKLIST, DEBUG_WEECHAT_COMMANDS, DEBUG_CONNECTION } from '#lib/debug.ts';
import { classifyConnectionFailure } from '#lib/utils/connectionFailure.ts';

let orchestrator: ApiOrchestrator | null = null;
let hotlistInterval: ReturnType<typeof setInterval> | null = null;

let connectionData: ConnectionProfile | null = null;
let connecting = false;
let manualReconnectRequested = false;
// Byte accounting deltas per session (ApiSession counts JSON frame lengths).
let lastRecordedSent = 0;
let lastRecordedReceived = 0;

/** Hotlist poll interval is shared configuration; re-exported so callers that
 *  import this transport keep working unchanged. */
export { setHotlistPollInterval } from '#lib/stores/connectionLifecycle.ts';

/** Central store-key → API id conversion. Components pass store keys
 *  (String(apiBufferId)); nothing else may parse ids. */
function toApiBufferId(bufferId: string | undefined): ApiBufferId | null {
    if (!bufferId) return null;
    const n = Number(bufferId);
    return Number.isSafeInteger(n) && n > 0 ? (n as ApiBufferId) : null;
}

function currentSession(): ApiSession | null {
    return orchestrator?.getSession() ?? null;
}

// Comprehensive cleanup for any disconnection path.
// Does NOT touch connectionData (needed by reconnect) and does NOT set
// connection status (caller decides based on context).
//
// `retainGeneration` is passed only by unexpected-loss call sites, and only
// alongside a `markCaptureIntent()`. Explicit `disconnect()` calls this with no
// argument and no intent, which is what keeps a user-initiated departure from
// leaving a retained view behind.
/**
 * Which orchestrator statuses are the unexpected loss of a session that had
 * actually reached its bootstrap — the only kind worth retaining.
 *
 * 'reconnecting' is not proof of a previous session: the orchestrator labels
 * every attempt after the first that way, so a failed FIRST connect arrives here
 * too. 'disconnected' is the status `orchestrator.stop()` produces, i.e. our own
 * `disconnect()`, so it is never a loss. 'failed' is a loss only when a session
 * existed — the same gate that branch uses for its disconnect toast.
 */
export function shouldRetainOnStatus(
    state: OrchestratorStatus['state'],
    wasEverConnected: boolean,
    hasConnectionData: boolean,
): boolean {
    switch (state) {
    case 'reconnecting': return wasEverConnected;
    case 'failed': return wasEverConnected && hasConnectionData;
    default: return false;
    }
}

/** Test seam for the wipe itself, so a unit test can assert capture ORDER
 *  (drain, capture, wipe) against the real function instead of a
 *  reimplementation. Application code must not call this: loss call sites go
 *  through the status branches that also declare capture intent. */
export const __resetAllStateForTest = resetAllState;

function resetAllState(retainGeneration?: number) {
    // See the legacy note: buffer ids are per-session and reused, so a history
    // outcome cannot be carried across a generation boundary.
    clearHistoryOutcomes();
    // No hotlist baseline will arrive for a closed connection: never leave
    // the sync phase open across a disconnect.
    endSyncPhase();
    connecting = false;
    if (hotlistInterval) {
        clearInterval(hotlistInterval);
        hotlistInterval = null;
    }
    if (hotlistDebounceTimer) {
        clearTimeout(hotlistDebounceTimer);
        hotlistDebounceTimer = null;
    }
    // Drain the frame's queued line events before wiping state, so nothing is
    // left pending for the next session to apply against reused buffer ids. The
    // drain must precede the wipe: after it there is nothing left to drain into.
    flushApiLineBatch();
    resetAppState(retainGeneration);
    // Line ids restart from a low counter in a new session: drop the
    // per-buffer seen-hidden-line tracking so nothing dedupes against stale ids.
    clearHiddenLineIdTracking();
}

function flushByteStats(): void {
    const session = currentSession();
    if (!session) return;
    if (session.bytesSent > lastRecordedSent) {
        recordBytesSent(session.bytesSent - lastRecordedSent);
        lastRecordedSent = session.bytesSent;
    }
    if (session.bytesReceived > lastRecordedReceived) {
        recordBytesReceived(session.bytesReceived - lastRecordedReceived);
        lastRecordedReceived = session.bytesReceived;
    }
}

/**
 * Name one connection failure with the flag the UI can explain. The message
 * table lives in classifyConnectionFailure; `nameTransient` decides what a
 * transport-level failure becomes — false while a retry loop is live, true once
 * it has stopped.
 */
function mapFailureToError(message: string, nameTransient = true): void {
    const named = classifyConnectionFailure(message, nameTransient);
    if (named) setErrors(named);
}

function startHotlistPolling(): void {
    if (hotlistInterval) clearInterval(hotlistInterval);
    hotlistInterval = setInterval(() => void pollHotlist(), hotlistPollInterval());
}

async function pollHotlist(): Promise<void> {
    const session = currentSession();
    if (!session) return;
    try {
        const res = await session.request({ method: 'GET', path: '/api/hotlist' });
        if (res.code === 200) {
            const reducers = createApiStoreReducers();
            mapHotlist(res.body, reducers);
        }
        flushByteStats();
    } catch {
        // Session dropped between polls; the orchestrator owns reconnection.
    }
}

export async function connect(profile: ConnectionProfile): Promise<void> {
    const { host, port, path, tls } = profile;
    // Manual reconnect takeover while auto-reconnect is pending.
    if (manualReconnectRequested) {
        manualReconnectRequested = false;
    }
    if (connecting && orchestrator) {
        if (DEBUG_CONNECTION) console.log('[connect] already connecting, skipping duplicate');
        return;
    }
    connecting = true;
    clearErrors();
    connectionData = profile;
    setConnectionStatus('connecting');

    const endpoint = resolveApiEndpoint({ host, port, tls, path: path || undefined });
    lastRecordedSent = 0;
    lastRecordedReceived = 0;

    const previous = orchestrator;
    previous?.dispose();

    return new Promise<void>((resolve, reject) => {
        let settled = false;
        const orch = new ApiOrchestrator({
            endpoint,
            getPassword: () => connectionData?.password ?? '',
            reducers: createApiStoreReducers(),
            sync: { begin: () => beginSyncPhase(), end: (token) => endSyncPhase(token) },
            // TOTP codes are single-use: a TOTP connection must not silently
            // retry with a stale code (legacy parity).
            autoReconnect: () => get(settings).autoconnect && !get(settings).useTotp,
            // Legacy parity: 30 s initial, ×1.5, capped at 5 min.
            backoff: RECONNECT_BACKOFF,
            onStatus: (status) => handleOrchestratorStatus(status, orch),
        });
        orchestrator = orch;

        const handleOrchestratorStatus = (status: OrchestratorStatus, owner: ApiOrchestrator) => {
            if (owner !== orchestrator) return; // stale generator
            // Publish the version the orchestrator fetched from the relay so
            // the UI (TopBar, settings footer) can show WeeChat / Relay API
            // versions. The status merge carries serverVersion forward, so
            // this republishes on every state change until a reset clears it.
            const sv = status.serverVersion;
            if (sv) {
                weechatVersion.set(sv.weechat_version.split('.').map((c) => parseInt(c, 10)));
                relayApiVersion.set(sv.relay_api_version);
            }
            switch (status.state) {
            case 'connecting':
            case 'bootstrapping':
                setConnectionStatus('connecting');
                break;
            case 'connected':
                connecting = false;
                // A live session has no failure left to explain. A flag left over
                // from an earlier attempt would make the NEXT outage read as the
                // old one — a clock that was fixed between attempts would go on
                // being reported as clock skew.
                clearErrors();
                // Same ordering as the legacy path: seed the retained window into
                // the buffers this bootstrap just published, then let the view see
                // a live connection. Bootstrap has published the buffer list by
                // the time the orchestrator reports `connected`.
                applyRetainedHandoff();
                setConnectionStatus('connected');
                connectionState.update((current) => ({ ...current, wasEverConnected: true, userDisconnect: false }));
                connected.set(true);
                resetReconnectAttempts();
                setNextReconnectAt(undefined);
                clearReconnectToasts();
                startHotlistPolling();
                flushByteStats();
                if (!settled) { settled = true; resolve(); }
                break;
            case 'reconnecting':
                connecting = false;
                // Name a failure the loop cannot fix by trying again (a clock that
                // disagrees with the server, TOTP): without this, a relay that will
                // never accept this client retries quietly forever and the only
                // trace of why is in the console. A transport-level failure stays
                // unnamed so the banner keeps saying "Connection lost. Retrying…",
                // which is what a dropped session actually is.
                mapFailureToError(status.error ?? 'connection failed', false);
                setConnectionStatus('reconnecting');
                connected.set(false);
                setReconnectAttempts(status.attempt);
                setNextReconnectAt(status.nextRetryAt);
                // 'reconnecting' also follows a failed FIRST connect (the
                // orchestrator labels attempt > 0 this way), so a session must
                // have reached its bootstrap before there is anything to retain.
                if (shouldRetainOnStatus(status.state, get(connectionState).wasEverConnected, !!connectionData)) {
                    markCaptureIntent();
                }
                resetAllState(status.generation);
                // After the wipe, not before: the retained view only exists once
                // the wipe has taken its snapshot, and the toast defers to it.
                // Safe because showReconnectToast reads `connectionData` and
                // `settings`, neither of which resetAllState touches.
                showReconnectToast(status);
                if (!settled) { settled = true; reject(new Error(status.error ?? 'connection failed')); }
                break;
            case 'disconnected':
                connecting = false;
                setConnectionStatus('disconnected');
                connected.set(false);
                if (!settled) { settled = true; resolve(); }
                break;
            case 'failed':
                connecting = false;
                setConnectionStatus('error');
                connected.set(false);
                mapFailureToError(status.error ?? 'connection failed');
                // Same gate as the toast below: a session that was lost, not a
                // first connect that never produced one.
                if (shouldRetainOnStatus(status.state, get(connectionState).wasEverConnected, !!connectionData)) {
                    markCaptureIntent();
                }
                resetAllState(status.generation);
                // After the wipe so the toast can see whether the banner will
                // already be showing this loss.
                if (get(connectionState).wasEverConnected && connectionData) showDisconnectToast(connectionData);
                if (!settled) { settled = true; reject(new Error(status.error ?? 'connection failed')); }
                break;
            }
        };

        orch.start();
    });
}

// Show a persistent disconnect toast with reconnect button.
function showDisconnectToast(connInfo: ConnectionProfile) {
    sharedShowDisconnectToast(connInfo, () => triggerManualReconnect(false));
}

// Countdown toast while the orchestrator schedules the next attempt.
function showReconnectToast(status: OrchestratorStatus) {
    if (!connectionData) return;
    // The banner owns this presentation whenever a retained view is on screen.
    if (hasRetainedViewForActiveProfile()) return;
    // A 'reconnecting' status without nextRetryAt means an attempt is already
    // in flight (not scheduled) — the existing countdown toast stands until
    // the attempt resolves; stacking another one here is wrong.
    if (status.nextRetryAt === undefined) return;
    if (!get(settings).autoconnect) {
        showDisconnectToast(connectionData);
        return;
    }
    const { host, port } = connectionData;
    const nextAt = status.nextRetryAt ?? Date.now();
    const existingToast = findDisconnectToast(host, port);
    if (existingToast) {
        updateToast(existingToast.id, { messageFn: () => countdownText(nextAt) });
    } else {
        addToast(
            `Disconnected from ${host}:${port}`,
            {
                type: 'warning',
                duration: 0,
                messageFn: () => countdownText(nextAt),
                buttons: [{
                    text: 'Reconnect',
                    action: () => triggerManualReconnect(false)
                }]
            }
        );
    }
}

function clearReconnectToasts(): void {
    if (!connectionData) return;
    clearDisconnectToast(connectionData);
}

// Manual reconnect triggered by toast button — resets backoff and tries now.
function triggerManualReconnect(resetAttempts = false) {
    const toasts = get(toastStore);
    const lastToast = toasts[toasts.length - 1];
    if (lastToast) removeToast(lastToast.id);
    setNextReconnectAt(undefined);
    if (resetAttempts) resetReconnectAttempts();
    manualReconnectRequested = true;
    if (orchestrator) {
        resetAllState();
        orchestrator.reconnectNow(resetAttempts);
    } else if (connectionData) {
        void connect(connectionData).catch(() => undefined);
    }
}

/** True while an attempt is in flight, so a second Retry click cannot stack a
 *  third attempt on top of one already running. False during the backoff wait
 *  between attempts — that is exactly when a retry is worth taking over. */
export function isAttemptInProgress(): boolean {
    if (!orchestrator) return false;
    const state = orchestrator.currentStatus.state;
    return state === 'connecting' || state === 'bootstrapping';
}

/**
 * This transport's answer to "is a retry scheduled, and when?".
 *
 * The API transport keeps the schedule as orchestrator status rather than a timer
 * handle it owns, so the mapping is a status read. See the legacy transport for the
 * same question answered from a `setTimeout`.
 */
function pendingRetry(): PendingRetry {
    const status = orchestrator?.currentStatus;
    if (!orchestrator || !connectionData || !status || status.state !== 'reconnecting') {
        return { active: false };
    }
    return { active: true, nextRetryAt: status.nextRetryAt };
}

/**
 * This transport's `TransportAdapter` — the lifecycle's view of it.
 *
 * Thin reads of state this module already owns. The API transport keeps its retry
 * schedule inside the orchestrator rather than in a timer it holds, which is why
 * `pendingRetry` and `isAttemptInProgress` are status reads here and timer reads in
 * the legacy transport — the adapter exists so the shared layer never has to know
 * that difference exists.
 */
export const transportAdapter: TransportAdapter = {
    kind: 'api',
    open: (profile) => connect(profile),
    teardown: () => disconnect(),
    hasLiveSession: () => currentSession() !== null,
    isAttemptInProgress: () => isAttemptInProgress(),
    // Both halves are required: an orchestrator with no profile has nothing to
    // reconnect to, and a profile with no orchestrator has no loop to take over.
    hasRetryLoop: () => orchestrator !== null && connectionData !== null,
    manualReconnect: (resetAttempts) => triggerManualReconnect(resetAttempts),
    pendingRetry,
};

export const cleanupFocusReconnect = sharedCleanupFocusReconnect;

export async function requestNicklist(bufferId: string) {
    const session = currentSession();
    const apiId = toApiBufferId(bufferId);
    if (!session || apiId === null) {
        if (DEBUG_NICKLIST) console.log('[nicklist] requestNicklist skipped - no live session');
        return;
    }
    try {
        const res = await session.request({ method: 'GET', path: `/api/buffers/${apiId}/nicks?colors=weechat` });
        if (DEBUG_NICKLIST) console.log('[nicklist] response code:', res.code);
        if (res.code === 200) {
            // Authoritative replace (legacy `fresh` parity): nick deltas may
            // have left a partial or stale list behind, so clear before the
            // snapshot is applied and only then mark the buffer fetched.
            flushApiLineBatch();
            buffers.update((current) => {
                const buffer = current[bufferId];
                if (!buffer) return current;
                return { ...current, [bufferId]: { ...buffer, nicklist: {} } };
            });
            applyNicklistRoot(res.body, apiId, createApiStoreReducers());
            flushApiLineBatch();
            buffers.update((current) => {
                const buffer = current[bufferId];
                if (!buffer) return current;
                return { ...current, [bufferId]: { ...buffer, nicklistFetched: true } };
            });
        }
        flushByteStats();
    } catch (err) {
        if (DEBUG_NICKLIST) console.error('[nicklist] request failed:', err);
    }
}

/** Installed script names, or null when the listing is unavailable or failed.
 *  `null` means "unknown": a caller must not conclude a script is missing. */
export async function listScripts(): Promise<string[] | null> {
    const session = currentSession();
    if (!session) return null;
    try {
        const res = await session.request({ method: 'GET', path: '/api/scripts' });
        if (res.code !== 200 || !Array.isArray(res.body)) return null;
        const names = res.body.flatMap((raw) => {
            const v = validateScript(raw);
            return v.value ? [v.value.name] : [];
        });
        flushByteStats();
        return names;
    } catch {
        return null;
    }
}

const pendingFetchBuffers = new Set<string>();

export async function fetchMoreLines(numLines: number = 0, explicitBufferId?: string): Promise<void> {
    const session = currentSession();
    if (!session) throw new Error('Not connected');

    const bufferId = explicitBufferId ?? get(activeBufferId);
    const buffer = getBuffer(bufferId);
    if (!buffer) throw new Error('No active buffer');
    const apiId = toApiBufferId(buffer.id);
    if (apiId === null) return;

    if (buffer.allLinesFetched) return;

    // Free buffers (/exec -nf, plugin output) have no older history — their rows
    // are live-only, so asking for history would re-deliver the current rows as
    // duplicates. Mark them complete instead of issuing a lines request.
    if (hasNoHistoryToFetch(buffer)) {
        markHistoryComplete(bufferId);
        return;
    }
    if (pendingFetchBuffers.has(buffer.id)) return;
    pendingFetchBuffers.add(buffer.id);

    numLines = Math.max(numLines, buffer.requestedLines * 2);

    try {
        const result = await fetchHistory(session, { bufferId: apiId, count: numLines });
        // Re-read the buffer after the await: a clear/close/reconnect during
        // the request makes the response stale (fetchHistory already dropped
        // it — applied=false — and nothing may be written from here).
        const freshBuffer = getBuffer(bufferId);
        if (!freshBuffer || result.applied === false) return;
        flushApiLineBatch();
        buffers.update(current => {
            const buf = current[bufferId];
            if (!buf) return current;
            return {
                ...current,
                [bufferId]: {
                    ...buf,
                    allLinesFetched: result.complete,
                },
            };
        });
        flushByteStats();
    } catch (err) {
        // Don't mark allLinesFetched=true for transient errors — only when
        // WeeChat explicitly returned fewer lines than requested.
        console.warn('[fetchMoreLines] fetch failed, will retry on next attempt:', String(err));
    } finally {
        pendingFetchBuffers.delete(buffer.id);
    }
}

async function deliverInput(command: string, bufferId?: string): Promise<InputOutcome | null> {
    const session = currentSession();
    if (!session) {
        console.warn('[sendWeeChatCommand] not connected');
        return null;
    }
    const apiId = toApiBufferId(bufferId);
    // Global commands (no target) go to core.weechat explicitly; the endpoint
    // would otherwise fall back to the main buffer.
    if (bufferId === undefined) {
        const res = await sendInputNamed(session, 'core.weechat', command);
        flushByteStats();
        return res;
    }
    const res = await sendInput(session, apiId, command);
    flushByteStats();
    if (!res.accepted && DEBUG_WEECHAT_COMMANDS) {
        console.warn('[sendWeeChatCommand] rejected:', res.error);
    }
    return res;
}

async function sendInputNamed(session: ApiSession, bufferName: string, command: string): Promise<InputOutcome> {
    const res = await session.request({ method: 'POST', path: '/api/input', body: { buffer_name: bufferName, command } });
    if (res.code === 204 || res.code === 200) return { accepted: true, status: res.code };
    const detail = typeof res.body === 'string' ? res.body : JSON.stringify(res.body ?? '');
    return { accepted: false, status: res.code, error: detail || `input rejected (code ${res.code})` };
}

// Deliver one WeeChat command. Resolves false when rejected or not connected.
export async function sendWeeChatCommand(command: string, bufferId?: string): Promise<boolean> {
    const res = await deliverInput(command, bufferId);
    return res?.accepted === true;
}

// Debounce hotlist queries: coalesce rapid buffer switches into a single request.
let hotlistDebounceTimer: ReturnType<typeof setTimeout> | null = null;


export async function switchBuffer(bufferId: string): Promise<boolean> {
    if (!currentSession()) return false;
    const buffer = getBuffer(bufferId);
    // Fetch lines for buffers that need historical context before switching.
    if (buffer && (buffer.lastSeen < 0 || buffer.lines.length < 20) && buffer.requestedLines < 100) {
        try {
            await fetchMoreLines(100, bufferId);
        } catch {
            // Silently ignore fetch failures on buffer switch
        }
    }
    const success = setActiveBuffer(bufferId);
    if (!success) return false;
    // Defer hotlist/unread clear until after the scroll effect (rAF) has run,
    // so lastSeen calculation uses the correct localUnread before it's zeroed.
    requestAnimationFrame(() => {
        void deliverInput('/buffer set hotlist -1', bufferId);
        // `/buffer set unread` with no argument puts the read marker on the buffer's
        // last line, so `last_read_line_id` is a real line id that other clients and
        // our own re-anchoring can act on; `/buffer set unread 0` removes the marker
        // and leaves -1. The `/input set_unread_current_buffer` we used to send is a
        // WeeChat 3.8 alias for exactly this command (core-command.c).
        void deliverInput('/buffer set unread', bufferId);
        scheduleHotlistQuery();
    });
    return true;
}

// Schedule a hotlist query with debounce — rapid switches coalesce.
function scheduleHotlistQuery(): void {
    if (hotlistDebounceTimer) clearTimeout(hotlistDebounceTimer);
    hotlistDebounceTimer = setTimeout(() => {
        hotlistDebounceTimer = null;
        void pollHotlist();
    }, HOTLIST_DEBOUNCE_MS);
}

export async function sendBufferCommand(bufferId: string, command: string) {
    await deliverInput(command, bufferId);
}

export async function closeBufferOnWeeChat(bufferId: string) {
    await deliverInput('/close', bufferId);
}

export async function pinBuffer(bufferId: string) {
    await deliverInput('/buffer set localvar_set_pinned true', bufferId);
}

export async function unpinBuffer(bufferId: string) {
    await deliverInput('/buffer set localvar_set_pinned false', bufferId);
}

// Deliver one chat message to the active buffer. Resolves false on rejection
// so callers keep the draft (send-failure behavior).
export async function sendMessage(message: string): Promise<boolean> {
    const session = currentSession();
    if (!session) return false;
    const apiId = toApiBufferId(get(activeBufferId));
    const res = await sendInput(session, apiId, message);
    flushByteStats();
    return res.accepted;
}

export function disconnect() {
    // Local disconnect only — never /quit; WeeChat must not be shut down by
    // a client leaving.
    orchestrator?.stop();
    orchestrator = null;
    connectionData = null;
    resetAllState();
    disconnectStore();
    setConnectionStatus('disconnected');
}

// Current live session for feature callers (completion, history, imgur
// follow-ups); null while disconnected. Replaces the legacy getWs().
export function getSession(): ApiSession | null {
    return currentSession();
}
