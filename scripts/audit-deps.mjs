#!/usr/bin/env node
// Report dependency exposure for both ecosystems this repo ships.
//
// Two questions, deliberately kept apart, because they have different answers:
//
//   1. Is anything in a *lockfile* covered by a published advisory? (RustSec for
//      src-tauri/Cargo.lock, npm audit for package-lock.json.)
//   2. Is a *manifest* dependency behind the newest stable release upstream?
//
// A finding is actionable only when the package manager could actually apply the fix
// without editing a version requirement. For npm that is what npm itself reports
// (`fixAvailable`, and not a semver-major one). For cargo it is decided by asking cargo:
// a dry-run `cargo update` in a throwaway copy of the manifest and lock, and checking
// whether the resolver moves the affected crate into the advisory's patched range. A
// caret-range guess is not enough — a compatible patch can be blocked by an upper-bounded
// requirement elsewhere in the graph, and glib 0.18.5 (fixed only in 0.20, pinned by
// tauri's Linux chain) is exactly the kind of finding that would otherwise make this job
// permanently red and therefore ignored.
//
// Exit status:
//   0  no actionable finding
//   1  at least one actionable finding
//   2  the audit could not be completed (advisory database unavailable, npm audit
//      unreadable) — an audit that saw nothing must never look like an audit that
//      found nothing
//
// Usage:
//   node scripts/audit-deps.mjs [--advisory-db <dir>] [--summary <file>] [--upstream]
//                               [--lock <file>] [--skip-npm] [--no-cargo]
// Without --advisory-db the RustSec database is cloned (or refreshed) under the system
// temp dir, so a local run pays for the clone once and is cheap afterwards.

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------------ versions */

/**
 * Split a version into comparable numbers.
 *
 * RustSec ranges are written at whatever precision the advisory author chose — `>= 1.0`,
 * `< 1.2`, `>=0.20.0` all appear in the database — so a missing component is read as 0,
 * which is what `< 1.2` means (`< 1.2.0`). Requiring three components here would fail to
 * match the range, and an advisory would silently read as not affecting us.
 */
export function parseVersion(value) {
    const m = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(value).trim());
    if (!m) return null;
    return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3] ?? 0) };
}

/** Three-way compare on major/minor/patch. */
export function compareVersions(a, b) {
    for (const key of ['major', 'minor', 'patch']) {
        if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
    }
    return 0;
}

/**
 * Match a version against a Cargo-style requirement: `= 1.2.3`, `< 1.2.3`,
 * `>= 1.0, < 1.2`. Comma-separated parts must all hold.
 */
export function matchesRequirement(version, requirement) {
    return requirement.split(',').map((part) => part.trim()).filter(Boolean).every((part) => {
        const m = /^(<=|>=|=|<|>)?\s*(.+)$/.exec(part);
        if (!m) return false;
        const target = parseVersion(m[2]);
        if (!target) return false;
        const order = compareVersions(version, target);
        switch (m[1] ?? '=') {
            case '<': return order < 0;
            case '<=': return order <= 0;
            case '>': return order > 0;
            case '>=': return order >= 0;
            default: return order === 0;
        }
    });
}

/**
 * Would a caret requirement built from `base` accept `candidate`?
 *
 * Cargo treats a leading zero as part of the breaking surface: `^0.18.2` stops at
 * 0.19.0 and `^0.0.3` stops at 0.1.0. So compatibility means same major for 1+,
 * same major and minor for 0.x.
 *
 * This is a *necessary* condition for `cargo update` to reach a fix, not a sufficient
 * one — see cargoResolution for the authoritative check.
 */
export function semverCompatible(base, candidate) {
    const a = parseVersion(base);
    const b = parseVersion(candidate);
    if (!a || !b) return false;
    if (compareVersions(a, b) > 0) return false;
    if (a.major > 0) return a.major === b.major;
    return a.major === b.major && a.minor === b.minor;
}

/* ------------------------------------------------------------------- cargo */

