/**
 * Shared, protocol-agnostic connection lifecycle.
 *
 * The two transports (`legacyConnection.ts`, `apiConnection.ts`) carry parallel
 * copies of the same lifecycle glue — backoff math, disconnect/countdown toasts,
 * focus reconnect, retry gating, the store wipe — and a behavioural fix has to be
 * made in both files and kept in sync by hand. This module is where that shared
 * layer converges.
 *
 * The dependency direction is strict and one-way:
 *
 *   connectionLifecycle  <-  apiConnection / legacyConnection  <-  connectionManager
 *
 * This file never imports a transport, and never imports the facade. A transport
 * imports this module; the facade selects which transport is active. Anything that
 * knows how to speak a protocol — handshake, frame grammar, send/receive, history,
 * nicklist — stays in the transport that owns it.
 *
 * What deliberately stays per-transport, even though it looks duplicated:
 *
 *   `connectionData`  the profile a scheduled retry will reconnect to, which is this
 *                     transport's retry to run.
 *   `connecting`,
 *   `manualReconnectRequested`  whether THIS transport has an attempt in flight.
 *                     Shared, one transport's handshake would silence the other's
 *                     Retry button.
 *   `hotlistDebounceTimer`  a pending debounce is work this transport still owes.
 *
 * Sharing mutable state is not the goal of this module; sharing *rules* is. A value
 * that describes one transport's in-flight work has no correct shared value, and
 * making that ownership explicit is the job of the transport adapter rather than of
 * this file. `hotlistPollIntervalMs` below is the opposite case and IS shared: it is
 * configuration the facade already sets on both transports to the same value, with no
 * per-transport meaning.
 */

import { get } from 'svelte/store';
import { addToast, removeToast, toastStore, updateToast, type Toast } from '#lib/toast.ts';
import { activeTransport, connectionState, incrementReconnectAttempts, resetReconnectAttempts, setConnectionStatus, setErrors, setNextReconnectAt, type RelayTransportKind } from '#lib/stores/connectionStore.ts';
import { classifyConnectionFailure } from '#lib/utils/connectionFailure.ts';
import { DEBUG_CONNECTION } from '#lib/debug.ts';
import { settings } from '#lib/stores/settings.ts';
import { captureRetainedState, consumeCaptureIntent, hasRetainedViewForActiveProfile, markCaptureIntent } from '#lib/stores/retainedChat.ts';
import { onDisconnect } from '#lib/notifications.ts';
import {
    activeBufferId,
    bufferBottom,
    buffers,
    connected,
    hotlistClearedBuffers,
    localUnreadBuffers,
    pendingBufferSwitch,
    previousBufferId,
    relayApiVersion,
    servers,
    weechatVersion,
} from '#lib/stores/models.ts';

/**
 * Where to connect, as a named thing.
 *
 * This used to be a positional 6-tuple duplicated in both transports, which meant
 * the password was `connectionData?.[3]` and a reordered argument was a silent
 * type-compatible bug: `host` and `path` are both strings, `tls` and
 * `noCompression` are both booleans, and nothing in the compiler would notice.
 */
export interface ConnectionProfile {
    host: string;
    port: number;
    path: string;
    password: string;
    tls: boolean;
    noCompression: boolean;
}

// ---------------------------------------------------------------------------
// Backoff ladder
// ---------------------------------------------------------------------------

/**
 * The retry ladder both transports use: 30s, then x1.5, capped at 5 minutes,
 * retried indefinitely. There is no attempt ceiling, so the UI must show the
 * attempt count and the next attempt time — never "attempt N of M".
 *
 * It was written out twice (once as three constants in the legacy transport, once
 * as an inline policy object in the API transport), which meant a tuning change
 * had to be made in two places and could quietly desync the two transports.
 */
export const RECONNECT_BACKOFF = { baseMs: 30_000, maxMs: 300_000, factor: 1.5 };

