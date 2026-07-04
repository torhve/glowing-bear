import { writable, get, type Writable } from 'svelte/store';

export interface ToastButton {
    text: string;
    action: () => void;
}

export interface Toast {
    id: number;
    message: string;
    type: 'info' | 'success' | 'error' | 'warning';
    duration: number;
    buttons?: ToastButton[];
    // Dynamic message function for countdown toasts — evaluated on render
    messageFn?: () => string;
}

let nextId = 0;

const toasts: Writable<Toast[]> = writable([]);

import { DEBUG_TOAST } from '$lib/debug';

export function addToast(message: string, options?: Partial<Omit<Toast, 'id' | 'message'>>) {
    if (DEBUG_TOAST) console.log('[toast] addToast:', options?.type ?? 'info', message.substring(0, 100));
    const toast: Toast = {
        id: ++nextId,
        message,
        type: options?.type ?? 'info',
        duration: options?.duration ?? 5000,
        buttons: options?.buttons,
        messageFn: options?.messageFn,
    };

    toasts.update(current => [...current, toast]);

    if (toast.duration > 0) {
        setTimeout(() => {
            removeToast(toast.id);
        }, toast.duration);
    }
}

export function removeToast(id: number) {
    if (DEBUG_TOAST) console.log('[toast] removeToast:', id);
    toasts.update(current => current.filter(t => t.id !== id));
}

export function clearToasts() {
    if (DEBUG_TOAST) console.log('[toast] clearToasts');
    toasts.set([]);
}

// Update an existing toast by ID with new properties.
export function updateToast(id: number, updates: Partial<Omit<Toast, 'id'>>) {
    if (DEBUG_TOAST) console.log('[toast] updateToast:', id);
    toasts.update(current =>
        current.map(t => t.id === id ? { ...t, ...updates } : t)
    );
}

// Find a toast by ID in the store.
export function findToast(id: number): Toast | undefined {
    return get(toasts).find((t: Toast) => t.id === id);
}

export const toastStore = toasts;