/** Read `[[package]] name/version` pairs out of a Cargo.lock. */
export function parseCargoLock(text) {
    const packages = [];
    for (const block of text.split('[[package]]').slice(1)) {
        const name = /name = "([^"]+)"/.exec(block)?.[1];
        const version = /version = "([^"]+)"/.exec(block)?.[1];
        if (name && version) packages.push({ name, version });
    }
    return packages;
}

/** Read the direct dependencies out of a Cargo.toml ([dependencies] / [build-dependencies]). */
export function parseCargoManifest(text) {
    const deps = [];
    let section = '';
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        const header = /^\[([^\]]+)\]/.exec(trimmed);
        if (header) {
            section = header[1];
            continue;
        }
        if (section !== 'dependencies' && section !== 'build-dependencies') continue;
        if (trimmed.startsWith('#')) continue;
        const m = /^([A-Za-z0-9_-]+)\s*=\s*(?:"([^"]+)"|\{[^}]*version\s*=\s*"([^"]+)")/.exec(trimmed);
        if (!m) continue;
        deps.push({ name: m[1], requirement: m[2] ?? m[3], section });
    }
    return deps;
}

/**
 * Parse the toml block of one RustSec advisory file.
 *
 * Advisories are `.md` with a fenced ```toml block; `broken` is often omitted, and
 * RustSec's meaning then is "every version except those named by patched/unaffected".
 */
export function parseAdvisory(text) {
    const block = /```toml\n([\s\S]*?)```/.exec(text)?.[1] ?? '';
    const str = (key) => new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, 'm').exec(block)?.[1] ?? '';
    const list = (key) => {
        const m = new RegExp(`^${key}\\s*=\\s*\\[([^\\]]*)\\]`, 'm').exec(block);
        return m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [];
    };
    return {
        id: str('id'),
        package: str('package'),
        url: str('url'),
        categories: list('categories'),
        withdrawn: str('withdrawn'),
        broken: list('broken'),
        patched: list('patched'),
        unaffected: list('unaffected'),
        title: (/^# (.+)$/m.exec(text)?.[1] ?? '').trim(),
    };
}

/**
 * Load every advisory for the crates in `cratesDir`, skipping withdrawn ones as
 * cargo-audit does.
 *
 * Returns `loaded: false` when the directory is missing or holds no advisories at all.
 * That is not the same as "no crate is vulnerable", and callers must not treat it so.
 */
export function loadAdvisories(cratesDir) {
    const byPackage = new Map();
    if (!existsSync(cratesDir)) return { byPackage, loaded: false, crateCount: 0 };
    for (const name of readdirSync(cratesDir)) {
        const dir = join(cratesDir, name);
        let files;
        try {
            files = readdirSync(dir);
        } catch {
            continue;
        }
        const advisories = [];
        for (const file of files.filter((f) => f.endsWith('.md'))) {
            const advisory = parseAdvisory(readFileSync(join(dir, file), 'utf8'));
            if (advisory.withdrawn) continue;
            advisories.push(advisory);
        }
        if (advisories.length) byPackage.set(name, advisories);
    }
    return { byPackage, loaded: byPackage.size > 0, crateCount: byPackage.size };
}

/** Match a Cargo.lock against loaded advisories; reachability is decided later. */
export function auditCargoLock(packages, advisories) {
    const findings = [];
    for (const { name, version } of packages) {
        const locked = parseVersion(version);
        const list = advisories.get(name);
        if (!locked || !list) continue;
        for (const advisory of list) {
            const broken = advisory.broken.length === 0
                || advisory.broken.some((range) => matchesRequirement(locked, range));
            if (!broken) continue;
            if ([...advisory.patched, ...advisory.unaffected].some((range) => matchesRequirement(locked, range))) continue;
            findings.push({
                source: name,
                version,
                id: advisory.id,
                title: advisory.title,
                categories: advisory.categories.join(', '),
                patched: advisory.patched,
                patchedText: advisory.patched.join(' | ') || 'none published',
                url: advisory.url,
            });
        }
    }
    findings.sort((a, b) => a.source.localeCompare(b.source) || a.id.localeCompare(b.id));
    return findings;
}

