import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
    auditCargoLock,
    auditOutcome,
    classifyCargo,
    loadAdvisories,
    matchesRequirement,
    npmFixable,
    parseAdvisory,
    parseCargoLock,
    parseCargoManifest,
    parseCargoUpdateOutput,
    parseNpmAuditReport,
    semverCompatible,
} from '../../../scripts/audit-deps.mjs';

// __dirname rather than import.meta.url: Vitest hands transformed modules a virtual URL that is
// not a file: scheme, so fileURLToPath would throw here.
const script = resolve(__dirname, '../../../scripts/audit-deps.mjs');

/** Write a fixture advisory database: one directory per crate, one .md per advisory. */
function advisoryDb(entries: Array<{ crate: string; id: string; body: string }>): string {
    const root = mkdtempSync(join(tmpdir(), 'gb-rustsec-'));
    for (const entry of entries) {
        const dir = join(root, entry.crate);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `${entry.id}.md`), entry.body);
    }
    return root;
}

/** One advisory in RustSec's real shape: a fenced toml block plus a markdown title. */
function advisory(id: string, crate: string, versions: string, extra = ''): string {
    return [
        '```toml',
        '[advisory]',
        `id = "${id}"`,
        `package = "${crate}"`,
        'categories = ["denial-of-service"]',
        extra,
        '',
        '[versions]',
        versions,
        '```',
        '',
        `# ${id} test advisory`,
        '',
    ].join('\n');
}

function parse(value: string) {
    const m = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(value)!;
    return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3] ?? 0) };
}

/** Load a fixture db and return the advisory map the audit consumes. */
function advisoriesFor(db: string) {
    return loadAdvisories(db).byPackage;
}

describe('dependency audit version ranges', () => {
    it('matches comma-separated cargo requirements as a conjunction', () => {
        const v115 = parse('1.1.5');
        expect(matchesRequirement(v115, '>= 1.0, < 1.2')).toBe(true);
        expect(matchesRequirement(v115, '>= 1.2, < 2.0')).toBe(false);
        expect(matchesRequirement(v115, '< 1.2.3')).toBe(true);
        expect(matchesRequirement(v115, '= 1.1.5')).toBe(true);
    });

    it('accepts the two-component ranges RustSec actually writes', () => {
        // `>= 1.0` and `< 1.2` are shorthand for `>= 1.0.0` and `< 1.2.0`. A parser that
        // demanded three components would fail that part and report no advisory at all.
        expect(matchesRequirement(parse('1.1.5'), '>= 1.0')).toBe(true);
        expect(matchesRequirement(parse('1.1.5'), '< 1.2')).toBe(true);
        expect(matchesRequirement(parse('1.2.0'), '< 1.2')).toBe(false);
        expect(matchesRequirement(parse('0.18.5'), '>=0.20.0')).toBe(false);
    });

    it('treats a leading zero as part of the breaking surface', () => {
        expect(semverCompatible('5.4.1', '5.4.2')).toBe(true);
        expect(semverCompatible('1.0.4', '1.2.0')).toBe(true);
        expect(semverCompatible('0.18.5', '0.20.0')).toBe(false);
        expect(semverCompatible('0.37.5', '0.41.0')).toBe(false);
        expect(semverCompatible('0.18.2', '0.18.9')).toBe(true);
        expect(semverCompatible('0.0.3', '0.1.0')).toBe(false);
        // A downgrade is never "compatible" in this sense: the lock already has more.
        expect(semverCompatible('5.4.2', '5.4.1')).toBe(false);
    });
});

