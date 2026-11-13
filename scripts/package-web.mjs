#!/usr/bin/env node
/**
 * Package the built static site into a downloadable web release artifact.
 *
 * Input is the `build/` directory that `npm run build` writes with no
 * Input is the `build/` directory that `npm run build` writes. Output is one zip
 * plus a SHA256SUMS file in `dist/`.
 *
 * Kit bakes the served address into the build, so the packager reads that
 * address back out of the built files and refuses a build answering to another
 * address than the one the package claims. `--base-path` states the expected
 * address; the default is the origin root, which is what a release zip serves.
 *
 * Usage:
 *   node scripts/package-web.mjs [--build-dir build] [--out-dir dist]
 *                                [--name <basename>] [--base-path /]
 *
 * The name defaults to `glowing-bear-web-<version>` with the version read from
 * `package.json`, which RELEASE.md makes the release's source of truth.
 */
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strToU8, unzipSync, zipSync } from 'fflate';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Files `npm run build` copies into `build/` because it copies `static/` whole.
 * They are inputs to the icon generators (`npm run generate-icons` /
 * `generate-icns`), which write their output into `static/`. A web host serves
 * none of them, and the .icns alone is ~400 KB of the ~1.4 MB tree.
 */
const NOT_WEB_ASSETS = [
    { match: (name) => name === 'generate-icons.mjs', why: 'icon generator input' },
    { match: (name) => name === 'generate-icns.mjs', why: 'icon generator input' },
    { match: (name) => name.endsWith('.icns'), why: 'macOS bundle icon, not served' },
    { match: (name) => name === 'webapp.manifest.json', why: 'nothing reads it' },
    { match: (name) => name === '.DS_Store' || name === 'Thumbs.db', why: 'OS junk' },
];

/**
 * The files a Glowing Bear build must ship for the site to load at all. A
 * packaging run that drops one of these would publish a zip that 404s its own
 * entry point, so the check runs on the staged tree and on the zip.
 */
const REQUIRED_ENTRIES = ['index.html', '404.html', 'service-worker.js', 'manifest.webmanifest'];

function parseArgs(argv) {
    const args = { buildDir: 'build', outDir: 'dist', name: '', basePath: '' };
    for (let i = 0; i < argv.length; i += 2) {
        const flag = argv[i];
        const value = argv[i + 1];
        if (value === undefined) throw new Error(`missing value after ${flag}`);
        if (flag === '--build-dir') args.buildDir = value;
        else if (flag === '--out-dir') args.outDir = value;
        else if (flag === '--name') args.name = value;
        else if (flag === '--base-path') args.basePath = value;
        else throw new Error(`unknown flag ${flag}`);
    }
    return args;
}

/**
 * The address this build answers to, read from the asset URLs 404.html names.
 *
 * Measured with a plain static server: a build with `BASE_PATH` unset names
 * `/_app/immutable/...` there, and a `BASE_PATH=/bear` build names
 * `/bear/_app/immutable/...`. `index.html` names its assets relative to its own
 * directory in both builds, so 404.html is the file that records the address the
 * build was made for.
 */
function readBuiltBasePath(buildDir) {
    const html = readFileSync(join(buildDir, '404.html'), 'utf8');
    const named = html.match(/"((?:\/[^"]*?))_app\//);
    if (!named) fail(`${buildDir}/404.html names no _app/ asset — is this a built site?`);
    return normalizeBasePath(named[1]);
}