/**
 * Delay before a retry, where `attempt` is the number of retries that have
 * ALREADY failed — the first retry is `attempt 0` and waits `baseMs`.
 *
 * The zero-based convention is the API orchestrator's, because it owns its counter
 * as a private field. The legacy transport counts attempts 1-based because that
 * count is displayed to the user as "attempt 1", so its call sites subtract one.
 * Getting this wrong shifts every retry interval by one whole step and looks like
 * a working ladder until you compare the two transports side by side.
 */
export function reconnectDelay(attempt: number): number {
    return Math.min(
        RECONNECT_BACKOFF.baseMs * Math.pow(RECONNECT_BACKOFF.factor, attempt),
        RECONNECT_BACKOFF.maxMs,
    );
}

// ---------------------------------------------------------------------------
// Pending retry — the seam between the two transports' retry state
// ---------------------------------------------------------------------------

/**
 * "Is a retry scheduled, and when does it fire?" as one answer.
 *
 * Each transport keeps its retry bookkeeping in the shape its own machinery wants:
 * legacy holds a `setTimeout` handle plus `connectionState.nextReconnectAt`, the
 * API transport holds the orchestrator's status. Everything that only needs to
 * know *whether* to wait, and for how long, should not have to know which of
 * those two representations it is looking at.
 */
export interface PendingRetry {
    active: boolean;
    nextRetryAt?: number;
}

/**
 * The seam between the shared lifecycle and a protocol.
 *
 * Everything the lifecycle must be able to ask a transport, and nothing about how
 * a protocol is spoken. `sendMessage`, `pinBuffer`, `fetchMoreLines` and the rest
 * of the wire surface deliberately stay on the transport module: the lifecycle has
 * no business dispatching them, and adding them here would turn the adapter into a
 * second facade with a second set of transport branches.
 */
export interface TransportAdapter {
    readonly kind: RelayTransportKind;
    /** Open a fresh connection. Resolves on connect; rejects on terminal failure. */
    open(profile: ConnectionProfile): Promise<void>;
    /**
     * Close this transport's live session and clear its own retry state (armed
     * timer, captured profile). Does NOT wipe app stores — that is `resetAppState`.
     */
    teardown(): void;
    /**
     * Cancel everything this transport might still do — an armed retry timer, an
     * in-flight handshake, a live socket — without wiping app stores and without
     * recording a user-initiated disconnect.
     *
     * `teardown()` is the wrong tool for this: it marks `userDisconnect`, which
     * makes `retryAvailability()` answer 'no-retry-loop' for the session that is
     * about to start, and it wipes the stores that session is about to fill.
     */
    quiesce(): void;
    /** A live session exists. */
    hasLiveSession(): boolean;
    /** A handshake is in flight, so a Retry click cannot stack a second attempt. */
    isAttemptInProgress(): boolean;
    /** A retry loop exists that "Retry now" may take over. */
    hasRetryLoop(): boolean;
    /** Take over the pending attempt immediately; `resetAttempts` also rewinds the ladder. */
    manualReconnect(resetAttempts: boolean): void;
    /** Is a backoff retry scheduled, and when? */
    pendingRetry(): PendingRetry;
}

const adapters = new Map<RelayTransportKind, TransportAdapter>();

/**
 * Register a transport's adapter. The facade calls this: it is the only module
 * that imports both transports.
 *
 * The registry is keyed by kind, and "which one is active" is answered by the
 * existing `activeTransport` store rather than by a second slot owned here. A
 * lifecycle-owned "current adapter" would be a second source of one fact, and the
 * two would drift the moment one was updated without the other — which is the
 * failure mode the whole module exists to remove.
 */
export function registerTransportAdapter(adapter: TransportAdapter): void {
    adapters.set(adapter.kind, adapter);
}

export function transportAdapterFor(kind: RelayTransportKind | null): TransportAdapter | null {
    return kind ? adapters.get(kind) ?? null : null;
}

/** The adapter for the transport the facade currently serves. */
export function activeTransportAdapter(): TransportAdapter | null {
    return transportAdapterFor(get(activeTransport));
}

/**
 * Manual "Retry now" outcomes. The caller must distinguish "a click did nothing"
 * from "this needs a credential the user must type", because only the latter has
 * to route to the connection form.
 */
