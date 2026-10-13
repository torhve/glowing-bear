// Relay transport facade.
//
// Selects between the Relay API stack (apiConnection.ts, WeeChat >= 4.10.1)
// and the legacy WebSocket protocol (legacyConnection.ts, older WeeChat),
// then routes every connection operation to the active transport. Public
// surface is identical to either transport module's exports.
//
// Selection (settings.protocol):
//  - 'auto' (default): probe the unauthenticated POST /api/handshake. A JSON
//    200 negotiation means an API listener → API path (the orchestrator's
//    version gate then reports too-old API servers explicitly — no legacy
//    handshake is attempted against an API listener). Any other outcome
//    (non-200, network/TLS error, timeout — a legacy listener waits for the
//    binary handshake and never answers HTTP) → legacy path.
//  - 'api' / 'legacy': skip probing and connect directly on the choice.

import { get } from 'svelte/store';
import { getBuffer, activeBufferId, hasNoHistoryToFetch, markHistoryComplete } from '#lib/stores/models.ts';
import { settings } from '#lib/stores/settings.ts';
import { activeTransport, connectionState } from '#lib/stores/connectionStore.ts';
import { resolveApiEndpoint } from '#lib/api/api-endpoint.ts';
import * as api from '#lib/stores/apiConnection.ts';
import * as legacy from '#lib/stores/legacyConnection.ts';
import type { ApiSession } from '#lib/api/api-session.ts';
import { clearActiveConnectionProfile, setActiveConnectionProfile } from '#lib/connectionProfile.ts';
import {
    cleanupFocusReconnect as sharedCleanupFocusReconnect,
    pendingRetryState as sharedPendingRetryState,
    registerActiveFocusReconnect,
    registerTransportAdapter,
    retryAvailability as sharedRetryAvailability,
    retryNow as sharedRetryNow,
    teardownAll,
    transportAdapterFor,
    type ConnectionProfile,
    type RetryAvailability,
    type RetryNowOutcome,
} from '#lib/stores/connectionLifecycle.ts';
import { clearCaptureIntent, releaseIfProfileChanged, releaseRetainedSnapshot } from '#lib/stores/retainedChat.ts';

export type RelayTransport = 'api' | 'legacy';

// Hand each transport's adapter to the shared lifecycle. The facade is the only
// module that imports both transports, so it is the only place that can supply
// both; "which one is active" stays in the `activeTransport` store, not here.
registerTransportAdapter(api.transportAdapter);
registerTransportAdapter(legacy.transportAdapter);

let transport: RelayTransport | null = null;

export function getActiveTransport(): RelayTransport | null {
    return transport;
}

/**
 * Whether a delivery could reach the relay at all.
 *
 * Each transport already refuses when its own socket is gone, so this is not the
 * primary guard — it is the boundary for the call sites that never ask. A keyboard
 * shortcut fires a command without consulting the composer's disabled state, and a
 * send can begin a beat after the session died. Putting the decision here means
 * "there is no connection" has one answer instead of one per caller.
 *
 * A refusal, not a queue: nothing is stored, nothing is scheduled, and the caller
 * keeps whatever text it handed over.
 */
export function deliveryPossible(): boolean {
    const { status } = get(connectionState);
    // 'connecting' is allowed, and deliberately so. On the legacy path the socket
    // is open and usable while the handshake finishes, and both transports already
    // guard their own wire — refusing there would block a send that can genuinely
    // be delivered, which is a new failure invented to cover an old one. What has
    // to be refused is every state with no session to deliver through, and that is
    // exactly the set of states a retained view is rendered in.
    return status === 'connected' || status === 'connecting';
}

// A legacy relay never answers HTTP and never closes the socket either, so
// this timeout is the detection cost on legacy relays. An API relay answers
// in milliseconds even over slow links; 3s is a generous real-world ceiling.
const HANDSHAKE_PROBE_TIMEOUT_MS = 3000;

/** Classifies the relay by probing the unauthenticated API handshake. */
async function probeApiRelay(host: string, port: number, path: string, tls: boolean): Promise<boolean> {
    try {
        const endpoint = resolveApiEndpoint({ host, port, tls, path: path || undefined });
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), HANDSHAKE_PROBE_TIMEOUT_MS);
        try {
            const res = await fetch(`${endpoint.httpBase}/api/handshake`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', accept: 'application/json' },
                body: JSON.stringify({ password_hash_algo: ['pbkdf2+sha512', 'pbkdf2+sha256', 'sha512', 'sha256', 'plain'] }),
                signal: controller.signal,
            });
            const body: unknown = await res.json().catch(() => null);
            if (res.status === 200 && typeof (body as { password_hash_algo?: unknown })?.password_hash_algo === 'string') {
                return true; // valid API negotiation
            }
            // A JSON {"error": ...} body is WeeChat's own API error shape (verified
            // live: unknown paths answer 404 + {"error":"Resource not found"}) — the
            // listener speaks the API, so keep the API path and let the real
            // handshake surface the error instead of hanging a legacy socket.
            return typeof (body as { error?: unknown })?.error === 'string';
        } finally {
            clearTimeout(timer);
        }
    } catch {
        // Timeout (a legacy relay never answers HTTP), TLS failure, or a
        // non-JSON responder (proxy 404 page): fall back to legacy.
        return false;
    }
}

