import { writable } from 'svelte/store';
import type { ConnectionError } from '$lib/types';

export interface ConnectionState {
    status: 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error';
    errors: ConnectionError;
    userDisconnect: boolean;
    wasEverConnected: boolean;
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
        uploadError: false
    },
    userDisconnect: false,
    wasEverConnected: false
};

export const connectionState = writable<ConnectionState>(initialState);

export function setConnectionStatus(status: ConnectionState['status']) {
    connectionState.update(current => ({ ...current, status }));
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
        errors: { ...initialState.errors }
    });
}

