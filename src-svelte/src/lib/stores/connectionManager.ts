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
import { clearCaptureIntent, releaseIfProfileChanged, releaseRetainedSnapshot } from '#lib/stores/retainedChat.ts';

export type RelayTransport = 'api' | 'legacy';

let transport: RelayTransport | null = null;

export function getActiveTransport(): RelayTransport | null {
    return transport;
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

export async function connect(host: string, port: number, path: string, password: string, tls: boolean, noCompression: boolean): Promise<void> {
    const preference = get(settings).protocol ?? 'auto';
    const profile = profileKey(host, port, tls);
    // Capture the endpoint this attempt targets. Per-conversation state keys on
    // it, so it comes from the arguments of the attempt rather than from settings,
    // which stay editable while disconnected.
    setActiveConnectionProfile(host, port, path, tls);
    // A retained view belongs to the relay it was captured from. Starting an
    // attempt for a DIFFERENT relay ends it — the plan's "profile change while
    // offline → form". An attempt for the same relay keeps it, so a retry can
    // hand the retained window to the new session.
    releaseIfProfileChanged();
    if (preference === 'auto') {
        transport = transportByProfile.get(profile)
            ?? (await probeApiRelay(host, port, path, tls) ? 'api' : 'legacy');
        transportByProfile.set(profile, transport);
    } else {
        transport = preference;
        transportByProfile.set(profile, transport);
    }
    activeTransport.set(transport);
    return transport === 'api'
        ? api.connect(host, port, path, password, tls, noCompression)
        // The legacy relay only completes the WebSocket upgrade under the
        // '/weechat' path; an empty path would hang the socket forever.
        : legacy.connect(host, port, path || 'weechat', password, tls, noCompression);
}

export function disconnect(): void {
    // Explicit departure is not a loss. Clear any pending capture intent before
    // the two transport wipes run, so a stale intent can never make an
    // intentional Leave capture a session.
    clearCaptureIntent();
    // Both transports clean up; the inactive one is a no-op except for the
    // shared store resets, which are idempotent.
    api.disconnect();
    legacy.disconnect();
    // The retained view belongs to the relay the user just left.
    releaseRetainedSnapshot('explicit-leave');
    transport = null;
    activeTransport.set(null);
    transportByProfile.clear();
    clearActiveConnectionProfile();
}

export type RetryNowOutcome = 'retried' | 'in-progress' | 'no-retry-loop' | 'needs-credentials';
/** The same question without performing it, so the banner's button state and a
 * refused command are one decision made in one place. */
export type RetryAvailability = 'available' | 'in-progress' | 'no-retry-loop' | 'needs-credentials';

export function retryAvailability(): RetryAvailability {
    if (!transport) return 'no-retry-loop';
    // A Leave ends the retry loop and the retained view with it. A retry from
    // here would reconnect to a profile the user deliberately left.
    if (get(connectionState).userDisconnect) return 'no-retry-loop';
    // TOTP codes are single-use and expire. Reusing the captured one produces an
    // auth error the user cannot interpret, so route them to explicit credential
    // entry — the same reason the transports refuse to auto-reconnect on TOTP.
    if (get(settings).useTotp) return 'needs-credentials';
    const inProgress = transport === 'api' ? api.isAttemptInProgress() : legacy.isAttemptInProgress();
    if (inProgress) return 'in-progress';
    const retryable = transport === 'api' ? api.canRetryNow() : legacy.canRetryNow();
    return retryable ? 'available' : 'no-retry-loop';
}

/**
 * Manual "Retry now" for the retained shell.
 *
 * Delegates to whichever transport owns the active profile and NEVER to this
 * module's connect(): connect() re-probes the relay, and a probe that fails
 * mid-retry would silently move a session onto the other protocol — the
 * mid-connection fallback the dual-protocol rule forbids. The transports' own
 * takeover paths cancel any scheduled retry before starting, so a click
 * replaces the pending attempt instead of adding a second loop.
 *
 * Outcomes rather than a boolean: the caller has to distinguish "a click did
 * nothing" from "this needs a credential the user must type", because only the
 * latter has to route to the connection form.
 */
export function retryNow(): RetryNowOutcome {
    const availability = retryAvailability();
    if (availability === 'in-progress') return 'in-progress';
    if (availability === 'needs-credentials') return 'needs-credentials';
    if (availability === 'no-retry-loop') return 'no-retry-loop';
    const started = transport === 'api' ? api.retryNow() : legacy.retryNow();
    return started ? 'retried' : 'no-retry-loop';
}

export function setHotlistPollInterval(ms: number): void {
    api.setHotlistPollInterval(ms);
    legacy.setHotlistPollInterval(ms);
}

export function initFocusReconnect(): void {
    api.initFocusReconnect();
    legacy.initFocusReconnect();
}

export function cleanupFocusReconnect(): void {
    api.cleanupFocusReconnect();
    legacy.cleanupFocusReconnect();
}

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
    if (transport === 'legacy') return legacy.sendWeeChatCommand(command, bufferId);
    return api.sendWeeChatCommand(command, bufferId);
}

export async function switchBuffer(bufferId: string): Promise<boolean> {
    if (transport === 'legacy') return legacy.switchBuffer(bufferId);
    return api.switchBuffer(bufferId);
}

export async function sendBufferCommand(bufferId: string, command: string): Promise<void> {
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