// Transport chosen per relay profile (host:port:tls). Reconnects to the same
// relay reuse it without re-probing; an explicit disconnect clears it so a
// re-connect sees any relay configuration change.
//
// This key is deliberately narrower than the draft identity in
// `lib/connectionProfile.ts`: it caches which protocol answers on an address and
// ignores the reverse-proxy path. Drafts must not share it — two proxy paths on
// one address are two relays.
const transportByProfile = new Map<string, RelayTransport>();

function profileKey(host: string, port: number, tls: boolean): string {
    return `${host}:${port}:${tls ? 'tls' : 'plain'}`;
}

export async function connect(target: ConnectionProfile): Promise<void> {
    const preference = get(settings).protocol ?? 'auto';
    const { host, port, path, tls } = target;
    // Named `key`, not `profile`. The local here is the identity STRING that caches
    // which transport serves an address; the parameter is the address itself. The
    // old code called both `profile`, which made the two meanings indistinguishable.
    const key = profileKey(host, port, tls);
    // Capture the endpoint this attempt targets. Per-conversation state keys on
    // it, so it comes from the arguments of the attempt rather than from settings,
    // which stay editable while disconnected.
    setActiveConnectionProfile(host, port, path, tls);
    // A retained view belongs to the relay it was captured from. Starting an
    // attempt for a DIFFERENT relay ends it — the plan's "profile change while
    // offline → form". An attempt for the same relay keeps it, so a retry can
    // hand the retained window to the new session.
    releaseIfProfileChanged();
    // Exactly one transport may be live, and this is where that invariant was
    // broken. connect() used to leave the transport it was not selecting armed:
    // measured, a legacy session dropped its socket (arming a 30 s retry), the
    // user went to Edit connection and connected to a different relay over the API
    // transport, and 34 s later BOTH `__getWs()` and `__getSession()` were live —
    // the legacy timer had fired and opened a socket to the old relay beside the
    // new session. Nothing reported it.
    //
    // Both are quiesced, not just the other one: a retry armed for the SAME
    // transport would otherwise survive a connect that came from the form rather
    // than from the retry path, and fire alongside the new attempt.
    //
    // `quiesce()` rather than `disconnect()`: disconnect marks `userDisconnect`,
    // which would make the retry classifier refuse the session about to start, and
    // wipes the stores that session is about to fill.
    transportAdapterFor('api')?.quiesce();
    transportAdapterFor('legacy')?.quiesce();
    if (preference === 'auto') {
        transport = transportByProfile.get(key)
            ?? (await probeApiRelay(host, port, path, tls) ? 'api' : 'legacy');
        transportByProfile.set(key, transport);
    } else {
        transport = preference;
        transportByProfile.set(key, transport);
    }
    activeTransport.set(transport);
    return transport === 'api'
        ? api.connect(target)
        // The legacy relay only completes the WebSocket upgrade under the
        // '/weechat' path; an empty path would hang the socket forever.
        : legacy.connect({ ...target, path: target.path || 'weechat' });
}

export function disconnect(): void {
    // Explicit departure is not a loss. Clear any pending capture intent before
    // the two transport wipes run, so a stale intent can never make an
    // intentional Leave capture a session.
    clearCaptureIntent();
    // One teardown for whichever transport is active, and one outcome. The
    // inactive transport is quiesced, not wiped: it has no session to close, and
    // running a second full reset for a transport that does not own the app state
    // was only ever safe because every step happened to tolerate running twice.
    teardownAll();
    // The retained view belongs to the relay the user just left.
    releaseRetainedSnapshot('explicit-leave');
    transport = null;
    activeTransport.set(null);
    transportByProfile.clear();
    clearActiveConnectionProfile();
}

// The retry decision lives in the shared lifecycle and is made through the active
// adapter. Re-exported here because the banner and the tests reach the command
// through the facade, which is the module that owns "which transport".
export type { RetryNowOutcome, RetryAvailability };
export const retryAvailability = sharedRetryAvailability;

