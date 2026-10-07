import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// __dirname rather than import.meta.url: Vitest hands transformed modules a virtual URL that is
// not a file: scheme, so fileURLToPath would throw here.
const script = resolve(__dirname, '../../../scripts/check-nested-deps.mjs');

/** Run the guard against a fixture root and return its exit status and stderr. */
function run(root: string): { status: number | null; stderr: string } {
    const result = spawnSync(process.execPath, [script, root], { encoding: 'utf8' });
    return { status: result.status, stderr: result.stderr };
}

/** Create a fixture root containing a nested node_modules at `relative`. */
function fixture(relative: string, packageName?: string, version?: string): string {
    const root = mkdtempSync(join(tmpdir(), 'gb-nested-deps-'));
    const nested = join(root, relative);
    if (packageName && version) {
        const target = join(nested, packageName);
        mkdirSync(target, { recursive: true });
        writeFileSync(join(target, 'package.json'), JSON.stringify({ name: packageName, version }));
    } else {
        mkdirSync(nested, { recursive: true });
    }
    return root;
}

describe('nested node_modules guard', () => {
    it('refuses a stale tree under src-svelte and names the package it shadows', () => {
        const root = fixture('src-svelte/node_modules', '@sveltejs/kit', '2.68.0');
        try {
            const { status, stderr } = run(root);
            expect(status).toBe(1);
            expect(stderr).toContain('Build refused');
            expect(stderr).toContain('shadows @sveltejs/kit with 2.68.0');
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('refuses a stale tree even when nothing tells a version', () => {
        const root = fixture('src-tauri/node_modules');
        try {
            const { status, stderr } = run(root);
            expect(status).toBe(1);
            expect(stderr).toContain(join('src-tauri', 'node_modules'));
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('leaves workspace nesting alone', () => {
        // packages/*/node_modules is how npm nests workspace dependencies; reporting it would
        // make the guard cry wolf about a healthy install.
        const root = fixture('packages/weechat-format/node_modules', 'typescript', '6.0.0');
        try {
            const { status } = run(root);
            expect(status).toBe(0);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('accepts a clean tree', () => {
        const root = fixture('src-svelte/src');
        try {
            const { status, stderr } = run(root);
            expect(status).toBe(0);
            expect(stderr).toBe('');
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('passes on this repository as it stands', () => {
        // No argument means the script's own repo root, so this asserts the working copy has no
        // shadowed tree — the condition that broke `npm run tauri build` on a stale checkout.
        const result = spawnSync(process.execPath, [script], { encoding: 'utf8' });
        expect(result.stderr).toBe('');
        expect(result.status).toBe(0);
    });
});