/**
 * Ask cargo what it could actually resolve.
 *
 * Copies the manifest and lockfile into a throwaway directory and runs a dry-run
 * `cargo update`, which prints one `Updating name vA -> vB` line per crate the resolver
 * would move. That is the authoritative answer to "could we take this fix": it accounts
 * for every other requirement in the graph, which a caret guess about the affected crate
 * alone cannot.
 * Failure is reported, never absorbed. A cargo that is not installed, or a resolution that
 * exits nonzero (network, index, manifest error), yields ok:false: the audit then reports
 * itself as incomplete rather than guessing reachability and exiting 0 as if it had
 * measured something. The caret heuristic runs only when asked for explicitly (--no-cargo).
 */
export function cargoResolution(manifestPath, lockPath) {
    if (spawnSync('cargo', ['--version'], { encoding: 'utf8' }).status !== 0) {
        return { ok: false, absent: true, moves: null, reason: 'cargo is not installed' };
    }
    const probe = mkdtempSync(join(tmpdir(), 'gb-cargo-resolve-'));
    try {
        copyFileSync(manifestPath, join(probe, 'Cargo.toml'));
        copyFileSync(lockPath, join(probe, 'Cargo.lock'));
        mkdirSync(join(probe, 'src'), { recursive: true });
        writeFileSync(join(probe, 'src', 'main.rs'), 'fn main() {}\n');
        const result = spawnSync('cargo', ['update', '--dry-run', '--manifest-path', join(probe, 'Cargo.toml')], { encoding: 'utf8' });
        const text = `${result.stdout ?? ''}${result.stderr ?? ''}`;
        if (result.status !== 0) {
            // Partial output from a run that failed says nothing about the graph.
            const detail = text.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('error')).join(' | ') || `exit ${result.status}`;
            return { ok: false, absent: false, moves: null, reason: `cargo update --dry-run failed: ${detail}` };
        }
        return { ok: true, absent: false, moves: parseCargoUpdateOutput(text), reason: '' };
    } finally {
        rmSync(probe, { recursive: true, force: true });
    }
}

/**
 * Parse the move lines out of `cargo update` output.
 *
 * Keyed by crate name, holding every move for that name: a lockfile can carry two versions
 * of the same crate, and only a move starting from the version an advisory actually affects
 * says anything about that finding. `Removing` and `Replacing` lines are ignored on purpose
 * — they describe the graph changing, not a version this audit could adopt.
 */
export function parseCargoUpdateOutput(text) {
    const moved = new Map();
    for (const m of String(text).matchAll(/Updating\s+(\S+)\s+v(\S+)\s+->\s+v(\S+)/g)) {
        const moves = moved.get(m[1]) ?? [];
        moves.push({ from: m[2], to: m[3] });
        moved.set(m[1], moves);
    }
    return moved;
}

/**
 * Decide reachability per finding.
 *
 * With a cargo resolution the test is whether the resolver moved this exact locked version
 * into a patched range. Without one (explicit --no-cargo) it degrades to caret compatibility
 * against the locked version and records that basis, so the report can say so.
 *
 * Direction of the inference matters: a resolution that did not move a crate is evidence
 * that the current requirements do not allow the fix, not proof that no fix exists.
 */
export function classifyCargo(findings, resolution, allowHeuristic = true) {
    return findings.map((finding) => {
        if (resolution) {
            const actionable = (resolution.get(finding.source) ?? []).some((move) => {
                const landed = parseVersion(move.to);
                return move.from === finding.version && Boolean(landed) && finding.patched.some((range) => matchesRequirement(landed, range));
            });
            return { ...finding, actionable, basis: 'cargo resolution' };
        }
        // No resolution and no permission to guess: report the finding, claim nothing about
        // whether it could be fixed.
        if (!allowHeuristic) {
            return { ...finding, actionable: false, basis: 'not measured' };
        }
        const actionable = finding.patched
            .map((range) => /^(?:>=|=)\s*(.+)$/.exec(range)?.[1])
            .filter(Boolean)
            .some((fix) => semverCompatible(finding.version, fix));
        return { ...finding, actionable, basis: 'caret heuristic (--no-cargo)' };
    });
}

