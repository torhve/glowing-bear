import { readString, writeString } from '#lib/storage.ts';

// Track which buffer was last viewed for reconnect recovery by fullName
// (stable across connections, e.g. "irc.server.#channel").
const LAST_BUFFER_KEY = 'gb-last-buffer';

export function recordLastBuffer(fullName: string) {
    writeString(LAST_BUFFER_KEY, fullName);
}

/** Check if this buffer matches the saved last-viewed buffer by fullName. */
export function shouldResume(fullName: string): boolean {
    return readString(LAST_BUFFER_KEY) === fullName;
}

/** Retrieve the saved fullName for the last-viewed buffer. */
export function getLastBuffer(): string | null {
    return readString(LAST_BUFFER_KEY);
}
