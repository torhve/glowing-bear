import { writable } from 'svelte/store';
import type { ConnectionError } from '#lib/types.ts';

export interface ConnectionState {
    status: 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error';
    errors: ConnectionError;
    userDisconnect: boolean;
    wasEverConnected: boolean;
    // Reconnect loop guard
    reconnectAttempts: number;
    lastReconnectAt: number;
    // Timestamp for next scheduled reconnect attempt (ms since epoch)
    nextReconnectAt?: number;
}

interface ConnectionStats {
    bytesSent: number;
    bytesReceived: number;
    messagesSent: number;
    messagesReceived: number;
    lastMessageAt: number;
    lastSentAt: number;
    connectedSince: number;
}

const initialState: ConnectionState = {
    status: 'disconnected',
    errors: {
        passwordError: false,
        tlsError: false,
        securityError: false,
        oldWeechatError: false,
        hashAlgorithmDisagree: false,
        clockSkewError: false,
        errorMessage: false,
        uploadError: false,
        serverUnreachable: false
    },
    userDisconnect: false,
    wasEverConnected: false,
    reconnectAttempts: 0,
    lastReconnectAt: 0,
    nextReconnectAt: undefined
};

const initialStats: ConnectionStats = {
    bytesSent: 0,
    bytesReceived: 0,
    messagesSent: 0,
    messagesReceived: 0,
    lastMessageAt: 0,
    lastSentAt: 0,
    connectedSince: 0
};

export const connectionState = writable<ConnectionState>(initialState);
export const connectionStats = writable<ConnectionStats>(initialStats);
// The relay transport the connection facade is (or was last) using; null
// while disconnected. Set by connectionManager on connect/disconnect.
export type RelayTransportKind = 'api' | 'legacy';
export const activeTransport = writable<RelayTransportKind | null>(null);

export function setConnectionStatus(status: ConnectionState['status']) {
    connectionState.update(current => ({ ...current, status }));
    if (status === 'connected') {
        connectionStats.update(s => ({ ...s, connectedSince: Date.now() }));
    } else {
        // Uptime belongs to a live connection, so every non-connected status
        // clears it — not just 'disconnected'. Leaving it set through
        // 'connecting'/'reconnecting' let the popover count up on a socket that
        // was already gone, which reads as a live session that is not one.
        connectionStats.update(s => ({ ...s, connectedSince: 0 }));
    }
}

export function setErrors(errors: Partial<ConnectionError>) {
    connectionState.update(current => ({ ...current, errors: { ...current.errors, ...errors } }));
}

export function clearErrors() {
    connectionState.update(current => ({ ...current, errors: { ...initialState.errors } }));
}

export function disconnect() {
    // Deliberately does NOT reset the traffic counters. They describe the most
    // recent attempt (see `beginSessionStats`), and a Leave is not the start of
    // one. Uptime is cleared here by `setConnectionStatus('disconnected')`,
    // which every Leave path runs.
    connectionState.set({
        status: 'disconnected',
        userDisconnect: true,
        wasEverConnected: false,
        errors: { ...initialState.errors },
        reconnectAttempts: 0,
        lastReconnectAt: 0,
        nextReconnectAt: undefined
    });
}

export function recordBytesReceived(bytes: number) {
    connectionStats.update(s => ({
        ...s,
        bytesReceived: s.bytesReceived + bytes,
        messagesReceived: s.messagesReceived + 1,
        lastMessageAt: Date.now()
    }));
}

export function recordBytesSent(bytes: number) {
    connectionStats.update(s => ({
        ...s,
        bytesSent: s.bytesSent + bytes,
        messagesSent: s.messagesSent + 1,
        lastMessageAt: Date.now(),
        lastSentAt: Date.now()
    }));
}

/**
 * Start the traffic counters for a new attempt.
 *
 * The stats popover pairs Sent / Recv / messages with Uptime, and Uptime belongs
 * to a live connection — so counters that kept accumulating across a reconnect
 * attributed the previous session's traffic to the session now on screen. The
 * rule is now single: these counters describe the most recent attempt, and only
 * the start of an attempt clears them.
 *
 * A loss therefore leaves the numbers of the session that just ended, which is
 * what the retained view is still showing; the next attempt replaces them with
 * its own. Clearing them at the wipe instead would zero the popover while the
 * dead session's messages were still on screen.
 */
export function beginSessionStats() {
    connectionStats.set(initialStats);
}

export function formatBytes(bytes: number): string {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- part of public API, called with tick param by TopBar
export function timeAgo(timestamp: number, _tick?: number): string {
    if (!timestamp) return '--';
    const diff = Date.now() - timestamp;
    if (diff < 1000) return '<1s ago';
    if (diff < 60000) return Math.floor(diff / 1000) + 's ago';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
    return Math.floor(diff / 3600000) + 'h ago';
}

export function formatDuration(ms: number): string {
    if (!ms || ms < 1000) return '--';
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ${minutes % 60}m`;
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
}

// Reset reconnect attempt counter on successful connection
export function resetReconnectAttempts() {
    connectionState.update(current => ({ ...current, reconnectAttempts: 0, lastReconnectAt: 0, nextReconnectAt: undefined }));
}

// Set reconnect attempt count to a specific value (used by tests)
export function setReconnectAttempts(attempts: number) {
    connectionState.update(current => ({ ...current, reconnectAttempts: attempts, lastReconnectAt: Date.now() }));
}

// Increment reconnect attempt counter
export function incrementReconnectAttempts(): number {
    let attempts = 0;
    connectionState.update(current => {
        current.reconnectAttempts++;
        current.lastReconnectAt = Date.now();
        attempts = current.reconnectAttempts;
        return { ...current };
    });
    return attempts;
}

// Set the timestamp for next scheduled reconnect attempt.
export function setNextReconnectAt(ts: number | undefined) {
    connectionState.update(current => ({ ...current, nextReconnectAt: ts }));
}