/** State a base path as a leading-and-trailing-slash path; '' is the origin root. */
function normalizeBasePath(value) {
    const trimmed = value.trim();
    if (trimmed === '' || trimmed === '/') return '/';
    if (!trimmed.startsWith('/')) fail(`--base-path ${value} must start with '/'`);
    return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

function fail(message) {
    console.error(`package-web: ${message}`);
    process.exit(1);
}

/** The version the release cuts: `package.json` is RELEASE.md's source of truth. */
function readVersion() {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
    if (typeof pkg.version !== 'string' || pkg.version === '') fail('package.json has no version');
    return pkg.version;
}

/** The commit the build carries, read the same way vite.config.ts reads it. */
function readCommit() {
    const fromEnv = process.env.GIT_COMMIT?.trim();
    if (fromEnv) return fromEnv;
    try {
        return execSync('git rev-parse --short HEAD', { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
            .toString()
            .trim();
    } catch {
        return 'unknown';
    }
}

/** Walk a directory into posix-style relative paths, sorted so output is stable. */
function walk(dir, rel = '') {
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const childRel = posix.join(rel, entry.name);
        if (entry.isDirectory()) out.push(...walk(join(dir, entry.name), childRel));
        else if (entry.isFile()) out.push({ rel: childRel, abs: join(dir, entry.name) });
        else fail(`${rel}${entry.name}: not a regular file — a symlink or socket has no place in a release zip`);
    }
    return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

/** Refuse a build directory that is not a built site, instead of zipping it. */
function assertBuiltSite(buildDir) {
    if (!existsSync(buildDir)) fail(`${buildDir} does not exist — run \`npm run build\` first`);
    for (const file of REQUIRED_ENTRIES) {
        if (!existsSync(join(buildDir, file))) fail(`${buildDir} is missing ${file} — run \`npm run build\` first`);
    }
    if (!existsSync(join(buildDir, '_app'))) fail(`${buildDir} is missing _app/ — run \`npm run build\` first`);
}

/**
 * The deploy note that travels inside the zip.
 *
 * Every claim about what a path resolves to is measured against this zip with a
 * plain static server. index.html references its assets relative to its own
 * directory (`./_app/immutable/...`), so it loads at the origin root and at any
 * directory root whose address ends with a slash. 404.html references them
 * root-absolutely (`/_app/immutable/...`), so the fallback for an unknown path
 * works only when the site owns the origin root.
 */
function deployNote(version, commit) {
    return `Glowing Bear ${version} — static web build (${commit})

Serve this directory over HTTP or HTTPS. Do not open index.html from the file
system: the browser refuses its ES modules and its service worker over file://.

1. Host this directory at the root of an origin. With nginx:

       root /var/www/glowing-bear;
       index index.html;

2. Answer a path that is not a file with 404.html:

       try_files $uri $uri/ /404.html;

   Glowing Bear has one page. An unknown path therefore shows a "Page not
   found" screen that links back to the app, and it works from any depth:
   404.html names its assets from the root, so it loads its own bundles from
   anywhere on the origin.

3. Cache policy. Everything under _app/immutable/ carries its content hash in
   its name and may be cached for a year. index.html, 404.html,
   service-worker.js, manifest.webmanifest and _app/version.json must be
   revalidated on every visit, or a returning user keeps the version they first
   loaded:

       location /_app/immutable/ { add_header Cache-Control "public, max-age=31536000, immutable"; }
       location = /index.html          { add_header Cache-Control "no-cache"; }
       location = /404.html            { add_header Cache-Control "no-cache"; }
       location = /service-worker.js   { add_header Cache-Control "no-cache"; }
       location = /manifest.webmanifest { add_header Cache-Control "no-cache"; }

   Caddy and Apache apply a matching default; check that they did.

4. This build answers to the root of an origin. 404.html names its assets from
   the root, so it is the one file in the build that cannot serve from a
   subdirectory. To host under a prefix, such as https://example.com/bear/,
   build it yourself with that prefix:

       BASE_PATH=/bear npm run build

   The address is fixed at build time, so a zip built for one address cannot
   The address is fixed at build time, so a zip built for one address cannot
   serve another. Serve the prefixed build from its directory root, and make
   sure the address ends with a slash. Without the slash the browser resolves
   the page's asset URLs one level too high, and the failure is quiet: the
   prerendered HTML paints a connect form, while every bundle 404s and the app
   cannot connect. Measured with this root-built zip served under a /bear
   prefix:
       /bear/    14 of 14 bundles 200  — app connects
       /bear     14 of 14 bundles 404  — form visible, inert
   Most web servers issue that redirect for you when the path is a directory
   (nginx, Caddy, Apache, static-web-server).

5. The page connects from the visitor's browser straight to your WeeChat
   relay. If this page is served over HTTPS, the relay must be reachable over
   TLS too: a browser will not open a plain ws:// connection from an HTTPS
   page. Set relay.network.tls on WeeChat, or front it with a TLS proxy.
   If relay.network.websocket_allowed_origins is set, this page's origin must
   match it.

   See README.md in the source repository for the relay setup and for the two
   relay protocols this version speaks.
`;
}

/** Read the zip back and confirm it holds exactly what was staged. */
function verifyZip(zipPath, stagedRels, expectedBytes) {
    const bytes = new Uint8Array(readFileSync(zipPath));
    if (bytes.length !== expectedBytes) fail(`${zipPath} is ${bytes.length} bytes, expected ${expectedBytes}`);

    const entries = Object.keys(unzipSync(bytes, { filter: (f) => f.name !== '/' })).sort();
    const staged = [...stagedRels].sort();
    if (entries.length !== staged.length) fail(`zip holds ${entries.length} entries, expected ${staged.length}`);
    for (let i = 0; i < staged.length; i += 1) {
        if (entries[i] !== staged[i]) fail(`zip entry ${i} is "${entries[i]}", expected "${staged[i]}"`);
    }
    for (const name of entries) {
        if (name.startsWith('/') || name.includes('..')) fail(`zip entry ${name} escapes the served directory`);
    }
    for (const file of REQUIRED_ENTRIES) {
        if (!entries.includes(file)) fail(`zip is missing ${file}`);
    }
    return entries.length;
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const version = readVersion();
    const commit = readCommit();
    const buildDir = join(REPO_ROOT, args.buildDir);
    const outDir = join(REPO_ROOT, args.outDir);
    const name = args.name || `glowing-bear-web-${version}`;

    assertBuiltSite(buildDir);
    const expectedBase = normalizeBasePath(args.basePath);
    const builtBase = readBuiltBasePath(buildDir);
    // The zip's name says which address it serves, and the build silently
    // carries the address it was built for. A `/bear` build packaged as the
    // release zip unpacks to a site whose 404 fallback names /bear/ files a
    // root host does not have — and it looks fine until someone types a wrong
    // URL. This session hit it by packaging a prefixed build left in build/.
    if (builtBase !== expectedBase) {
        const rebuild = expectedBase === '/'
            ? 'unset BASE_PATH, then npm run build'
            : `BASE_PATH=${expectedBase.replace(/\/$/, '')} npm run build`;
        fail(`the build answers to "${builtBase}" but this package serves "${expectedBase}". `
            + `Rebuild it for that address: ${rebuild}. `
            + `If the zip is meant to serve ${builtBase}, say so with --base-path ${builtBase}`);
    }
    const all = walk(buildDir);
    const dropped = [];
    const kept = [];
    for (const file of all) {
        const base = posix.basename(file.rel);
        const hit = NOT_WEB_ASSETS.find((rule) => rule.match(base));
        if (hit) dropped.push({ rel: file.rel, why: hit.why });
        else kept.push(file);
    }

    // The deploy note is part of the artifact, so it enters the staging tree
    // before the zip is built rather than being appended afterwards.
    const stagedDir = join(outDir, `${name}.staged`);
    rmSync(stagedDir, { recursive: true, force: true });
    mkdirSync(stagedDir, { recursive: true });
    const note = deployNote(version, commit);
    const stagedFiles = kept.map((f) => ({ rel: f.rel, data: new Uint8Array(readFileSync(f.abs)) }));
    stagedFiles.push({ rel: 'README-DEPLOY.txt', data: strToU8(note) });
    for (const f of stagedFiles) {
        const dest = join(stagedDir, ...f.rel.split('/'));
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, f.data);
    }

    // One fixed timestamp and a sorted entry order make two runs over the same
    // build produce the same bytes, so a re-run does not change a checksum.
    // The ZIP timestamp field is a DOS field: it cannot hold the Unix epoch, and
    // fflate rejects a date outside 1980-2099. The ZIP epoch itself is the fixed
    // value, so no file carries a build clock and two runs over one build produce
    // the same bytes.
    const ZIP_EPOCH = new Date(Date.UTC(1980, 0, 1, 0, 0, 0));
    const zipData = zipSync(
        Object.fromEntries(stagedFiles.map((f) => [f.rel, f.data])),
        { level: 9, mtime: ZIP_EPOCH }
    );

    const zipName = `${name}.zip`;
    const zipPath = join(outDir, zipName);
    writeFileSync(zipPath, zipData);
    const sha256 = createHash('sha256').update(zipData).digest('hex');
    writeFileSync(join(outDir, 'SHA256SUMS'), `${sha256}  ${zipName}\n`);

    const entryCount = verifyZip(zipPath, stagedFiles.map((f) => f.rel), zipData.length);

    const rawBytes = stagedFiles.reduce((sum, f) => sum + f.data.length, 0);
    console.log(`package-web: ${zipName} (commit ${commit})`);
    console.log(`  entries   ${entryCount}  (dropped ${dropped.length} build-time files: ${dropped.map((d) => d.rel).join(', ') || 'none'})`);
    console.log(`  unpacked  ${rawBytes} bytes`);
    console.log(`  zipped    ${zipData.length} bytes`);
    console.log(`  sha256    ${sha256}  ${zipName}`);
    console.log(`  base      ${builtBase}`);
    console.log(`  note      README-DEPLOY.txt`);
    rmSync(stagedDir, { recursive: true, force: true });
}

main();