export type RetryNowOutcome = 'retried' | 'in-progress' | 'no-retry-loop' | 'needs-credentials';

/** The same question without performing it, so the banner's button state and a
 *  refused command are one decision made in one place. */
export type RetryAvailability = 'available' | 'in-progress' | 'no-retry-loop' | 'needs-credentials';

/**
 * Whether a "Retry now" would be accepted, without performing it.
 *
 * Order matters and each guard is a different reason:
 * - no adapter: nothing was ever connected, or a Leave ended the session.
 * - `userDisconnect`: a Leave ends the retry loop and the retained view with it;
 *   retrying from here would reconnect to a profile the user deliberately left.
 * - TOTP: codes are single-use and expire. Reusing the captured one produces an
 *   auth error the user cannot interpret, so route them to explicit credential
 *   entry — the same reason the transports refuse to auto-reconnect on TOTP.
 */
export function retryAvailability(): RetryAvailability {
    const adapter = activeTransportAdapter();
    if (!adapter) return 'no-retry-loop';
    if (get(connectionState).userDisconnect) return 'no-retry-loop';
    if (get(settings).useTotp) return 'needs-credentials';
    if (adapter.isAttemptInProgress()) return 'in-progress';
    return adapter.hasRetryLoop() ? 'available' : 'no-retry-loop';
}

/**
 * Manual "Retry now" for the retained shell.
 *
 * Delegates to the active adapter's own takeover path and NEVER through the
 * facade's connect(): connect() re-probes the relay, and a probe that fails
 * mid-retry would silently move a session onto the other protocol — the
 * mid-connection fallback the dual-protocol rule forbids. The adapters' takeover
 * cancels any scheduled retry before starting, so a click replaces the pending
 * attempt instead of adding a second loop.
 */
export function retryNow(): RetryNowOutcome {
    const availability = retryAvailability();
    if (availability !== 'available') return availability;
    const adapter = activeTransportAdapter();
    if (!adapter) return 'no-retry-loop';
    adapter.manualReconnect(false);
    return 'retried';
}

/** Only cut in front of a scheduled retry when the wait left is longer than this. */
const FOCUS_RECONNECT_THRESHOLD_MS = 10_000;

let focusReconnectCleanup: (() => void) | null = null;

/**
 * Reconnect as soon as the tab regains visibility, instead of making the user
 * watch a 4-minute countdown they could have skipped.
 *
 * `pendingRetry` and `reconnectNow` are supplied by the transport so this stays
 * protocol-agnostic. A TOTP code is single-use: cutting in front of the backoff
 * would spend a code the user has not entered, so the countdown is left alone.
 */
export function registerFocusReconnect(
    pendingRetry: () => PendingRetry,
    reconnectNow: () => void,
): void {
    if (typeof document === 'undefined') return;
    // Guard against double-registration: two listeners would fire two attempts.
    if (focusReconnectCleanup) return;

    const handler = () => {
        if (document.visibilityState !== 'visible') return;
        const pending = pendingRetry();
        if (!pending.active) return;
        if (get(settings).useTotp) return;
        const remaining = (pending.nextRetryAt ?? 0) - Date.now();
        if (remaining <= FOCUS_RECONNECT_THRESHOLD_MS) return;
        reconnectNow();
    };

    document.addEventListener('visibilitychange', handler);
    focusReconnectCleanup = () => {
        document.removeEventListener('visibilitychange', handler);
        focusReconnectCleanup = null;
    };
}

/**
 * Install the listener for whichever transport is active AT CALL TIME.
 *
 * This indirection is the fix, not a convenience. The facade used to call both
 * transports' `initFocusReconnect()`, and the double-registration guard above is
 * first-wins — so whichever transport registered first owned the listener forever.
 * On a legacy connection the handler asked the (null) API orchestrator whether a
 * retry was pending, always got "no", and the early reconnect silently never
 * happened. Resolving the adapter inside the handler makes the listener ask the
 * transport that is actually serving the session.
 */
