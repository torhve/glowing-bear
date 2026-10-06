#!/usr/bin/env node
/**
 * Summarize a V8 .cpuprofile: self time and total time per function, and
 * (with --lines <fn substring>) self time per source line inside one function.
 *
 * Line attribution matters because a function's self time is usually one or two
 * statements, not the whole body — and V8 attributes inlined callees to the
 * caller, so "self" here means "everything attributed to that frame".
 *
 * Usage:
 *   node scripts/perf/cpuprofile.mjs <profile.cpuprofile> [--min 1.0] [--lines <name>]
 */
import fs from 'node:fs';

const file = process.argv[2];
if (!file) {
    console.error('usage: cpuprofile.mjs <profile> [--min <pct>] [--lines <fn substring>]');
    process.exit(1);
}
const minIdx = process.argv.indexOf('--min');
const minPct = minIdx > 0 ? Number(process.argv[minIdx + 1]) : 1.0;
const linesIdx = process.argv.indexOf('--lines');
const linesFor = linesIdx > 0 ? process.argv[linesIdx + 1] : null;

const p = JSON.parse(fs.readFileSync(file, 'utf8'));
const nodes = p.nodes;
const samples = p.samples;

const selfCount = new Map();
for (const n of nodes) selfCount.set(n.id, n.hitCount ?? 0);

const byId = new Map(nodes.map((n) => [n.id, n]));
const parentOf = new Map(nodes.map((n) => [n.id, n.parent ? byId.get(n.parent) : undefined]));

const total = new Map();
for (const s of samples) {
    let cur = byId.get(s);
    const seen = new Set();
    while (cur) {
        if (seen.has(cur.id)) break;
        seen.add(cur.id);
        const key = `${cur.callFrame.functionName || '(anonymous)'} @ ${short(cur.callFrame.url)}:${cur.callFrame.lineNumber}:${cur.callFrame.columnNumber}`;
        total.set(key, (total.get(key) ?? 0) + 1);
        cur = parentOf.get(cur.id);
    }
}

function short(url) {
    return String(url ?? '').replace(/^file:\/\//, '').replace(/^.*\/glowing-bear\//, '');
}

const selfAgg = new Map();
for (const n of nodes) {
    if (!n.hitCount) continue;
    const key = `${n.callFrame.functionName || '(anonymous)'} @ ${short(n.callFrame.url)}:${n.callFrame.lineNumber}:${n.callFrame.columnNumber}`;
    selfAgg.set(key, (selfAgg.get(key) ?? 0) + n.hitCount);
}

const totalSamples = samples.length;
const top = [...selfAgg.entries()].sort((a, b) => b[1] - a[1]);
console.log(`\n== SELF time (${totalSamples} samples) ==`);
for (const [k, v] of top) {
    const pct = (v / totalSamples) * 100;
    if (pct < minPct) break;
    console.log(`${pct.toFixed(2).padStart(6)}%  ${String(v).padStart(6)}  ${k}`);
}

const topTotal = [...total.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
console.log(`\n== TOTAL time (top 25) ==`);
for (const [k, v] of topTotal) {
    console.log(`${((v / totalSamples) * 100).toFixed(2).padStart(6)}%  ${String(v).padStart(6)}  ${k}`);
}

if (linesFor) {
    // Per-line self attribution inside one function: node.callFrame.position is a
    // byte offset into the source, so convert it to a line number.
    const sourceCache = new Map();
    const byLine = new Map();
    let fnTotal = 0;
    for (const n of nodes) {
        if (!n.hitCount) continue;
        const name = n.callFrame.functionName || '(anonymous)';
        if (!name.includes(linesFor)) continue;
        const url = String(n.callFrame.url ?? '').replace(/^file:\/\//, '');
        if (!url || !fs.existsSync(url)) continue;
        if (!sourceCache.has(url)) sourceCache.set(url, fs.readFileSync(url, 'utf8'));
        const src = sourceCache.get(url);
        const pos = n.callFrame.position ?? -1;
        let line = n.callFrame.lineNumber ?? -1;
        if (pos >= 0 && pos < src.length) {
            line = src.slice(0, pos).split('\n').length;
        }
        const key = `${url.split('/').pop()}:${line}`;
        byLine.set(key, (byLine.get(key) ?? 0) + n.hitCount);
        fnTotal += n.hitCount;
    }
    const src = linesFor ? sourceCache.values().next().value : undefined;
    console.log(`\n== SELF per line inside "${linesFor}" (${fnTotal} samples) ==`);
    for (const [k, v] of [...byLine.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
        const lineNo = Number(k.split(':')[1]);
        const text = src ? (src.split('\n')[lineNo - 1] ?? '').trim().slice(0, 78) : '';
        console.log(`${((v / totalSamples) * 100).toFixed(2).padStart(6)}%  ${String(v).padStart(5)}  ${k.padEnd(16)} ${text}`);
    }
}
