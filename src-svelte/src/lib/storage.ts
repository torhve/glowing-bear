/**
 * localStorage access with the environment guard written once.
 *
 * Five modules reached for localStorage directly and each wrote its own guard,
 * which is how they ended up disagreeing. `bufferResume.ts` tested `window` and
 * then used `localStorage` — so it throws in exactly the situation the guard was
 * there to survive. Every helper here guards on the thing it actually touches.
 *
 * What a failure *means* deliberately stays with the caller. A corrupt settings
 * blob is logged, a corrupt input history silently falls back to an empty
 * history, and a corrupt pending-notification entry is discarded. A shared helper
 * that picked one of those policies would be a behaviour change wearing a
 * cleanup's clothes.
 */

/**
 * A notification clicked while no buffer was active, kept until a buffer exists
 * to navigate to.
 *
 * The only key in the app with two owners: the notification path writes it and
 * the buffer store reads and clears it. It is spelled once here because a key two
 * modules must agree on is not either module's private string. Every other storage
 * key belongs to the single module that reads and writes it and stays there.
 */
export const PENDING_NOTIFICATION_BUFFER_KEY = 'gb_pendingNotificationBuffer';

/** Whether storage exists. Covers SSR and a browser that has storage disabled. */
export function storageAvailable(): boolean {
    return typeof localStorage !== 'undefined' && localStorage !== null;
}

export function readString(key: string): string | null {
    return storageAvailable() ? localStorage.getItem(key) : null;
}

export function writeString(key: string, value: string): void {
    if (storageAvailable()) localStorage.setItem(key, value);
}

export function remove(key: string): void {
    if (storageAvailable()) localStorage.removeItem(key);
}

/**
 * Parse a stored string. `undefined` means it did not parse.
 *
 * Distinct from "the key was absent", which `readString` answers with `null`:
 * settings treats those two cases differently — a present-but-unreadable blob must
 * not be mistaken for a fresh profile.
 */
export function parseJSON<T>(raw: string, onCorrupt?: (error: unknown) => void): T | undefined {
    try {
        return JSON.parse(raw) as T;
    } catch (e) {
        onCorrupt?.(e);
        return undefined;
    }
}

export function writeJSON(key: string, value: unknown): void {
    writeString(key, JSON.stringify(value));
}