/** Clone or fast-forward the RustSec advisory database; returns its `crates` directory. */
export function ensureAdvisoryDb(cacheDir) {
    const repo = 'https://github.com/RustSec/advisory-db';
    if (existsSync(join(cacheDir, 'crates'))) {
        const fetch = spawnSync('git', ['-C', cacheDir, 'fetch', '--depth', '1', 'origin', 'HEAD'], { stdio: 'ignore' });
        if (fetch.status !== 0) return { cratesDir: null, note: `could not refresh ${cacheDir}` };
        spawnSync('git', ['-C', cacheDir, 'reset', '--hard', 'FETCH_HEAD'], { stdio: 'ignore' });
        return { cratesDir: join(cacheDir, 'crates'), note: '' };
    }
    const result = spawnSync('git', ['clone', '--depth', '1', '--quiet', repo, cacheDir], { stdio: 'inherit' });
    if (result.status !== 0) return { cratesDir: null, note: `could not clone ${repo}` };
    return { cratesDir: join(cacheDir, 'crates'), note: '' };
}

/** Ask crates.io for the newest stable release of each direct dependency. */
export function queryUpstream(deps) {
    const rows = [];
    for (const dep of deps) {
        const response = spawnSync('curl', ['-s', '-m', '15', '-A', 'glowing-bear dependency audit',
            `https://crates.io/api/v1/crates/${dep.name}`], { encoding: 'utf8' });
        let maxStable = 'unknown';
        try {
            maxStable = JSON.parse(response.stdout).crate.max_stable_version;
        } catch {
            // Freshness reporting is best effort; advisory coverage is not.
        }
        rows.push({ name: dep.name, requirement: dep.requirement, latest: maxStable });
    }
    return rows;
}

/* --------------------------------------------------------------------- npm */

/**
 * Is npm's own answer "we can fix this" without a breaking change?
 *
 * Measured shape (npm 11, `npm audit --json`): `fixAvailable` is `true`, `false`, or an
 * object like `{ name, version, isSemVerMajor: false }`. A fix that needs a major bump is
 * reported with `isSemVerMajor: true` and is not something the lockfile can take silently.
 */
export function npmFixable(info) {
    const fix = info?.fixAvailable;
    if (fix === true) return true;
    if (fix && typeof fix === 'object') return fix.isSemVerMajor === false;
    return false;
}

/**
 * Validate and flatten one `npm audit --json` payload.
 *
 * Parseable JSON is not automatically an audit result: npm answers with an error payload in
 * the same JSON channel, and a report that has no `vulnerabilities`/`metadata` is not a
 * clean audit — it is a missing one. Absence of rows only means absence of findings when the
 * shape says so.
 */
export function parseNpmAuditReport(stdout) {
    let report;
    try {
        report = JSON.parse(stdout);
    } catch {
        return { ok: false, rows: [], note: 'npm audit returned no parseable JSON' };
    }
    if (!report || typeof report !== 'object' || Array.isArray(report)) {
        return { ok: false, rows: [], note: 'npm audit returned a non-object payload' };
    }
    if (report.error || !report.vulnerabilities || !report.metadata) {
        const detail = report.error?.message ?? report.error?.description ?? 'missing vulnerabilities/metadata';
        return { ok: false, rows: [], note: `npm audit returned an unexpected payload: ${detail}` };
    }
    const rows = [];
    for (const [name, info] of Object.entries(report.vulnerabilities)) {
        const via = Array.isArray(info.via) ? info.via : [info.via];
        const fixable = npmFixable(info);
        for (const entry of via) {
            if (typeof entry === 'string') continue;
            rows.push({
                name,
                severity: entry.severity ?? info.severity ?? 'unknown',
                title: entry.title ?? '',
                range: entry.range ?? '',
                fixable,
                fixVersion: (info.fixAvailable && typeof info.fixAvailable === 'object') ? info.fixAvailable.version ?? '' : '',
                url: entry.url ?? '',
            });
        }
    }
    return { ok: true, rows, counts: report.metadata.vulnerabilities ?? {}, note: '' };
}