describe('dependency audit advisory matching', () => {
    it('reads the toml block out of a RustSec markdown file', () => {
        const parsed = parseAdvisory(advisory('RUSTSEC-2026-0001', 'acrate', 'patched = [">= 1.2.3"]'));
        expect(parsed.id).toBe('RUSTSEC-2026-0001');
        expect(parsed.package).toBe('acrate');
        expect(parsed.patched).toEqual(['>= 1.2.3']);
        expect(parsed.title).toBe('RUSTSEC-2026-0001 test advisory');
    });

    it('skips withdrawn advisories the way cargo-audit does', () => {
        const db = advisoryDb([
            { crate: 'live', id: 'RUSTSEC-2026-0002', body: advisory('RUSTSEC-2026-0002', 'live', 'patched = [">= 9.9.9"]') },
            { crate: 'gone', id: 'RUSTSEC-2020-0053', body: advisory('RUSTSEC-2020-0053', 'gone', 'patched = []', 'withdrawn = "2021-04-19"') },
        ]);
        try {
            const result = loadAdvisories(db);
            expect(result.loaded).toBe(true);
            expect(result.byPackage.has('live')).toBe(true);
            expect(result.byPackage.has('gone')).toBe(false);
        } finally {
            rmSync(db, { recursive: true, force: true });
        }
    });

    it('reports an empty or missing database as no coverage, not as a clean audit', () => {
        const empty = mkdtempSync(join(tmpdir(), 'gb-rustsec-empty-'));
        try {
            expect(loadAdvisories(empty).loaded).toBe(false);
            expect(loadAdvisories(join(empty, 'nope')).loaded).toBe(false);
            // Coverage failure outranks findings in the exit code.
            expect(auditOutcome({ cargoFindings: [], cargoCoverageOk: false, npmAudit: { ok: true, rows: [] }, npmSkipped: false }).code).toBe(2);
        } finally {
            rmSync(empty, { recursive: true, force: true });
        }
    });

    it('treats an omitted broken list as "everything except patched/unaffected"', () => {
        const db = advisoryDb([
            { crate: 'implicit', id: 'RUSTSEC-2026-0003', body: advisory('RUSTSEC-2026-0003', 'implicit', 'patched = [">= 2.0.0"]') },
        ]);
        try {
            const findings = auditCargoLock([{ name: 'implicit', version: '1.4.0' }], advisoriesFor(db));
            expect(findings).toHaveLength(1);
            expect(classifyCargo(findings, new Map())[0].actionable).toBe(false);
        } finally {
            rmSync(db, { recursive: true, force: true });
        }
    });

    it('does not report a version named by patched or unaffected', () => {
        const db = advisoryDb([
            { crate: 'fixed', id: 'RUSTSEC-2026-0004', body: advisory('RUSTSEC-2026-0004', 'fixed', 'patched = [">= 1.1.0"]') },
            { crate: 'immune', id: 'RUSTSEC-2026-0005', body: advisory('RUSTSEC-2026-0005', 'immune', 'broken = [">= 1.0.0"]\nunaffected = ["< 1.0.0"]') },
        ]);
        try {
            const advisories = advisoriesFor(db);
            expect(auditCargoLock([{ name: 'fixed', version: '1.3.2' }], advisories)).toHaveLength(0);
            expect(auditCargoLock([{ name: 'immune', version: '0.9.9' }], advisories)).toHaveLength(0);
            expect(auditCargoLock([{ name: 'fixed', version: '1.0.1' }], advisories)).toHaveLength(1);
        } finally {
            rmSync(db, { recursive: true, force: true });
        }
    });
});

