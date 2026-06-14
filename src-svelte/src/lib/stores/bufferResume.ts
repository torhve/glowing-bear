import { writable } from 'svelte/store';

// Track which buffer was last viewed for reconnect recovery
export const lastBufferId = writable<string>('');

export function recordBuffer(bufferId: string) {
    lastBufferId.set(bufferId);
    if (typeof window !== 'undefined') {
        localStorage.setItem('gb-last-buffer', bufferId);
    }
}

export function shouldResume(bufferId: string): boolean {
    if (typeof window !== 'undefined') {
        const saved = localStorage.getItem('gb-last-buffer');
        if (saved) {
            return saved === bufferId;
        }
    }
    return false;
}

