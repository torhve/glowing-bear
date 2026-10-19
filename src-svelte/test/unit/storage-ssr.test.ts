// @vitest-environment node
import { get } from 'svelte/store';
import { describe, it, expect } from 'vitest';
import { readString, writeString, remove } from '#lib/storage.ts';

/**
 * The server side, tested in a real Node environment rather than by deleting a
 * browser global that jsdom will not let go of.
 *
 * The case being pinned is *storage present but no client*, because that is the
 * one a browser test cannot reach and a plain Node test cannot see either: Node
 * defines a `localStorage` global experimentally (it warns and stays `undefined`
 * unless `--localstorage-file` is passed), so a guard that only asks "does storage
 * exist" would be satisfied here and would fold one server process's settings into
 * the page everybody gets.
 *
 * So storage is installed here as a recording fake. Absence proves nothing; the
 * point is that nothing may *touch* it.
 */

/** A `localStorage` that reports every access, so "did nothing" is checkable. */
function installRecordingStorage(): string[] {
    const calls: string[] = [];
    const fake = {
        getItem: (key: string) => { calls.push(`getItem ${key}`); return null; },
        setItem: (key: string) => { calls.push(`setItem ${key}`); },
        removeItem: (key: string) => { calls.push(`removeItem ${key}`); },
        clear: () => { calls.push('clear'); },
        key: (index: number) => { calls.push(`key ${index}`); return null; },
        get length() { calls.push('length'); return 0; },
    };
    (globalThis as { localStorage: unknown }).localStorage = fake;
    return calls;
}

describe('storage on the server', () => {
    const KEY = 'gb-storage-guard-test';

    it('has no window to mistake for a client', () => {
        expect(typeof window).toBe('undefined');
    });

    it('does not touch storage even when a localStorage global exists', () => {
        const calls = installRecordingStorage();
        try {
            expect(readString(KEY)).toBeNull();
            expect(() => writeString(KEY, 'value')).not.toThrow();
            expect(() => remove(KEY)).not.toThrow();
            expect(calls).toEqual([]);
        } finally {
            delete (globalThis as { localStorage: unknown }).localStorage;
        }
    });

    it('does not persist settings on the server, through the real settings module', async () => {
        // The import path that actually matters: `settings.ts` reads its stored
        // profile at import time, and `updateSettings` writes on every change.
        // A guard that only looked for storage would read and write here.
        const calls = installRecordingStorage();
        try {
            const { updateSettings, settings } = await import('#lib/stores/settings.ts');
            expect(() => updateSettings({ fontsize: '15px' })).not.toThrow();
            expect(typeof get(settings).fontsize).toBe('string');
            expect(calls).toEqual([]);
        } finally {
            delete (globalThis as { localStorage: unknown }).localStorage;
        }
    });
});