describe('dependency audit reachability', () => {
    it('trusts cargo over a caret guess when cargo has resolved', () => {
        const db = advisoryDb([
            // Caret-compatible on its face, but the resolver is held below the fix by
            // something else in the graph — cargo says so, the caret rule cannot.
            { crate: 'held', id: 'RUSTSEC-2026-0009', body: advisory('RUSTSEC-2026-0009', 'held', 'patched = [">= 5.4.2"]') },
            { crate: 'moved', id: 'RUSTSEC-2026-0010', body: advisory('RUSTSEC-2026-0010', 'moved', 'patched = [">= 5.4.2"]') },
        ]);
        try {
            const findings = auditCargoLock([
                { name: 'held', version: '5.4.1' },
                { name: 'moved', version: '5.4.1' },
            ], advisoriesFor(db));
            const resolution = new Map([['moved', [{ from: '5.4.1', to: '5.4.2' }]]]);
            const classified = classifyCargo(findings, resolution);
            const byCrate = new Map(classified.map((f) => [f.source, f]));
            expect(byCrate.get('moved')!.actionable).toBe(true);
            expect(byCrate.get('held')!.actionable).toBe(false);
            expect(classified[0].basis).toBe('cargo resolution');
        } finally {
            rmSync(db, { recursive: true, force: true });
        }
    });

    it('credits only a move that starts from the version the advisory affects', () => {
        // A lockfile can hold two versions of one crate; moving the healthy one says
        // nothing about the vulnerable one.
        const db = advisoryDb([
            { crate: 'syn', id: 'RUSTSEC-2026-0011', body: advisory('RUSTSEC-2026-0011', 'syn', 'broken = ["< 1.0.110"]\npatched = [">= 1.0.110"]') },
        ]);
        try {
            const findings = auditCargoLock([{ name: 'syn', version: '1.0.109' }], advisoriesFor(db));
            expect(findings).toHaveLength(1);
            expect(classifyCargo(findings, new Map([['syn', [{ from: '2.0.40', to: '2.0.60' }]]]))[0].actionable).toBe(false);
            expect(classifyCargo(findings, new Map([['syn', [{ from: '1.0.109', to: '1.0.112' }]]]))[0].actionable).toBe(true);
        } finally {
            rmSync(db, { recursive: true, force: true });
        }
    });

    it('falls back to the caret rule and says so when cargo is unavailable', () => {
        const db = advisoryDb([
            { crate: 'near', id: 'RUSTSEC-2026-0006', body: advisory('RUSTSEC-2026-0006', 'near', 'patched = [">= 5.4.2"]') },
            { crate: 'far', id: 'RUSTSEC-2026-0007', body: advisory('RUSTSEC-2026-0007', 'far', 'patched = [">= 0.41.0"]') },
            { crate: 'stale', id: 'RUSTSEC-2026-0008', body: advisory('RUSTSEC-2026-0008', 'stale', 'patched = []') },
        ]);
        try {
            const findings = auditCargoLock([
                { name: 'near', version: '5.4.1' },
                { name: 'far', version: '0.37.5' },
                { name: 'stale', version: '1.0.4' },
            ], advisoriesFor(db));
            const classified = classifyCargo(findings, null);
            const byCrate = new Map(classified.map((f) => [f.source, f]));
            expect(byCrate.get('near')!.actionable).toBe(true);
            expect(byCrate.get('far')!.actionable).toBe(false);
            expect(byCrate.get('stale')!.actionable).toBe(false);
            expect(classified[0].basis).toBe('caret heuristic (--no-cargo)');
        } finally {
            rmSync(db, { recursive: true, force: true });
        }
    });
});
describe('dependency audit cargo output parsing', () => {
    // Captured shape of `cargo update --dry-run`: moves are interleaved with index noise,
    // and a graph change can also be an Adding, Removing, or Replacing line.
    const cargoOutput = [
        '    Updating crates.io index',
        '     Locking 3 packages to latest compatible versions',
        '      Adding serde v1.0.230',
        '    Updating event-listener v5.4.1 -> v5.4.2',
        '    Updating syn v1.0.109 -> v1.0.112',
        '    Updating syn v2.0.40 -> v2.0.60',
        '  Removing old-crate v0.1.0',
        '  Replacing foo v1.0.0 -> v2.0.0',
    ].join('\n');

    it('reads every Updating move, keeping both versions of a duplicated crate', () => {
        const moves = parseCargoUpdateOutput(cargoOutput);
        expect(moves.get('event-listener')).toEqual([{ from: '5.4.1', to: '5.4.2' }]);
        expect(moves.get('syn')).toEqual([{ from: '1.0.109', to: '1.0.112' }, { from: '2.0.40', to: '2.0.60' }]);
        expect(moves.has('foo')).toBe(false);
        expect(moves.has('old-crate')).toBe(false);
    });

    it('returns an empty map when nothing moved', () => {
        expect(parseCargoUpdateOutput('    Updating crates.io index').size).toBe(0);
    });

    it('makes a cargo that cannot resolve an incomplete audit, not a clean one', () => {
        const findings = [{ actionable: false }];
        const failed = { ok: false, absent: false, moves: null, reason: 'cargo update --dry-run failed: network' };
        expect(auditOutcome({ cargoFindings: findings, cargoCoverageOk: true, cargoResolution: failed, npmAudit: { ok: true, rows: [] }, npmSkipped: false }).code).toBe(2);
        const absent = { ok: false, absent: true, moves: null, reason: 'cargo is not installed' };
        expect(auditOutcome({ cargoFindings: findings, cargoCoverageOk: true, cargoResolution: absent, npmAudit: { ok: true, rows: [] }, npmSkipped: false }).code).toBe(2);
        expect(auditOutcome({ cargoFindings: findings, cargoCoverageOk: true, cargoResolution: { ok: true, moves: new Map() }, npmAudit: { ok: true, rows: [] }, npmSkipped: false }).code).toBe(0);
    });
});