export function registerActiveFocusReconnect(): void {
    registerFocusReconnect(
        () => activeTransportAdapter()?.pendingRetry() ?? { active: false },
        () => activeTransportAdapter()?.manualReconnect(true),
    );
}

/** Remove the visibilitychange listener (called on page unmount). */
export function cleanupFocusReconnect(): void {
    if (focusReconnectCleanup) {
        focusReconnectCleanup();
    }
}

// ---------------------------------------------------------------------------
// The application-state wipe
// ---------------------------------------------------------------------------

/**
 * Clear the application state a connection owns.
 *
 * Both transports wipe the same stores in the same order, and the order is the
 * point: the retained snapshot must be taken while the stores still hold the
 * complete session, and every transport-specific drain must already have run.
 * Having that sequence written twice meant a fix to one had to be remembered for
 * the other.
 *
 * Transport-side teardown (pending request callbacks, protocol buffers, timers)
 * stays in the transport that owns it and runs BEFORE this. So does draining any
 * queued protocol lines into the stores: once this runs, there is nothing left to
 * drain into.
 *
 * It does not touch `connectionData` — a scheduled retry still needs the profile
 * it is about to reconnect to — and it does not set the connection status, which
 * the caller decides from context.
 */
export function resetAppState(retainGeneration?: number): void {
    // A buffer switch that never completed must not survive into the next session.
    pendingBufferSwitch.set(null);
    bufferBottom.set(true);

    // Retain the session this wipe is about to destroy, but only when a loss call
    // site declared intent (see retainedChat's loss-intent note). This is the last
    // moment the stores still hold the complete session.
    if (consumeCaptureIntent()) captureRetainedState(retainGeneration ?? null);

    // No stale entries accumulate across reconnects.
    buffers.set({});
    servers.set({});
    localUnreadBuffers.update(() => new Set());
    hotlistClearedBuffers.update(() => new Set());
    activeBufferId.set('');
    previousBufferId.set('');
    connected.set(false);
    // Drop the relay version info so the UI never shows a stale WeeChat
    // version after a disconnect.
    weechatVersion.set([]);
    relayApiVersion.set('');
    onDisconnect();
}

// ---------------------------------------------------------------------------
// Hotlist polling configuration
// ---------------------------------------------------------------------------

/**
 * How often the hotlist is re-polled while connected, and how long a hotlist
 * change is coalesced before it is queried.
 *
 * The interval was a copy in each transport. That was not a bug — the facade
 * already sets both to the same value on every change — but it meant the two
 * could only be kept in step by remembering to. It is shared here because it is
 * configuration rather than lifecycle state: unlike a pending debounce or an
 * in-flight attempt, it carries no per-transport meaning.
 */
const DEFAULT_HOTLIST_POLL_INTERVAL_MS = 15_000;
export const HOTLIST_DEBOUNCE_MS = 2000;

let hotlistPollIntervalMs = DEFAULT_HOTLIST_POLL_INTERVAL_MS;

/** Override the periodic hotlist sync interval (ms). Test hook so e2e tests
 *  do not have to sit through the full 15 s poll cycle; call before connect. */
export function setHotlistPollInterval(ms: number): void {
    hotlistPollIntervalMs = ms;
    // A running interval keeps the period it was armed with, so changing this
    // setting used to take effect only on the next reconnect. Re-arm in place.
    if (hotlistInterval && hotlistPollFn) {
        clearInterval(hotlistInterval);
        hotlistInterval = setInterval(hotlistPollFn, hotlistPollIntervalMs);
    }
}

export function hotlistPollInterval(): number {
    return hotlistPollIntervalMs;
}

// ---------------------------------------------------------------------------
// Disconnect and countdown toasts
// ---------------------------------------------------------------------------

/** The toast text is the identity of a disconnect toast; there is no id to key on. */
function disconnectToastMessage(host: string, port: number): string {
    return `Disconnected from ${host}:${port}`;
}

