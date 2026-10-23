/**
 * The test settings default must be the app's settings default.
 *
 * `helpers/mockSettings.ts` writes the defaults out as a literal so a test that
 * mocks the settings module does not have to import it. That is only safe while
 * the two copies agree, and nothing else checks that they do: the mock factory
 * was never typed against `Settings`, which is how four stale fields survived in
 * it. This is the check that replaces the typing the mock could not have.
 */
import { describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import { settings } from '#lib/stores/settings.ts';
import { TEST_SETTINGS } from './helpers/mockSettings.ts';

describe('test settings default tracks the app default', () => {
    it('the helper and the real store agree field for field', () => {
        const live = get(settings);
        // A stored profile from an earlier test would make the comparison about
        // storage rather than about defaults.
        expect(live, 'the real store should still hold its own defaults here').not.toHaveProperty('notifyDMs');

        const liveKeys = Object.keys(live).sort();
        const helperKeys = Object.keys(TEST_SETTINGS).sort();
        expect(helperKeys, 'fields the helper has and the store does not, or the reverse').toEqual(liveKeys);

        for (const key of helperKeys) {
            expect(TEST_SETTINGS[key as keyof typeof TEST_SETTINGS], `settings.${key}`).toEqual(
                live[key as keyof typeof live],
            );
        }
    });
});
