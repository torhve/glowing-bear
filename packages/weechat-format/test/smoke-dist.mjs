#!/usr/bin/env node
/**
 * Distribution smoke test.
 *
 * Proves the *built* package works for a consumer: it is imported by package name
 * from a directory outside the workspace, with no SvelteKit, no Vite, no path
 * aliases and no workspace linkage beyond a plain node_modules entry. It also
 * proves the published artifact is dependency-free.
 *
 * Run with: npm run smoke:dist
 */

import { execFileSync } from 'node:child_process';
import {
    chmodSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const packageRoot = path.resolve(import.meta.dirname, '..');
const distDir = path.join(packageRoot, 'dist');

function fail(message) {
    console.error(`smoke: ${message}`);
    process.exit(1);
}

// ---- 1. The build exists ----------------------------------------------------

if (!existsSync(path.join(distDir, 'index.js'))) {
    fail('dist/index.js is missing — run npm run build first');
}

// ---- 2. The artifact has no runtime dependencies ----------------------------

const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
for (const field of ['dependencies', 'peerDependencies']) {
    if (manifest[field] && Object.keys(manifest[field]).length > 0) {
        fail(`package.json declares ${field}: ${JSON.stringify(manifest[field])}`);
    }
}

const bareImports = new Set();
for (const entry of readdirSync(distDir, { recursive: true })) {
    const file = path.join(distDir, entry);
    if (!entry.toString().endsWith('.js') || !existsSync(file)) continue;
    for (const match of readFileSync(file, 'utf8').matchAll(/(?:import|from)\s+['"]([^'"]+)['"]/g)) {
        const specifier = match[1];
        if (!specifier.startsWith('.') && !specifier.startsWith('node:')) {
            bareImports.add(`${entry}: ${specifier}`);
        }
    }
}
if (bareImports.size > 0) {
    fail(`dist imports non-relative modules:\n  ${[...bareImports].join('\n  ')}`);
}

// ---- 3. A consumer outside the workspace can import it by name --------------

const sandbox = path.join(tmpdir(), `weechat-format-smoke-${createHash('sha1').update(packageRoot).digest('hex').slice(0, 10)}`);
rmSync(sandbox, { recursive: true, force: true });
mkdirSync(path.join(sandbox, 'node_modules', '@glowingbear'), { recursive: true });
symlinkSync(packageRoot, path.join(sandbox, 'node_modules', '@glowingbear', 'weechat-format'), 'dir');
writeFileSync(path.join(sandbox, 'package.json'), JSON.stringify({ name: 'smoke-consumer', private: true, type: 'module' }));

const consumer = `
import assert from 'node:assert/strict';
import {
    INITIAL_STYLE,
    MAX_EXTENDED_COLOR,
    MAX_THEME_COLOR,
    MAX_WEECHAT_COLOR,
    THEME_COLORS,
    WEECHAT_PALETTE,
    parseWeeChatStyle,
    parseWeeChatText,
    stylesEqual,
} from '@glowingbear/weechat-format';

const C = '\\u0019';

// A realistic chat line: theme colors, an attribute, a combined control, a reset.
const line = \`\${C}0212:34 \${C}14nick\${C}28: \${C}F03red\${C}B04bg\${C}\u001cplain\`;
const runs = parseWeeChatText(line);

assert.ok(runs.length >= 4, 'expected several runs');
assert.equal(runs.map((run) => run.text).join(''), '12:34 nick: redbgplain');
assert.equal(runs[0].style.fg.name, 'chat_time');
assert.equal(runs.find((run) => run.text === 'red')?.style.fg.name, 'red');
assert.equal(runs.find((run) => run.text === 'bg')?.style.bg.name, 'lightred');
assert.equal(runs.at(-1).style.fg.kind, 'default');

// Style-only payloads (nick / prefix color fields) parse without text.
const style = parseWeechatStyleGuard(\`\${C}F03\`);
assert.equal(style.fg.name, 'red');
function parseWeechatStyleGuard(input) {
    const result = parseWeeChatStyle(input);
    assert.equal(result.ok, true, 'style-only payload must parse');
    return result.style;
}

// A style-only payload containing text is rejected rather than guessed at.
assert.equal(parseWeeChatStyle('nick').ok, false);

// Tables and constants are available to consumers that must resolve references.
assert.equal(WEECHAT_PALETTE.length, 17);
assert.equal(THEME_COLORS.length, 47);
assert.equal(MAX_WEECHAT_COLOR, 16);
assert.equal(MAX_THEME_COLOR, 46);
assert.equal(MAX_EXTENDED_COLOR, 99999);

// Initial state is frozen, and text with no controls parses to exactly it.
assert.equal(Object.isFrozen(INITIAL_STYLE), true);
assert.equal(stylesEqual(INITIAL_STYLE, parseWeeChatText('plain')[0].style), true);
// A reset restores colors but keeps attributes, so it is not the initial style.
assert.equal(parseWeeChatText(\`\${C}F03a\${C}\u001cb\`).at(-1).style.fg.kind, 'default');
assert.equal(parseWeeChatText(\`\${C}F03a\${C}\u001cb\`).at(-1).style.attrs.bold, 'disabled');

console.log('consumer ok:', runs.length, 'runs');
`;
writeFileSync(path.join(sandbox, 'consumer.mjs'), consumer);
chmodSync(path.join(sandbox, 'consumer.mjs'), 0o644);

const result = execFileSync(process.execPath, ['consumer.mjs'], {
    cwd: sandbox,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
});
process.stdout.write(result);

// ---- 4. The same artifact is importable from the workspace root -------------

const fromRoot = await import(pathToFileURL(path.join(distDir, 'index.js')).href);
if (typeof fromRoot.parseWeeChatText !== 'function' || typeof fromRoot.parseWeeChatStyle !== 'function') {
    fail('dist/index.js does not export the two parse functions');
}

// ---- 5. A strict TypeScript consumer type-checks against dist/index.d.ts ----

const tscBin = path.resolve(packageRoot, '../../node_modules/typescript/bin/tsc');
if (existsSync(tscBin)) {
    writeFileSync(path.join(sandbox, 'tsconfig.json'), JSON.stringify({
        compilerOptions: {
            target: 'es2022',
            module: 'nodenext',
            moduleResolution: 'nodenext',
            strict: true,
            noUncheckedIndexedAccess: true,
            noEmit: true,
        },
        files: ['consumer.ts'],
    }));
    writeFileSync(path.join(sandbox, 'consumer.ts'), [
        "import { parseWeeChatStyle, parseWeeChatText } from '@glowingbear/weechat-format';",
        "import type { ParseDiagnostic, Style, TextRun } from '@glowingbear/weechat-format';",
        '',
        'const diagnostics: ParseDiagnostic[] = [];',
        "const runs: readonly TextRun[] = parseWeeChatText('\\u0019F03red', { onDiagnostic: (d) => diagnostics.push(d) });",
        'const style: Style = runs[0]!.style;',
        'const runText: string = runs[0]!.text;',
        "const kind: 'default' | 'weechat' | 'theme' | 'extended' = style.fg.kind;",
        "const result = parseWeeChatStyle('\\u0019F03');",
        'const accepted: boolean = result.ok;',
        'export { accepted, diagnostics, kind, runs, style };',
    ].join('\n'));
    execFileSync(process.execPath, [tscBin, '-p', 'tsconfig.json'], {
        cwd: sandbox,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    console.log('smoke: a strict TypeScript consumer type-checks against dist/index.d.ts');
} else {
    console.warn('smoke: typescript not found; skipped the typed consumer check');
}

// ---- 6. The published tarball installs and works outside the workspace ------

// A symlinked node_modules entry can hide packaging mistakes: a file excluded by
// `files`, or a dependency satisfied only by the workspace. `npm pack` + a real
// install into a separate directory proves the artifact a consumer would receive.
function npmRun(args, cwd) {
    const npmCli = process.env.npm_execpath;
    const command = npmCli ? process.execPath : 'npm';
    const argv = npmCli ? [npmCli, ...args] : args;
    return execFileSync(command, argv, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
}

const packDir = path.join(sandbox, 'pack');
const installDir = path.join(sandbox, 'install');
mkdirSync(packDir, { recursive: true });
mkdirSync(installDir, { recursive: true });
writeFileSync(path.join(installDir, 'package.json'), JSON.stringify({ name: 'tarball-consumer', private: true, type: 'module' }));
writeFileSync(path.join(installDir, 'consumer.mjs'), consumer);

const packed = npmRun(['pack', '--pack-destination', packDir, packageRoot], packageRoot);
const tarballName = packed.trim().split('\n').filter(Boolean).at(-1);
if (!tarballName || !existsSync(path.join(packDir, tarballName))) {
    fail(`npm pack did not produce a tarball (got ${JSON.stringify(packed)})`);
}

npmRun(['install', '--no-save', '--no-audit', '--no-fund', path.join(packDir, tarballName)], installDir);

const installedRoot = path.join(installDir, 'node_modules', '@glowingbear', 'weechat-format');
for (const required of ['dist/index.js', 'dist/index.d.ts', 'package.json']) {
    if (!existsSync(path.join(installedRoot, required))) {
        fail(`published tarball is missing ${required}`);
    }
}
for (const doc of ['docs/format.md', 'docs/behavior-differences.md']) {
    if (!existsSync(path.join(installedRoot, doc))) {
        fail(`published tarball is missing ${doc}`);
    }
}
if (existsSync(path.join(installedRoot, 'src'))) {
    fail('published tarball ships TypeScript sources; only dist and docs should be published');
}
if (existsSync(path.join(installDir, 'node_modules', '@glowingbear', 'weechat-format', 'node_modules'))) {
    fail('published tarball pulled in a nested dependency tree');
}

const tarballResult = execFileSync(process.execPath, ['consumer.mjs'], {
    cwd: installDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
});
process.stdout.write(tarballResult);
console.log(`smoke: ${tarballName} installs standalone and its consumer runs`);

rmSync(sandbox, { recursive: true, force: true });
console.log('smoke: dist artifact is dependency-free and importable by a plain consumer');
