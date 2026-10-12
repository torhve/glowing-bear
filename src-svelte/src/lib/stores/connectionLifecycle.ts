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
import { addToast, removeToast, toastStore, type Toast } from '#lib/toast.ts';
import { activeTransport, connectionState, type RelayTransportKind } from '#lib/stores/connectionStore.ts';
import { settings } from '#lib/stores/settings.ts';
import { captureRetainedState, consumeCaptureIntent, hasRetainedViewForActiveProfile } from '#lib/stores/retainedChat.ts';
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

/** Countdown text for a retry scheduled at `nextRetryAt`. */
export function countdownText(nextRetryAt: number): string {
    return `${Math.max(0, Math.ceil((nextRetryAt - Date.now()) / 1000))}s`;
}