/**
 * Manual "Retry now" for the retained shell. Lives in the shared lifecycle; see
 * `retryAvailability` for why it goes through the adapter's own takeover path and
 * never through this module's connect() — connect() re-probes the relay, and a
 * probe that fails mid-retry would silently move a session onto the other
 * protocol, which the dual-protocol rule forbids.
 */
export const retryNow = sharedRetryNow;

export function setHotlistPollInterval(ms: number): void {
    api.setHotlistPollInterval(ms);
    legacy.setHotlistPollInterval(ms);
}

// Registered ONCE, for whichever transport is active when the handler runs.
// Registering both transports' listeners was a bug, not belt-and-braces: the
// shared guard is first-wins, so the API transport's `pendingRetry` closure was
// installed permanently and a legacy session's focus reconnect never fired.
export function initFocusReconnect(): void {
    registerActiveFocusReconnect();
}

export const cleanupFocusReconnect = sharedCleanupFocusReconnect;

/**
 * Read-only view of the shared retry loop: whether an attempt is armed, and when.
 *
 * `connectionState.nextReconnectAt` cannot answer this. It is a display field that
 * several paths clear — a manual takeover clears it while the timer it replaced is
 * still running — so "no countdown" is not evidence of "no armed attempt". This
 * reports the timer itself.
 */
export const pendingRetry = sharedPendingRetryState;

export async function requestNicklist(bufferId: string): Promise<void> {
    if (transport === 'legacy') return legacy.requestNicklist(bufferId);
    return api.requestNicklist(bufferId);
}

export async function fetchMoreLines(numLines: number = 0, explicitBufferId?: string): Promise<void> {
    // Free buffers (/exec -nf, plugin output) have no older history: gate them
    // here as well as inside each transport, because each transport also calls
    // its own fetchMoreLines when you switch to a buffer.
    const bufferId = explicitBufferId ?? get(activeBufferId);
    const buffer = getBuffer(bufferId);
    if (buffer && hasNoHistoryToFetch(buffer)) {
        markHistoryComplete(bufferId);
        return;
    }
    if (transport === 'legacy') return legacy.fetchMoreLines(numLines, explicitBufferId);
    return api.fetchMoreLines(numLines, explicitBufferId);
}

/** Installed script names, or null when they cannot be listed. The legacy
 *  protocol has no script listing, so it reports unknown rather than empty. */
export async function listScripts(): Promise<string[] | null> {
    if (transport === 'legacy') return null;
    return api.listScripts();
}

export async function sendWeeChatCommand(command: string, bufferId?: string): Promise<boolean> {
    if (!deliveryPossible()) return false;
    if (transport === 'legacy') return legacy.sendWeeChatCommand(command, bufferId);
    return api.sendWeeChatCommand(command, bufferId);
}

export async function switchBuffer(bufferId: string): Promise<boolean> {
    if (transport === 'legacy') return legacy.switchBuffer(bufferId);
    return api.switchBuffer(bufferId);
}

export async function sendBufferCommand(bufferId: string, command: string): Promise<void> {
    if (!deliveryPossible()) return;
    if (transport === 'legacy') return legacy.sendBufferCommand(bufferId, command);
    return api.sendBufferCommand(bufferId, command);
}

export async function closeBufferOnWeeChat(bufferId: string): Promise<void> {
    if (transport === 'legacy') return legacy.closeBufferOnWeeChat(bufferId);
    return api.closeBufferOnWeeChat(bufferId);
}

export async function pinBuffer(bufferId: string): Promise<void> {
    if (transport === 'legacy') return legacy.pinBuffer(bufferId);
    return api.pinBuffer(bufferId);
}

export async function unpinBuffer(bufferId: string): Promise<void> {
    if (transport === 'legacy') return legacy.unpinBuffer(bufferId);
    return api.unpinBuffer(bufferId);
}

export async function sendMessage(message: string): Promise<boolean> {
    if (!deliveryPossible()) return false;
    if (transport === 'legacy') return legacy.sendMessage(message);
    return api.sendMessage(message);
}

/** Live API session (API transport only; null on the legacy path). */
export function getSession(): ApiSession | null {
    return api.getSession();
}

/** Legacy WebSocket socket (legacy transport only; null on the API path). */
export function getWs(): WebSocket | null {
    return legacy.getWs();
}

/** Legacy config read: sends a confinfo request whose response lands in the
 *  wconfig store via the handlers (the API transport has no config endpoint
 *  until the WeeChat 5.0 options resource). No-op on the API path. */
export async function fetchConfValue(name: string): Promise<void> {
    if (transport === 'legacy') return legacy.fetchConfValue(name);
}
