import { writable } from 'svelte/store';

// Track which buffer was last viewed for reconnect recovery.
// Saves both the WeeChat pointer ID (for same-session page refresh)
// and the fullName (stable across connections, e.g. "irc.server.#channel").
export const lastBufferId = writable<string>('');

export function recordBuffer(bufferId: string, fullName?: string) {
    lastBufferId.set(bufferId);
    if (typeof window !== 'undefined') {
        localStorage.setItem('gb-last-buffer', bufferId);
        if (fullName) {
            localStorage.setItem('gb-last-buffer-name', fullName);
        } else {
            localStorage.removeItem('gb-last-buffer-name');
        }
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

/** Match the last-viewed buffer by its stable fullName (cross-connection resume). */
export function shouldResumeByName(fullName: string): boolean {
    if (typeof window !== 'undefined') {
        const saved = localStorage.getItem('gb-last-buffer-name');
        if (saved) {
            return saved === fullName;
        }
    }
    return false;
}

/** Retrieve the saved fullName for the last-viewed buffer. */
export function getLastBufferName(): string | null {
    if (typeof window !== 'undefined') {
        return localStorage.getItem('gb-last-buffer-name');
    }
    return null;
}

