#!/usr/bin/env node
/**
 * Summarize an interleaved paired A/B run set.
 *
 * Usage: node scripts/perf/summarize.mjs <runs-dir>
 *
 * Reads <runs-dir>/rep<N>/{cand,base}/{unit-results.txt,hashes.txt,stderr.txt,meta.txt}
 * and prints, per stage:
 *   - paired per-rep comparison (cand vs base measured in the same rep)
 *   - win rate (how many pairs the candidate won)
 *   - median ratio across pairs
 * plus the output-identity gate (every arm's snapshot hashes must match) and
 * the /usr/bin/time -l counters (real/user/sys, page reclaims, peak RSS).
 *
 * All numbers come from the captured artifacts, not from notes.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const root = process.argv[2];
if (!root) {
    console.error('usage: summarize.mjs <runs-dir>');
    process.exit(1);
}

const reps = readdirSync(root)
    .filter((d) => /^rep\d+$/.test(d))
    .sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)));

function read(p) {
    return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

/** Parse unit-results.txt into { stageKey: medianMs } plus the raw reps list. */
function parseResults(text) {
    const out = new Map();
    if (!text) return out;
    for (const line of text.split('\n')) {
        // Stage keys are the first token of a bench result line: `A inactive`,
        // `H history 5000 lines`, `S100-bg`, `P500-sort`, `R-bg` … Any line whose
        // key starts with an uppercase letter and carries `median <n>ms` is a
        // stage, so a new bench adds stages without editing this parser.
        const m = line.match(/^([A-Z][A-Za-z0-9-]*(?: [a-z][A-Za-z0-9-]*)?)\b.*?median\s+([\d.]+)ms/);
        if (m) { out.set(m[1], { median: Number(m[2]), raw: line }); continue; }
        // E2E arms report the median of several in-page floods per run.
        const e2e = line.match(/\[prodflood\] renderMedian=(\d+)ms/)
            ?? line.match(/\[prodbadge\] elapsedMedian=(\d+)ms/);
        if (e2e) {
            out.set('E2E production flood', { median: Number(e2e[1]), raw: line });
            // ScriptDuration is the browser's own main-thread JavaScript tally:
            // the metric that can see store-pipeline work wall time cannot.
            const script = line.match(/scriptMs=(\d+)/) ?? line.match(/scriptMedian=(\d+)ms/);
            if (script) out.set('E2E main-thread JS', { median: Number(script[1]), raw: line });
        }
    }
    return out;
}

/** Parse the macOS `/usr/bin/time -l` block into a counter set. */
function parseCounters(stderr) {
    if (!stderr) return null;
    const grab = (re) => {
        const m = stderr.match(re);
        return m ? Number(m[1]) : null;
    };
    return {
        real: grab(/([\d.]+)\s+real/),
        user: grab(/([\d.]+)\s+user/),
        sys: grab(/([\d.]+)\s+sys/),
        maxRSS: grab(/(\d+)\s+maximum resident set size/),
        peakFootprint: grab(/(\d+)\s+peak memory footprint/),
        pageReclaims: grab(/(\d+)\s+page reclaims/),
        hardPageFaults: grab(/(\d+)\s+page faults/),
        voluntaryCS: grab(/(\d+)\s+voluntary context switches/),
        involuntaryCS: grab(/(\d+)\s+involuntary context switches/),
        instructionsRetired: grab(/(\d+)\s+instructions retired/),
        cyclesElapsed: grab(/(\d+)\s+cycles elapsed/),
    };
}

const arms = {};
const incomplete = [];
for (const rep of reps) {
    for (const arm of ['cand', 'base']) {
        const dir = path.join(root, rep, arm);
        if (!existsSync(dir)) continue;
        const results = parseResults(read(path.join(dir, 'unit-results.txt')));
        const hashText = read(path.join(dir, 'hashes.txt')) ?? '';
        const meta = read(path.join(dir, 'meta.txt')) ?? '';
        const counters = parseCounters(read(path.join(dir, 'stderr.txt')));
        // A wedged arm produces a directory but no results and no hashes. It
        // must not be counted as a run, and above all must not be counted as a
        // differing output hash — that would read as an output change.
        if (results.size === 0 || hashText.trim() === '') {
            incomplete.push(`${rep}/${arm}`);
            continue;
        }
        (arms[arm] ??= []).push({ arm, rep, results, hashText, meta, counters });
    }
}

const stages = [...(arms.cand?.[0]?.results.keys() ?? [])];
for (const a of arms.base ?? []) for (const k of a.results.keys()) if (!stages.includes(k)) stages.push(k);

console.log(`A/B summary: ${root}`);
console.log(`reps: ${reps.length}\n`);