/** Find an existing disconnect toast for the given host:port. */
export function findDisconnectToast(host: string, port: number): Toast | undefined {
    const needle = disconnectToastMessage(host, port);
    return get(toastStore).find(t => t.type === 'warning' && t.message?.includes(needle)) ?? undefined;
}

/**
 * A persistent "disconnected" toast with a Reconnect button.
 *
 * `onReconnect` is the only part that differs between the transports — each one
 * knows how to restart its own protocol — so it is passed in rather than having
 * the shared module reach back into a transport.
 */
export function showDisconnectToast(profile: ConnectionProfile, onReconnect: () => void): void {
    const { host, port } = profile;
    // The banner owns this presentation whenever a retained view is on screen.
    if (hasRetainedViewForActiveProfile()) return;
    // Prevent stacking multiple disconnect toasts during reconnect cycles.
    if (get(toastStore).some(t => t.type === 'warning' && t.message.includes('Disconnected from'))) {
        return;
    }
    addToast(disconnectToastMessage(host, port), {
        type: 'warning',
        duration: 0,
        buttons: [{
            text: 'Reconnect',
            action: onReconnect,
        }],
    });
}

/** Drop the disconnect toast for this profile, if one is showing. */
export function clearDisconnectToast(profile: ConnectionProfile): void {
    const toast = findDisconnectToast(profile.host, profile.port);
    if (toast) removeToast(toast.id);
}

/**
 * Hotlist polling — one interval and one debounce timer for the whole app.
 *
 * Each transport used to own its own pair. Nothing stopped the timers of a
 * transport that was *replaced* rather than disconnected: `quiesce()` bumps the
 * connection generation so the old socket's `onclose` returns early, and that
 * early return skips `resetAllState()`, which is where both timers were cleared.
 * A poll that outlives its transport keeps querying a relay the user has left.
 * Owning them here is what lets `quiesce()` stop them.
 */
let hotlistInterval: ReturnType<typeof setInterval> | null = null;
let hotlistDebounceTimer: ReturnType<typeof setTimeout> | null = null;
/** The live poll's callback, so an interval-settings change can re-arm it. */
let hotlistPollFn: (() => void) | null = null;

/**
 * Arm the periodic hotlist poll.
 *
 * `hotlistsync` is honoured here. The legacy transport gated its poll on the
 * setting and the API transport polled unconditionally, so turning it off only
 * ever worked against one of the two relays.
 */
export function startHotlistPoll(onPoll: () => void): void {
    if (!get(settings).hotlistsync) return;
    if (hotlistInterval) clearInterval(hotlistInterval);
    hotlistPollFn = onPoll;
    hotlistInterval = setInterval(onPoll, hotlistPollInterval());
}

/** Stop the poll and drop any coalesced query still waiting. */
export function stopHotlistPoll(): void {
    if (hotlistInterval) {
        clearInterval(hotlistInterval);
        hotlistInterval = null;
    }
    // Cleared with the interval: a stored callback is a reference into a
    // transport, and re-arming it after that transport was replaced would poll a
    // relay the user has left.
    hotlistPollFn = null;
    cancelPendingHotlistQuery();
}

/**
 * Coalesce rapid buffer switches into a single hotlist query.
 *
 * `run` is protocol-side — the legacy transport formats an hdata query, the API
 * transport issues a GET — so it is passed in rather than having the shared
 * module reach into a transport.
 */
export function debounceHotlistQuery(run: () => void): void {
    cancelPendingHotlistQuery();
    hotlistDebounceTimer = setTimeout(() => {
        hotlistDebounceTimer = null;
        run();
    }, HOTLIST_DEBOUNCE_MS);
}

export function cancelPendingHotlistQuery(): void {
    if (hotlistDebounceTimer) {
        clearTimeout(hotlistDebounceTimer);
        hotlistDebounceTimer = null;
    }
}

/**
 * The shared half of a manual "reconnect now": drop the toast that was counting
 * down to the next attempt, stop advertising that attempt, optionally restart the
 * ladder. The transport then opens the attempt itself, because only it knows how
 * to start its own protocol.
 */
