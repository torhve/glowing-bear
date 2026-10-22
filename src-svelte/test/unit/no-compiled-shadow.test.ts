/**
 * No compiled `.js` file may sit beside the source it was compiled from.
 *
 * Vite resolves `*.js` before `*.ts`, so a stray `lib/notifications.js` beside
 * `lib/notifications.ts` silently replaces the real module in every import that
 * spells the extension-less specifier — the tests then run stale code and pass.
 * This happened for real: a `tsc` invocation without `--noEmit` emitted 384 such
 * files across `src-svelte/` and `packages/weechat-format/`, and eslint only
 * noticed because the emitted files happened to carry warnings.
 *
 * Legitimate JavaScript is either tracked (`test/fixtures/weechat-old.js`, which
 * pins the old protocol) or a `.mjs` script. The check is a sibling test, not a
 * git status: an emitted file is invisible to git only while it is ignored.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SCANNED = ['src-svelte/src', 'src-svelte/test', 'src-svelte/e2e', 'packages/weechat-format/src', 'packages/weechat-format/test'];

/** Every file under a directory, recursively. */
function walk(dir: string): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) found.push(...walk(path));
        else found.push(path);
    }
    return found;
}

describe('a source file has no compiled twin beside it', () => {
    it('no .js file has a .ts or .svelte sibling', () => {
        const shadows = SCANNED.flatMap(walk)
            .filter((file) => file.endsWith('.js'))
            .filter((file) => statSyncSafe(`${file.slice(0, -3)}.ts`) || statSyncSafe(`${file.slice(0, -3)}.svelte`));
        expect(shadows).toEqual([]);
    });
});

function statSyncSafe(path: string): boolean {
    try {
        return statSync(path).isFile();
    } catch {
        return false;
    }
}
