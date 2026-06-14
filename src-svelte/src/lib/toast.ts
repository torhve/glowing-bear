import { writable, type Writable } from 'svelte/store';

export interface Toast {
    id: number;
    message: string;
    type: 'info' | 'success' | 'error' | 'warning';
    duration: number;
}

let nextId = 0;

const toasts: Writable<Toast[]> = writable([]);

export function addToast(message: string, options?: Partial<Omit<Toast, 'id' | 'message'>>) {
    const toast: Toast = {
        id: ++nextId,
        message,
        type: options?.type ?? 'info',
        duration: options?.duration ?? 5000,
    };

    toasts.update(current => [...current, toast]);

    if (toast.duration > 0) {
        setTimeout(() => {
            removeToast(toast.id);
        }, toast.duration);
    }
}

export function removeToast(id: number) {
    toasts.update(current => current.filter(t => t.id !== id));
}

export function clearToasts() {
    toasts.set([]);
}

export const toastStore = toasts;