describe('dependency audit npm fixability', () => {
    it('follows npm own answer, including the semver-major case', () => {
        // Measured shape from `npm audit --json` (npm 11): fixAvailable is true, false,
        // or { name, version, isSemVerMajor }.
        expect(npmFixable({ fixAvailable: true })).toBe(true);
        expect(npmFixable({ fixAvailable: false })).toBe(false);
        expect(npmFixable({ fixAvailable: undefined })).toBe(false);
        expect(npmFixable({ fixAvailable: { name: 'x', version: '7.1.6', isSemVerMajor: false } })).toBe(true);
        // A fix that needs a major bump is not something the lockfile takes silently.
        expect(npmFixable({ fixAvailable: { name: 'x', version: '3.0.0', isSemVerMajor: true } })).toBe(false);
        expect(npmFixable({})).toBe(false);
    });
});

describe('dependency audit npm payload validation', () => {
    it('accepts the shape npm actually returns', () => {
        const payload = JSON.stringify({
            auditReportVersion: 2,
            vulnerabilities: {
                'postcss-selector-parser': {
                    name: 'postcss-selector-parser',
                    severity: 'moderate',
                    via: [{ title: 'Quadratic complexity', url: 'https://github.com/advisories/GHSA-rj75-hqrm-r3gf', severity: 'moderate' }],
                    fixAvailable: { name: 'postcss-selector-parser', version: '7.1.6', isSemVerMajor: false },
                },
            },
            metadata: { vulnerabilities: { moderate: 1, total: 1 } },
        });
        const parsed = parseNpmAuditReport(payload);
        expect(parsed.ok).toBe(true);
        expect(parsed.rows).toHaveLength(1);
        expect(parsed.rows[0].fixable).toBe(true);
        expect(parsed.rows[0].fixVersion).toBe('7.1.6');
    });

    it('rejects an error payload rather than reading it as a clean audit', () => {
        const parsed = parseNpmAuditReport(JSON.stringify({ error: { code: 1, message: '404 Not Found: https://registry.npmjs.org/-/npm/v1/security/audits/quick' } }));
        expect(parsed.ok).toBe(false);
        expect(parsed.rows).toHaveLength(0);
        expect(parsed.note).toContain('404 Not Found');
        expect(auditOutcome({ cargoFindings: [], cargoCoverageOk: true, cargoResolution: { ok: true, moves: new Map() }, npmAudit: parsed, npmSkipped: false }).code).toBe(2);
    });

    it('rejects a payload that is not an audit report at all', () => {
        expect(parseNpmAuditReport('not json at all').ok).toBe(false);
        expect(parseNpmAuditReport('[]').ok).toBe(false);
        expect(parseNpmAuditReport(JSON.stringify({ auditReportVersion: 2 })).ok).toBe(false);
        // An empty vulnerabilities map is a real clean result, and only that is.
        const clean = parseNpmAuditReport(JSON.stringify({ vulnerabilities: {}, metadata: { vulnerabilities: { total: 0 } } }));
        expect(clean.ok).toBe(true);
        expect(clean.rows).toHaveLength(0);
    });
});