/** Run `npm audit --json` in `cwd` and validate its answer. */
export function auditNpm(cwd) {
    const result = spawnSync('npm', ['audit', '--json'], { cwd, encoding: 'utf8' });
    return parseNpmAuditReport(result.stdout);
}

/* ----------------------------------------------------------------- outcome */

/**
 * Turn the audit into an exit code.
 *
 * Coverage failure outranks findings. Three different things must not be mistaken for a clean
 * audit: an advisory database that could not be read, a cargo resolution that could not run
 * (so reachability was never measured), and an npm answer that was not an audit report.
 */
export function auditOutcome({ cargoFindings, cargoCoverageOk, cargoResolution, npmAudit, npmSkipped }) {
    const actionable = cargoFindings.filter((f) => f.actionable);
    if (!cargoCoverageOk) return { code: 2, reason: 'advisory database unavailable', actionableCount: actionable.length };
    if (cargoResolution && !cargoResolution.ok) return { code: 2, reason: cargoResolution.reason, actionableCount: actionable.length };
    if (!npmSkipped && !npmAudit.ok) return { code: 2, reason: npmAudit.note, actionableCount: actionable.length };
    const npmActionable = npmAudit.rows.filter((row) => row.fixable).length;
    if (actionable.length + npmActionable > 0) return { code: 1, reason: '', actionableCount: actionable.length, npmActionable };
    return { code: 0, reason: '', actionableCount: actionable.length, npmActionable };
}

/* ------------------------------------------------------------------ report */

/** Render the whole report as markdown (used for both stdout and the GitHub step summary). */
export function renderReport({ cargoFindings, cargoUpstream, npmAudit, npmSkipped, lockCount, resolutionNote, coverageNote }) {
    const lines = [];
    const actionable = cargoFindings.filter((f) => f.actionable);
    const informational = cargoFindings.filter((f) => !f.actionable);

    lines.push('## Dependency audit');
    lines.push('');
    lines.push(`Cargo.lock: ${lockCount} locked packages. RustSec findings: ${cargoFindings.length} ` +
        `(${actionable.length} actionable, ${informational.length} not moved by this resolution).`);
    lines.push(`Reachability basis: ${resolutionNote}.`);
    lines.push(`npm audit: ${npmSkipped ? 'skipped by request' : npmAudit.ok ? `${npmAudit.rows.length} advisory rows` : `FAILED — ${npmAudit.note}`}.`);
    if (coverageNote) lines.push(`Coverage note: ${coverageNote}`);
    lines.push('');

    const table = (headers, rows) => {
        lines.push(`| ${headers.join(' | ')} |`);
        lines.push(`| ${headers.map(() => '---').join(' | ')} |`);
        for (const row of rows) lines.push(`| ${row.join(' | ')} |`);
    };

    if (actionable.length) {
        lines.push('### Rust: actionable findings');
        lines.push('');
        lines.push('`cargo update` would take these without a manifest change.');
        lines.push('');
        table(['advisory', 'crate', 'locked', 'patched in'],
            actionable.map((f) => [`[${f.id}](${f.url})`, f.source, f.version, f.patchedText]));
        lines.push('');
    }
    if (informational.length) {
        lines.push('### Rust: findings this resolution did not move');
        lines.push('');
        lines.push('No fix was demonstrated by this resolution — usually because the patched version lies outside what the current requirements allow, but a fix could also arrive through a dependency being replaced rather than updated.');
        lines.push('');
        table(['advisory', 'crate', 'locked', 'patched in'],
            informational.map((f) => [`[${f.id}](${f.url})`, f.source, f.version, f.patchedText]));
        lines.push('');
    }
    if (npmAudit.ok && npmAudit.rows.length) {
        lines.push('### npm');
        lines.push('');
        table(['package', 'severity', 'advisory', 'fix by `npm audit fix`'],
            npmAudit.rows.map((r) => [r.name, r.severity, `[${r.title}](${r.url})`, r.fixable ? `yes${r.fixVersion ? ` → ${r.fixVersion}` : ''}` : 'no']));
        lines.push('');
    } else if (npmAudit.ok) {
        lines.push('### npm');
        lines.push('');
        lines.push('No advisories on the locked tree.');
        lines.push('');
    }
    if (cargoUpstream?.length) {
        lines.push('### Rust: direct dependencies vs crates.io');
        lines.push('');
        table(['crate', 'manifest', 'latest stable'],
            cargoUpstream.map((r) => [r.name, r.requirement, r.latest]));
        lines.push('');
    }
    return lines.join('\n');
}

