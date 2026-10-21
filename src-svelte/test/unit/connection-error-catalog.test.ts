/**
 * The cause catalog against the flag type it is meant to cover.
 *
 * An error flag is only useful if something says what it means, and the banner's
 * answer lives in one ordered list. This is the guard that turns "someone added a
 * flag" into "the banner now names it": a missing row, a duplicate, or a row for a
 * cause that no longer exists all fail here.
 *
 * The flag list is read from the store's own initial state, not written out again
 * here. A hand-written second list could drift in the same direction as the bug it
 * is meant to catch; `ConnectionError` cannot gain a flag without `initialState`
 * gaining it too, or the type check fails.
 */
import { describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import { connectionState } from '#lib/stores/connectionStore.ts';
import { BANNER_ONLY_ERROR_FLAGS, CONNECTION_ERROR_BANNERS } from '#lib/utils/connectionErrorCatalog.ts';
import type { ConnectionError } from '#lib/types.ts';

const FLAGS = Object.keys(get(connectionState).errors) as (keyof ConnectionError)[];

describe('the connection error catalog', () => {
    it('holds exactly one row per cause the app can hold', () => {
        expect(CONNECTION_ERROR_BANNERS.map((row) => row.flag).sort()).toEqual([...FLAGS].sort());
    });

    it('says something for every cause', () => {
        for (const row of CONNECTION_ERROR_BANNERS) {
            expect(row.reason.trim().length, row.flag).toBeGreaterThan(0);
        }
    });

    it('marks only real causes as banner-only', () => {
        const known = new Set(CONNECTION_ERROR_BANNERS.map((row) => row.flag));

        for (const flag of BANNER_ONLY_ERROR_FLAGS) {
            expect(known.has(flag), `${flag} is not a cause the catalog knows`).toBe(true);
        }

        // The two exceptions are deliberate and few: neither has a fix a reader can
        // take from the connection form, so the form stays silent about them. If a
        // third cause is ever listed here, that has to be a decision, not a default.
        expect([...BANNER_ONLY_ERROR_FLAGS].sort()).toEqual(['securityError', 'uploadError']);
    });
});