describe('dependency audit lockfile parsing', () => {
    it('reads name/version pairs out of a Cargo.lock', () => {
        const lock = [
            'version = 3',
            '',
            '[[package]]',
            'name = "event-listener"',
            'version = "5.4.1"',
            '',
            '[[package]]',
            'name = "serde"',
            'version = "1.0.229"',
        ].join('\n');
        expect(parseCargoLock(lock)).toEqual([
            { name: 'event-listener', version: '5.4.1' },
            { name: 'serde', version: '1.0.229' },
        ]);
    });

    it('reads direct dependencies out of Cargo.toml, skipping commented lines', () => {
        const manifest = [
            '[build-dependencies]',
            'tauri-build = { version = "2", features = [] }',
            '',
            '[dependencies]',
            'tauri = { version = "2", features = ["image-png"] }',
            '# tauri-plugin-updater = "2"',
            'tauri-plugin-opener = "2"',
            '',
            '[dev-dependencies]',
            'unused = "9"',
        ].join('\n');
        const deps = parseCargoManifest(manifest);
        expect(deps.map((d) => d.name)).toEqual(['tauri-build', 'tauri', 'tauri-plugin-opener']);
        expect(deps.find((d) => d.name === 'tauri')!.requirement).toBe('2');
    });
});

describe('dependency audit exit codes', () => {
    const clean = { cargoFindings: [], cargoCoverageOk: true, npmAudit: { ok: true, rows: [] }, npmSkipped: false };

    it('is 0 when nothing actionable is present', () => {
        expect(auditOutcome(clean).code).toBe(0);
    });

    it('is 1 when a finding is actionable', () => {
        expect(auditOutcome({ ...clean, cargoFindings: [{ actionable: true }] }).code).toBe(1);
    });

    it('is 1 when npm reports a fix it could apply', () => {
        expect(auditOutcome({ ...clean, npmAudit: { ok: true, rows: [{ fixable: true }] } }).code).toBe(1);
    });

    it('is 2 rather than 0 when the audit could not see everything', () => {
        expect(auditOutcome({ ...clean, cargoCoverageOk: false }).code).toBe(2);
        expect(auditOutcome({ ...clean, npmAudit: { ok: false, rows: [], note: 'npm audit returned no parseable JSON' } }).code).toBe(2);
        // An explicit skip is intent, not failure.
        expect(auditOutcome({ ...clean, npmAudit: { ok: false, rows: [] }, npmSkipped: true }).code).toBe(0);
    });
});