export function beginManualReconnect(profile: ConnectionProfile, resetAttempts: boolean): void {
    // Precisely the disconnect toast, not "whatever toast happens to be last" —
    // which is what both transports used to remove, and which would have dropped
    // an unrelated toast if one arrived first.
    clearDisconnectToast(profile);
    setNextReconnectAt(undefined);
    if (resetAttempts) resetReconnectAttempts();
}

/** Countdown text for a retry scheduled at `nextRetryAt`. */
export function countdownText(nextRetryAt: number): string {
    return `${Math.max(0, Math.ceil((nextRetryAt - Date.now()) / 1000))}s`;
}

// ---------------------------------------------------------------------------
// The retry scheduler (decision D2)
// ---------------------------------------------------------------------------

/**
 * One retry loop for both transports.
 *
 * It used to exist twice: legacy's `scheduleReconnect()` with a 1-based attempt
 * counter, and the API orchestrator's `handleFailure()` with a 0-based one and its
 * own timer. Same ladder, same status writes, same countdown, two owners — and a
 * fix to one had to be remembered for the other.
 *
 * What stays with the transport, deliberately:
 *   - the terminal decision (autoconnect off, TOTP, an explicit stop). Only the
 *     transport knows whether it is willing to try again at all.
 *   - `wipe`, which is the transport's own loss path. The drain is protocol-side,
 *     and the drain -> capture -> wipe order is pinned against the real transport
 *     function, so the scheduler calls that function instead of assembling the
 *     wipe itself.
 *   - `open`, which starts the next attempt. The scheduler must not know how to
 *     open a session, and it must never re-probe or switch transport: exactly one
 *     transport is active per connection.
 *   - the connection generation bump and the sync-phase open, both of which live
 *     inside the attempt and never here.
 */
let retryTimer: ReturnType<typeof setTimeout> | null = null;

export interface RetryAttempt {
    /** The profile this attempt will reconnect to. Captured at schedule time: a
     *  later profile change must not redirect an already-scheduled attempt. */
    profile: ConnectionProfile;
    /** What failed, for the countdown toast and the failure classification. */
    error: string;
    /** The transport's own loss path: protocol teardown, drain, and the shared
     *  store wipe. */
    wipe: () => void;
    /** Start the next attempt. */
    open: () => void;
}

/** Cancel a scheduled attempt without deciding to stop reconnecting. */
export function cancelPendingRetry(): void {
    if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
    }
}

/** Is a retry armed, and when will it fire? Feeds the banner and focus reconnect. */
export function pendingRetryState(): PendingRetry {
    if (!retryTimer) return { active: false };
    return { active: true, nextRetryAt: get(connectionState).nextReconnectAt };
}

/**
 * Which attempt is about to run: 0 is the first connect, 1 is the first retry.
 *
 * This is the same numbering the API orchestrator used for its private `attempt`
 * field, and the same one the user sees as "attempt 1". The ladder index is one
 * lower, which is the off-by-one that used to be hidden by the two transports
 * counting from different ends.
 */
export function retryAttemptNumber(): number {
    return Math.max(0, get(connectionState).reconnectAttempts);
}

/** Restart the ladder from the beginning: a fresh connect, or a takeover that
 *  explicitly asks for it. */
export function restartRetryLadder(): void {
    resetReconnectAttempts();
}

/**
 * A persistent "disconnected" toast whose text counts down to the next attempt,
 * or nothing at all when the banner is already presenting this loss.
 */
function showCountdownToast(profile: ConnectionProfile, nextRetryAt: number, onReconnect: () => void): void {
    const suppressed = hasRetainedViewForActiveProfile();
    const existing = suppressed ? null : findDisconnectToast(profile.host, profile.port);
    if (existing) {
        updateToast(existing.id, { messageFn: () => countdownText(nextRetryAt) });
        return;
    }
    if (suppressed) return;
    addToast(
        `Disconnected from ${profile.host}:${profile.port}`,
        {
            type: 'warning',
            duration: 0,
            messageFn: () => countdownText(nextRetryAt),
            buttons: [{ text: 'Reconnect', action: onReconnect }],
        },
    );
}

