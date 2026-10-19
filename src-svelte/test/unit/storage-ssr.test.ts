// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readString, writeString, remove } from '#lib/storage.ts';

/**
 * The server side, tested in a real Node environment rather than by deleting a
 * browser global that jsdom will not let go of.
 *
 * This app server-renders, and `settings.ts` reads its stored profile at import
 * time. If the client guard were wrong, a settings blob belonging to one server
 * process would be folded into the page everybody gets — and nothing in a browser
 * would ever show it, because both globals are present there.
 *
 * Node also makes the guard's second half non-obvious: it defines a `localStorage`
 * global experimentally (it warns and stays `undefined` unless
 * `--localstorage-file` is passed). So "does storage exist" is no longer a
 * reliable way to ask "are we in a browser", which is why the guard checks
 * `window` as well.
 */
describe('storage on the server', () => {
    const KEY = 'gb-storage-guard-test';

    it('has no window to mistake for a client', () => {
        expect(typeof window).toBe('undefined');
    });

    it('reads nothing', () => {
        expect(readString(KEY)).toBeNull();
    });

    it('writes nothing and does not throw', () => {
        expect(() => writeString(KEY, 'value')).not.toThrow();
        expect(() => remove(KEY)).not.toThrow();
        expect(readString(KEY)).toBeNull();
    });
});