for (const stage of stages) {
    const pairs = [];
    for (let i = 0; i < (arms.cand?.length ?? 0); i++) {
        const c = arms.cand[i].results.get(stage);
        const b = arms.base?.[i]?.results.get(stage);
        if (!c || !b) continue;
        pairs.push({ rep: arms.cand[i].rep, cand: c.median, base: b.median });
    }
    if (!pairs.length) continue;

    const ratios = pairs.map((p) => p.cand / p.base);
    const wins = pairs.filter((p) => p.cand < p.base).length;
    const sorted = [...ratios].sort((a, b) => a - b);
    const medianRatio = sorted[Math.floor(sorted.length / 2)];
    const mean = ratios.reduce((s, r) => s + r, 0) / ratios.length;

    console.log(`== ${stage} ==`);
    for (const p of pairs) {
        const flag = p.cand < p.base ? 'win ' : p.cand > p.base ? 'lose' : 'tie ';
        console.log(
            `  ${p.rep}: cand ${p.cand.toFixed(1)}ms  base ${p.base.toFixed(1)}ms  ` +
            `ratio ${(p.cand / p.base).toFixed(3)}  ${flag}`,
        );
    }
    console.log(
        `  → win rate ${wins}/${pairs.length}, median ratio ${medianRatio.toFixed(3)} ` +
        `(mean ${mean.toFixed(3)}) → speedup ${(1 / medianRatio).toFixed(3)}x\n`,
    );
}

console.log('== output identity gate ==');
if (incomplete.length) {
    console.log(`  skipped ${incomplete.length} incomplete run(s): ${incomplete.join(', ')}`);
}
const hashSets = [];
for (const arm of ['cand', 'base']) {
    for (const run of arms[arm] ?? []) {
        const set = (run.hashText ?? '')
            .split('\n')
            .map((l) => l.trim().split(/\s+/)[0])
            .filter(Boolean)
            .sort()
            .join(',');
        hashSets.push({ arm: run.arm ?? arm, rep: run.rep, set });
    }
}
if (hashSets.length === 0) {
    console.log('  !! no complete runs to compare — gate is inconclusive');
} else {
const distinct = new Set(hashSets.map((h) => h.set));
if (distinct.size === 1) {
    console.log(`  ALL ${hashSets.length} runs produced identical snapshot hashes ✓`);
    for (const line of (hashSets[0]?.set ?? '').split(',')) console.log(`  ${line}`);
} else {
    console.log(`  !! ${distinct.size} DISTINCT hash sets across ${hashSets.length} runs — OUTPUT DIFFERS`);
    for (const h of hashSets) console.log(`  ${h.arm} ${h.rep}: ${h.set}`);
}
}

// ---- Counters ----
console.log('\n== counters (median across reps) ==');
const MB = (v) => (v === null ? 'n/a' : (v / 1048576).toFixed(0) + 'MB');
const NUM = (v) => (v === null ? 'n/a' : v.toLocaleString('en-US'));
for (const arm of ['cand', 'base']) {
    const runs = arms[arm] ?? [];
    if (!runs.length) continue;
    const med = (pick) => {
        const vals = runs.map(pick).filter((v) => v !== null).sort((a, b) => a - b);
        return vals.length ? vals[Math.floor(vals.length / 2)] : null;
    };
    console.log(`  ${arm}:`);
    console.log(
        `    real ${med((r) => r.counters?.real)}s  user ${med((r) => r.counters?.user)}s  ` +
        `sys ${med((r) => r.counters?.sys)}s`,
    );
    console.log(
        `    instructions retired ${NUM(med((r) => r.counters?.instructionsRetired))}  ` +
        `cycles ${NUM(med((r) => r.counters?.cyclesElapsed))}`,
    );
    console.log(
        `    page reclaims ${NUM(med((r) => r.counters?.pageReclaims))}  ` +
        `hard page faults ${NUM(med((r) => r.counters?.hardPageFaults))}`,
    );
    console.log(
        `    max RSS ${MB(med((r) => r.counters?.maxRSS))}  peak footprint ${MB(med((r) => r.counters?.peakFootprint))}  ` +
        `volCS ${NUM(med((r) => r.counters?.voluntaryCS))}  involCS ${NUM(med((r) => r.counters?.involuntaryCS))}`,
    );
}

// ---- Load during the batch ----
console.log('\n== machine load per run ==');
for (const arm of ['cand', 'base']) {
    for (const run of arms[arm] ?? []) {
        const before = run.meta.match(/load_before:\s*(.+)/)?.[1]?.trim();
        const after = run.meta.match(/load_after:\s*(.+)/)?.[1]?.trim();
        console.log(`  ${run.arm} ${run.rep}: before ${before} | after ${after}`);
    }
}
