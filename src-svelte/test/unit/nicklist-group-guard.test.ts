import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { ROOT_GROUP_KEY, isRootGroup, nickGroupKey } from '#lib/nicklistGroup.ts';
import { codeOf, sourceFiles } from './sourceText.ts';

/**
 * The root nicklist group is one key, not a spelling.
 *
 * Three files needed this key and each wrote it by hand: the legacy handler
 * walked a nicklist with it, the API reducer invented it for a nameless group,
 * and the component sorted it first and drew no divider under it. A rename in one
 * of them is invisible in the other two — the root group turns into an ordinary
 * group, mid-list with a divider, and the lookups keep asking for a name nothing
 * stores under any more.
 */

const OWNER = 'src-svelte/src/lib/nicklistGroup.ts';

describe('nicks with no group land in the root group', () => {
    it('files a nameless group under the root key', () => {
        expect(nickGroupKey('')).toBe(ROOT_GROUP_KEY);
        expect(nickGroupKey(undefined)).toBe(ROOT_GROUP_KEY);
        expect(nickGroupKey(null)).toBe(ROOT_GROUP_KEY);
    });

    it('keeps a named group under its own name', () => {
        expect(nickGroupKey('opers')).toBe('opers');
        expect(isRootGroup('opers')).toBe(false);
    });

    it('recognises the root key it filed things under', () => {
        // Live evidence, not inference. In the recorded lifecycle frame
        // (`api-dossier/frames/probe-lifecycle.jsonl`, gbtest on WeeChat 4.10.1) the
        // snapshot arrives as `"nicklist_root": {"id": 0, …, "name": "root"}`, and the
        // app keys groups by name — so this spelling is the relay's, not a choice.
        // The display rule that depends on it is owned by nicklist-root-rows.test.ts,
        // which renders root nicks as bare rows before the grouped sections: no gbtest
        // nick has a null `parent_group_id`, so that file is the only coverage of
        // root-level nicks on either transport.
        expect(ROOT_GROUP_KEY).toBe('root');
        expect(isRootGroup(nickGroupKey(''))).toBe(true);
    });
});

describe('the key is spelled once', () => {
    it('only the owner module writes the literal', () => {
        const offenders = sourceFiles('src-svelte/src')
            .filter((file) => file !== OWNER)
            .filter((file) => /(['"])root\1/.test(codeOf(file)))
            .map((file) => file.replace(/^src-svelte\/src\//, ''));
        expect(offenders).toEqual([]);
    });

    it('every reader imports it from the owner', () => {
        // Comments may still name the key in prose; only code is checked.
        for (const file of ['lib/stores/handlers.ts', 'lib/api/api-store-reducers.ts', 'components/Nicklist.svelte']) {
            const code = codeOf(`src-svelte/src/${file}`);
            expect(code).toMatch(/from ['"]#lib\/nicklistGroup\.ts['"]/);
            expect(readFileSync(`src-svelte/src/${file}`, 'utf8')).toContain('nicklistGroup');
        }
    });
});