/* -------------------------------------------------------------------- main */

function parseArgs(argv) {
    const args = { advisoryDb: null, summary: null, upstream: false, lock: null, manifest: null, skipNpm: false, noCargo: false };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--advisory-db') args.advisoryDb = argv[++i];
        else if (argv[i] === '--summary') args.summary = argv[++i];
        else if (argv[i] === '--upstream') args.upstream = true;
        else if (argv[i] === '--lock') args.lock = argv[++i];
        else if (argv[i] === '--manifest') args.manifest = argv[++i];
        else if (argv[i] === '--skip-npm') args.skipNpm = true;
        else if (argv[i] === '--no-cargo') args.noCargo = true;
    }
    return args;
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const tauriDir = join(repoRoot, 'src-tauri');
    const lockPath = args.lock ?? join(tauriDir, 'Cargo.lock');
    const manifestPath = args.manifest ?? join(tauriDir, 'Cargo.toml');

    const packages = parseCargoLock(readFileSync(lockPath, 'utf8'));
    const { cratesDir, note: cloneNote } = args.advisoryDb
        ? { cratesDir: args.advisoryDb, note: '' }
        : ensureAdvisoryDb(join(tmpdir(), 'gb-rustsec-advisory-db'));
    const { byPackage, loaded } = loadAdvisories(cratesDir);
    // --no-cargo is the only way to get the caret heuristic: without it, a cargo that is
    // missing or fails to resolve makes the audit incomplete instead of guessed.
    const resolution = args.noCargo ? null : cargoResolution(manifestPath, lockPath);
    const resolutionNote = args.noCargo
        ? 'caret heuristic (explicit --no-cargo; reachability was not measured)'
        : resolution.ok
            ? 'cargo resolution (a dry-run `cargo update` in a copy of the manifest and lock)'
            : `NOT MEASURED — ${resolution.reason}`;
    // Heuristic classification is only allowed when the caller asked for it. If the resolver
    // failed, findings are reported with no claim about fixability.
    const findings = classifyCargo(auditCargoLock(packages, byPackage), resolution ? resolution.moves : null, args.noCargo);
    const upstream = args.upstream ? queryUpstream(parseCargoManifest(readFileSync(manifestPath, 'utf8'))) : null;
    const npmAudit = args.skipNpm ? { ok: false, rows: [], note: 'skipped' } : auditNpm(repoRoot);

    const report = renderReport({
        cargoFindings: findings,
        cargoUpstream: upstream,
        npmAudit,
        npmSkipped: args.skipNpm,
        lockCount: packages.length,
        resolutionNote,
        coverageNote: cloneNote,
    });
    console.log(report);
    if (args.summary) writeFileSync(args.summary, `${report}\n`);

    const outcome = auditOutcome({ cargoFindings: findings, cargoCoverageOk: loaded, cargoResolution: resolution, npmAudit, npmSkipped: args.skipNpm });
    const npmActionable = outcome.npmActionable ?? 0;
    console.log(`\naudit-deps: ${outcome.actionableCount} actionable Rust finding(s), ${npmActionable} fixable npm finding(s).`);
    if (outcome.code === 2) console.log(`audit-deps: INCOMPLETE — ${outcome.reason || 'advisory database unavailable'}`);
    process.exit(outcome.code);
}

// Only run when invoked as a program: the unit tests import these helpers directly, and
// under Vitest process.argv[1] is the test runner, not this file.
const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) main();