/**
 * Schedule the next attempt.
 *
 * Name one connection failure with the flag the UI can explain.
 *
 * `nameTransient` decides what a transport-level failure ("connection closed", a
 * timeout) becomes: false while a retry loop is live, because "Connection lost.
 * Retrying…" is the honest sentence and inventing a cause would be a guess; true
 * once the loop has stopped, because "the relay could not be reached" is the only
 * thing left to say. A failure a retry cannot fix is named either way — that is
 * the point of naming it.
 */
export function nameConnectionFailure(message: string, nameTransient: boolean): void {
    const named = classifyConnectionFailure(message, nameTransient);
    if (named) setErrors(named);
}

/**
 * The terminal outcome: this loss will not be retried, and nothing on screen may
 * imply otherwise.
 *
 * Both transports used to arrive here by their own route — the API transport
 * through a 'failed' status that named the cause, legacy through an early return
 * that named nothing and left the status reading 'disconnected'. Same decision,
 * two different sentences in the same banner. Naming and status are not protocol
 * facts, so they are written once here.
 */
function declareTerminalFailure(attempt: RetryAttempt, onReconnect: () => void): void {
    // The loop has stopped: a transport-level failure is now worth naming.
    nameConnectionFailure(attempt.error, true);
    setConnectionStatus('error');
    connected.set(false);
    if (get(connectionState).wasEverConnected) markCaptureIntent();
    attempt.wipe();
    // After the wipe, so the toast can see whether the banner is already showing
    // this loss. A session that was lost gets the toast; a first connect that
    // never produced one does not.
    if (get(connectionState).wasEverConnected) showDisconnectToast(attempt.profile, onReconnect);
}

/**
 * Arm the one retry loop.
 *
 * Returns false when the app will not retry, and having decided that it also
 * declares the terminal outcome — a declined retry is not a silent return,
 * because the banner and the failure naming are still owed to the user.
 */
export function scheduleRetry(attempt: RetryAttempt, onReconnect: () => void): boolean {
    // One decision for both transports. Autoconnect is the user's veto; the
    // verification code is a second one, and it belongs here rather than in
    // either transport because it is not protocol knowledge: a TOTP code is
    // single-use on both relays, so an automatic retry would present a spent
    // credential and fail. `retryAvailability()` already refuses a manual retry
    // for the same reason — the automatic path must not be more optimistic than
    // the manual one.
    if (!get(settings).autoconnect || get(settings).useTotp) {
        declareTerminalFailure(attempt, onReconnect);
        return false;
    }

    // One loop, so a second schedule replaces the first instead of stacking a
    // second timer beside it.
    cancelPendingRetry();

    // `reconnectAttempts` is 1-based because the user sees "attempt 1"; the ladder
    // counts retries that have already failed, so the first retry is index 0.
    const attempts = incrementReconnectAttempts();
    const delay = reconnectDelay(attempts - 1);
    const nextAt = Date.now() + delay;

    setNextReconnectAt(nextAt);
    // Written in the same synchronous step as the arm below: a status claiming a
    // pending retry with no timer running yet would render a countdown for a retry
    // that cannot fire.
    setConnectionStatus('reconnecting');
    connected.set(false);

    nameConnectionFailure(attempt.error, false);

    if (get(connectionState).wasEverConnected) markCaptureIntent();
    attempt.wipe();

    showCountdownToast(attempt.profile, nextAt, onReconnect);

    retryTimer = setTimeout(() => {
        retryTimer = null;
        // The countdown has been spent. Leaving it set would render a negative
        // "next attempt in" for as long as the attempt takes, because an API retry
        // is labelled 'reconnecting' while it is in flight, not 'connecting'.
        setNextReconnectAt(undefined);
        // Status is already 'reconnecting' from the schedule; the attempt itself
        // moves it to 'connecting'.
        attempt.open();
    }, delay);

    if (DEBUG_CONNECTION) {
        console.log(`[retry] attempt ${attempts}, next in ${(delay / 1000).toFixed(1)}s`);
    }
    return true;
}
