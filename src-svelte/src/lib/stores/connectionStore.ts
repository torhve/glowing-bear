import { writable } from 'svelte/store';
import type { ConnectionError } from '$lib/types';

export interface ConnectionState {
    status: 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error';
    errors: ConnectionError;
    userDisconnect: boolean;
    wasEverConnected: boolean;
    // Reconnect loop guard
    reconnectAttempts: number;
    lastReconnectAt: number;
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
        errorMessage: false,
        uploadError: false,
        serverUnreachable: false
    },
    userDisconnect: false,
    wasEverConnected: false,
    reconnectAttempts: 0,
    lastReconnectAt: 0
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

export function setConnectionStatus(status: ConnectionState['status']) {
    connectionState.update(current => ({ ...current, status }));
    if (status === 'connected') {
        connectionStats.update(s => ({ ...s, connectedSince: Date.now() }));
    } else if (status === 'disconnected') {
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
    connectionState.set({
        status: 'disconnected',
        userDisconnect: true,
        wasEverConnected: false,
        errors: { ...initialState.errors },
        reconnectAttempts: 0,
        lastReconnectAt: 0
    });
    connectionStats.set(initialStats);
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

export function resetStats() {
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
    connectionState.update(current => ({ ...current, reconnectAttempts: 0, lastReconnectAt: 0 }));
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

