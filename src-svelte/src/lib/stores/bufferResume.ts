// Track which buffer was last viewed for reconnect recovery by fullName
// (stable across connections, e.g. "irc.server.#channel").
export function recordLastBuffer(fullName: string) {
    if (typeof window !== 'undefined') {
        localStorage.setItem('gb-last-buffer', fullName);
    }
}

/** Check if this buffer matches the saved last-viewed buffer by fullName. */
export function shouldResume(fullName: string): boolean {
    if (typeof window !== 'undefined') {
        const saved = localStorage.getItem('gb-last-buffer');
        if (saved) {
            return saved === fullName;
        }
    }
    return false;
}

/** Retrieve the saved fullName for the last-viewed buffer. */
export function getLastBuffer(): string | null {
    if (typeof window !== 'undefined') {
        return localStorage.getItem('gb-last-buffer');
    }
    return null;
}

