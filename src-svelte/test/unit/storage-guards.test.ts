import { describe, it, expect, afterEach, vi } from 'vitest';
import { readString, writeString, remove, PENDING_NOTIFICATION_BUFFER_KEY } from '#lib/storage.ts';

/**
 * These tests remove a global to imitate the server side of a SvelteKit app that
 * also renders in a browser. `settings.ts` reads its stored profile at import, so
 * if the guard were wrong the app would read one server process's storage and put
 * it into everybody's page — a failure that is invisible in a browser, where both
 * globals are present.
 *
 * Each test restores what it removed in a `finally`, because a leaked global here
 * would quietly disable storage for every later test in the file.
 */
describe('storage guards', () => {
    const KEY = 'gb-storage-guard-test';

    afterEach(() => {
        try { localStorage.removeItem(KEY); } catch { /* already gone */ }
    });

    it('reads and writes when a client with storage is present', () => {
        writeString(KEY, 'value');
        expect(readString(KEY)).toBe('value');
        remove(KEY);
        expect(readString(KEY)).toBeNull();
    });

    // The "no window" half is not testable here: jsdom's `window` is a
    // non-configurable getter, so neither `delete` nor `vi.stubGlobal` can remove
    // it. That case is covered by `storage-ssr.test.ts`, which runs in a real Node
    // environment instead of pretending to be one.

    it('does nothing when there is a window but no usable storage', () => {
        // The half `bufferResume.ts` used to skip: a window is not a promise that
        // storage works.
        vi.stubGlobal('localStorage', undefined);
        try {
            expect(readString(KEY)).toBeNull();
            expect(() => writeString(KEY, 'value')).not.toThrow();
            expect(() => remove(KEY)).not.toThrow();
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('names the one key two modules have to agree on', () => {
        // Written by the notification path, read and cleared by the buffer store.
        expect(PENDING_NOTIFICATION_BUFFER_KEY).toBe('gb_pendingNotificationBuffer');
    });
});
