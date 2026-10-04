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
import { settings } from '#lib/stores/settings.ts';
import { resolveApiEndpoint } from '#lib/api/api-endpoint.ts';
import * as api from '#lib/stores/apiConnection.ts';
import * as legacy from '#lib/stores/legacyConnection.ts';
import type { ApiSession } from '#lib/api/api-session.ts';

export type RelayTransport = 'api' | 'legacy';

let activeTransport: RelayTransport | null = null;

export function getActiveTransport(): RelayTransport | null {
    return activeTransport;
}

const HANDSHAKE_PROBE_TIMEOUT_MS = 5000;

/** True only when an HTTP-speaking WeeChat relay answered the unauthenticated
 *  handshake with a valid JSON negotiation. Anything else — including the
 *  timeout a legacy relay produces by simply never replying — means legacy. */
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
            if (res.status !== 200) return false;
            const body: unknown = await res.json();
            return typeof (body as { password_hash_algo?: unknown })?.password_hash_algo === 'string';
        } finally {
            clearTimeout(timer);
        }
    } catch {
        return false;
    }
}

export async function connect(host: string, port: number, path: string, password: string, tls: boolean, noCompression: boolean): Promise<void> {
    const preference = get(settings).protocol ?? 'auto';
    activeTransport = preference === 'auto'
        ? (await probeApiRelay(host, port, path, tls)) ? 'api' : 'legacy'
        : preference;
    return activeTransport === 'api'
        ? api.connect(host, port, path, password, tls, noCompression)
        : legacy.connect(host, port, path, password, tls, noCompression);
}

export function disconnect(): void {
    // Both transports clean up; the inactive one is a no-op except for the
    // shared store resets, which are idempotent.
    api.disconnect();
    legacy.disconnect();
    activeTransport = null;
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
    if (activeTransport === 'legacy') return legacy.requestNicklist(bufferId);
    return api.requestNicklist(bufferId);
}

export async function fetchMoreLines(numLines: number = 0, explicitBufferId?: string): Promise<void> {
    if (activeTransport === 'legacy') return legacy.fetchMoreLines(numLines, explicitBufferId);
    return api.fetchMoreLines(numLines, explicitBufferId);
}

export async function sendWeeChatCommand(command: string, bufferId?: string): Promise<boolean> {
    if (activeTransport === 'legacy') return legacy.sendWeeChatCommand(command, bufferId);
    return api.sendWeeChatCommand(command, bufferId);
}

export async function switchBuffer(bufferId: string): Promise<boolean> {
    if (activeTransport === 'legacy') return legacy.switchBuffer(bufferId);
    return api.switchBuffer(bufferId);
}

export async function sendBufferCommand(bufferId: string, command: string): Promise<void> {
    if (activeTransport === 'legacy') return legacy.sendBufferCommand(bufferId, command);
    return api.sendBufferCommand(bufferId, command);
}

export async function closeBufferOnWeeChat(bufferId: string): Promise<void> {
    if (activeTransport === 'legacy') return legacy.closeBufferOnWeeChat(bufferId);
    return api.closeBufferOnWeeChat(bufferId);
}

export async function pinBuffer(bufferId: string): Promise<void> {
    if (activeTransport === 'legacy') return legacy.pinBuffer(bufferId);
    return api.pinBuffer(bufferId);
}

export async function unpinBuffer(bufferId: string): Promise<void> {
    if (activeTransport === 'legacy') return legacy.unpinBuffer(bufferId);
    return api.unpinBuffer(bufferId);
}

export async function sendMessage(message: string): Promise<boolean> {
    if (activeTransport === 'legacy') return legacy.sendMessage(message);
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
    if (activeTransport === 'legacy') return legacy.fetchConfValue(name);
}