describe('dependency audit as a command', () => {
    /** Run the script against fixture lock and advisory db; npm audit is environmental, so skip it. */
    function run(lock: string, db: string, extra: string[] = []): { status: number | null; stdout: string } {
        const result = spawnSync(process.execPath, [script, '--lock', lock, '--advisory-db', db, '--skip-npm', '--no-cargo', ...extra], { encoding: 'utf8' });
        return { status: result.status, stdout: result.stdout };
    }

    it('fails when a locked crate has a fix the manifest could reach', () => {
        const db = advisoryDb([
            { crate: 'event-listener', id: 'RUSTSEC-2026-0221', body: advisory('RUSTSEC-2026-0221', 'event-listener', 'patched = [">= 5.4.2"]') },
        ]);
        const lock = join(mkdtempSync(join(tmpdir(), 'gb-audit-lock-')), 'Cargo.lock');
        writeFileSync(lock, '[[package]]\nname = "event-listener"\nversion = "5.4.1"\n');
        try {
            const { status, stdout } = run(lock, db);
            expect(status).toBe(1);
            expect(stdout).toContain('1 actionable Rust finding');
            expect(stdout).toContain('RUSTSEC-2026-0221');
            expect(stdout).toContain('caret heuristic');
        } finally {
            rmSync(db, { recursive: true, force: true });
            rmSync(lock, { force: true });
        }
    });

    it('passes once the same crate is locked at the patched version', () => {
        const db = advisoryDb([
            { crate: 'event-listener', id: 'RUSTSEC-2026-0221', body: advisory('RUSTSEC-2026-0221', 'event-listener', 'patched = [">= 5.4.2"]') },
        ]);
        const lock = join(mkdtempSync(join(tmpdir(), 'gb-audit-lock-')), 'Cargo.lock');
        writeFileSync(lock, '[[package]]\nname = "event-listener"\nversion = "5.4.2"\n');
        try {
            const { status, stdout } = run(lock, db);
            expect(status).toBe(0);
            expect(stdout).toContain('0 actionable Rust finding');
        } finally {
            rmSync(db, { recursive: true, force: true });
            rmSync(lock, { force: true });
        }
    });

    it('exits 2 rather than reporting a clean audit when the advisory database is missing', () => {
        const lock = join(mkdtempSync(join(tmpdir(), 'gb-audit-lock-')), 'Cargo.lock');
        writeFileSync(lock, '[[package]]\nname = "event-listener"\nversion = "5.4.1"\n');
        try {
            const { status, stdout } = run(lock, join(lock, 'no-such-advisory-db'));
            expect(status).toBe(2);
            expect(stdout).toContain('INCOMPLETE');
        } finally {
            rmSync(lock, { force: true });
        }
    });

    /**
     * Run the audit with a stubbed cargo on PATH.
     *
     * These cover the orchestration — a resolution that fails while printing a usable move,
     * and a toolchain that is absent — without needing cargo or the crates.io index. The real
     * resolver path is exercised by hand instead, as the commit note says.
     */
    function runWithStubCargo(scriptBody: string | null, lock: string, db: string): { status: number | null; stdout: string } {
        const binDir = mkdtempSync(join(tmpdir(), 'gb-cargo-stub-'));
        if (scriptBody) {
            writeFileSync(join(binDir, 'cargo'), scriptBody, { mode: 0o755 });
        }
        try {
            const result = spawnSync(process.execPath, [script, '--lock', lock, '--advisory-db', db, '--skip-npm'], {
                encoding: 'utf8',
                env: { PATH: binDir },
            });
            return { status: result.status, stdout: result.stdout };
        } finally {
            rmSync(binDir, { recursive: true, force: true });
        }
    }

    const stubAdvisoryDb = () => advisoryDb([
        { crate: 'event-listener', id: 'RUSTSEC-2026-0221', body: advisory('RUSTSEC-2026-0221', 'event-listener', 'patched = [">= 5.4.2"]') },
    ]);
    const stubLock = () => {
        const lock = join(mkdtempSync(join(tmpdir(), 'gb-audit-lock-')), 'Cargo.lock');
        writeFileSync(lock, '[[package]]\nname = "event-listener"\nversion = "5.4.1"\n');
        return lock;
    };

    it('reports itself incomplete when cargo fails, even though it printed a usable move', () => {
        const db = stubAdvisoryDb();
        const lock = stubLock();
        try {
            const { status, stdout } = runWithStubCargo([
                '#!/bin/sh',
                'if [ "$1" = "--version" ]; then echo cargo-stub; exit 0; fi',
                'echo "    Updating event-listener v5.4.1 -> v5.4.2" >&2',
                'echo "error: failed to select a version for the requirement" >&2',
                'exit 101',
            ].join('\n'), lock, db);
            expect(status).toBe(2);
            expect(stdout).toContain('NOT MEASURED');
            expect(stdout).toContain('INCOMPLETE');
            // The partial move must not be credited as an actionable finding.
            expect(stdout).toContain('0 actionable Rust finding');
        } finally {
            rmSync(db, { recursive: true, force: true });
            rmSync(lock, { force: true });
        }
    });

    it('reports itself incomplete when cargo is not installed at all', () => {
        const db = stubAdvisoryDb();
        const lock = stubLock();
        try {
            const { status, stdout } = runWithStubCargo(null, lock, db);
            expect(status).toBe(2);
            expect(stdout).toContain('cargo is not installed');
            expect(stdout).toContain('INCOMPLETE');
        } finally {
            rmSync(db, { recursive: true, force: true });
            rmSync(lock, { force: true });
        }
    });

    it('credits a move a successful cargo resolution reports', () => {
        const db = stubAdvisoryDb();
        const lock = stubLock();
        try {
            const { status, stdout } = runWithStubCargo([
                '#!/bin/sh',
                'if [ "$1" = "--version" ]; then echo cargo-stub; exit 0; fi',
                'echo "    Updating event-listener v5.4.1 -> v5.4.2" >&2',
                'exit 0',
            ].join('\n'), lock, db);
            expect(status).toBe(1);
            expect(stdout).toContain('1 actionable Rust finding');
            expect(stdout).toContain('cargo resolution');
        } finally {
            rmSync(db, { recursive: true, force: true });
            rmSync(lock, { force: true });
        }
    });
});
