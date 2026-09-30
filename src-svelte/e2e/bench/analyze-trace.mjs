#!/usr/bin/env node
/**
 * Analyze a Playwright trace (.trace zip): aggregate CPU profile samples by
 * function and print the hottest frames.
 *
 * Usage: node analyze-trace.mjs <path/to/flood.trace>
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const tracePath = process.argv[2];
if (!tracePath) {
    console.error('usage: node analyze-trace.mjs <trace.zip>');
    process.exit(1);
}
const outDir = '/tmp/gb-perf/trace-extract';
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
execSync(`unzip -o -q ${JSON.stringify(tracePath)} -d ${outDir}`);

const files = fs.readdirSync(outDir).filter((f) => f.endsWith('.cpuprofile'));
const nodeById = new Map();
const selfSamples = new Map(); // node id -> sample count
let totalSamples = 0;

for (const f of files) {
    const prof = JSON.parse(fs.readFileSync(path.join(outDir, f), 'utf8'));
    for (const n of prof.nodeTable ?? prof.nodes ?? []) nodeById.set(n.id, n.callFrame);
    for (const id of prof.samples ?? []) {
        totalSamples++;
        selfSamples.set(id, (selfSamples.get(id) || 0) + 1);
    }
}

const byName = new Map();
for (const [id, count] of selfSamples) {
    const n = nodeById.get(id);
    const frame = n?.callFrame;
    const name = frame
        ? `${frame.functionName || '(anonymous)'} @ ${frame.url.split('/').slice(-2).join('/')}:${frame.lineNumber}`
        : '(root)';
    byName.set(name, (byName.get(name) || 0) + count);
}

const top = [...byName.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40);
console.log(`total samples: ${totalSamples}, unique functions: ${byName.size}`);
for (const [name, count] of top) {
    const pct = ((100 * count) / totalSamples).toFixed(1);
    console.log(`${pct}%  ${count.toString().padStart(6)}  ${name}`);
}
