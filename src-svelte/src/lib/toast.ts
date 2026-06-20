import { writable, type Writable } from 'svelte/store';

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
}

let nextId = 0;

const toasts: Writable<Toast[]> = writable([]);

export function addToast(message: string, options?: Partial<Omit<Toast, 'id' | 'message'>>) {
    console.log('[toast] addToast:', options?.type ?? 'info', message.substring(0, 100));
    const toast: Toast = {
        id: ++nextId,
        message,
        type: options?.type ?? 'info',
        duration: options?.duration ?? 5000,
        buttons: options?.buttons,
    };

    toasts.update(current => [...current, toast]);

    if (toast.duration > 0) {
        setTimeout(() => {
            removeToast(toast.id);
        }, toast.duration);
    }
}

export function removeToast(id: number) {
    console.log('[toast] removeToast:', id);
    toasts.update(current => current.filter(t => t.id !== id));
}

export function clearToasts() {
    console.log('[toast] clearToasts');
    toasts.set([]);
}

export const toastStore = toasts;
