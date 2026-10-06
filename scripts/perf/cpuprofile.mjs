#!/usr/bin/env node
/**
 * Summarize a V8 .cpuprofile.
 *
 * Usage: node scripts/perf/cpuprofile.mjs <file.cpuprofile> [--min 0.1] [--filter <substring>] [--flat]
 *
 * Prints self-time (exclusive) and total-time (inclusive) per call frame, as a
 * percentage of profile samples. Frames are keyed by url:line:col:name so the
 * same function appearing in several bundles is not silently merged.
 */
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const minIdx = args.indexOf('--min');
const minPct = minIdx >= 0 ? Number(args[minIdx + 1]) : 0.1;
const filterIdx = args.indexOf('--filter');
const filter = filterIdx >= 0 ? args[filterIdx + 1] : null;

if (!file) {
    console.error('usage: cpuprofile.mjs <file.cpuprofile> [--min pct] [--filter substring]');
    process.exit(1);
}

const prof = JSON.parse(readFileSync(file, 'utf8'));
const nodes = prof.nodes;
const byId = new Map(nodes.map((n) => [n.id, n]));

// samples: array of node ids, one per sampling interval.
const sampleCounts = new Map();
for (const id of prof.samples) sampleCounts.set(id, (sampleCounts.get(id) ?? 0) + 1);
const totalSamples = prof.samples.length;

// Self time = samples landing exactly on that node.
const self = new Map();
for (const [id, c] of sampleCounts) self.set(id, c);

// Total time = samples in the subtree rooted at that node.
const children = new Map();
for (const n of nodes) {
    if (n.children) {
        for (const c of n.children) {
            const arr = children.get(n.id);
            if (arr) arr.push(c);
            else children.set(n.id, [c]);
        }
    }
}
const total = new Map();
function computeTotal(id) {
    if (total.has(id)) return total.get(id);
    let sum = self.get(id) ?? 0;
    for (const c of children.get(id) ?? []) sum += computeTotal(c);
    total.set(id, sum);
    return sum;
}
// Roots: nodes never listed as a child.
const childIds = new Set();
for (const [, arr] of children) for (const c of arr) childIds.add(c);
for (const n of nodes) if (!childIds.has(n.id)) computeTotal(n.id);

function label(n) {
    const cf = n.callFrame;
    const url = (cf.url ?? '').replace(/^file:\/\//, '');
    const short = url.length > 60 ? '…' + url.slice(-57) : url;
    return `${cf.functionName || '(anonymous)'}  ${short}:${cf.lineNumber ?? 0}:${cf.columnNumber ?? 0}`;
}

function report(title, map) {
    const rows = [];
    for (const [id, count] of map) {
        const pct = (100 * count) / totalSamples;
        if (pct < minPct) continue;
        const n = byId.get(id);
        if (!n) continue;
        const l = label(n);
        if (filter && !l.includes(filter)) continue;
        rows.push([pct, count, l]);
    }
    rows.sort((a, b) => b[0] - a[0]);
    console.log(`\n== ${title} (${totalSamples} samples) ==`);
    for (const [pct, count, l] of rows) {
        console.log(`${pct.toFixed(2).padStart(6)}%  ${String(count).padStart(7)}  ${l}`);
    }
}

report('SELF time', self, );
report('TOTAL time', total);
