#!/usr/bin/env node
// Fail fast when a stale nested node_modules shadows the root install.
//
// Node resolves a bare specifier by walking up from the importing file and taking the first
// node_modules it finds. This repo once had its own package at src-svelte/package.json (until
// e7c8aaa0, "consolidate npm configs at repo root"), and a working copy that predates that
// commit still has the src-svelte/node_modules it produced: git deletes tracked files, never
// untracked directories, and .gitignore's `node_modules/` matches at any depth, so nothing
// ever surfaces it.
//
// The damage is invisible until it isn't. Vite resolves Kit's runtime from inside the root
// tree, but the chunks it emits keep their bare specifiers, so Kit's post-build route analysis
// loads them from src-svelte/.svelte-kit/output/... — under that stale tree. The result is an
// older Kit pinned to the app's own build output, reported as a missing named export deep
// inside a worker thread, which is a hard thing to guess at from the stack trace alone.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRoot = fileURLToPath(new URL('..', import.meta.url));

// Directories this repo builds source in. `packages/*/node_modules` is legitimate npm
// workspace nesting, so this is a fixed allow-list rather than a scan — a scan would report
// the workspace tree as a defect.
const GUARDED_DIRS = ['src-svelte', 'src-tauri', 'src-angular'];

// Packages whose version explains the failure a shadowed tree causes.
const TELLTALE_PACKAGES = ['@sveltejs/kit', 'svelte', 'vite'];

/** Read a package's version from a nested tree, or null if it is not installed there. */
function versionOf(nestedRoot, name) {
    try {
        const manifest = JSON.parse(readFileSync(join(nestedRoot, name, 'package.json'), 'utf8'));
        return manifest.version ?? null;
    } catch {
        return null;
    }
}

/** Report each guarded directory that contains a node_modules, with what it shadows. */
function findShadowedTrees(root) {
    const found = [];
    for (const dir of GUARDED_DIRS) {
        const nested = join(root, dir, 'node_modules');
        if (!existsSync(nested)) continue;
        const shadows = TELLTALE_PACKAGES.map((name) => ({ name, version: versionOf(nested, name) }))
            .filter((entry) => entry.version !== null);
        found.push({ dir, nested, shadows });
    }
    return found;
}

// resolve, not join: join would append an absolute argument to the cwd instead of replacing it.
const root = process.argv[2] ? resolve(process.argv[2]) : defaultRoot;
const found = findShadowedTrees(root);

if (found.length === 0) {
    process.exit(0);
}

const lines = [
    '',
    'Build refused: a nested node_modules shadows the root install.',
    '',
    'Node resolves bare specifiers from the nearest node_modules walking up from the importing',
    'file, so these trees win over the root one for anything resolved under them — including',
    'the chunks this build emits.',
    '',
];

for (const entry of found) {
    lines.push(`  ${entry.nested}`);
    for (const shadow of entry.shadows) {
        lines.push(`      shadows ${shadow.name} with ${shadow.version}`);
    }
    lines.push('');
}

lines.push('Remove them (they are untracked, so git will never do it for you):');
lines.push('  Windows: rmdir /s /q src-svelte\\node_modules');
lines.push('  POSIX:   rm -rf src-svelte/node_modules');
lines.push('');
lines.push('Then re-run the install at the repo root.');
lines.push('');

process.stderr.write(lines.join('\n'));
process.exit(1);
