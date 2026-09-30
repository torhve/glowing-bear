#!/usr/bin/env node
/**
 * Aggregate a CDP CPU profile (sampled) by function.
 *
 * Usage: node analyze-cpuprofile.mjs <cpu-profile.json>
 */
import fs from 'node:fs';

const file = process.argv[2];
if (!file) {
    console.error('usage: node analyze-cpuprofile.mjs <cpu-profile.json>');
    process.exit(1);
}
const prof = JSON.parse(fs.readFileSync(file, 'utf8'));
const nodes = prof.nodeTable ?? prof.nodes ?? [];
const idToNode = new Map(nodes.map((n) => [n.id, n]));
const samples = prof.samples ?? [];

const selfCount = new Map(); // function key -> sample count
let total = 0;
for (const id of samples) {
    total++;
    const n = idToNode.get(id);
    const cf = n?.callFrame;
    const key = cf
        ? `${cf.functionName || '(anon)'} @ ${cf.url ? cf.url.split('/').slice(-2).join('/') : ''}:${cf.lineNumber}`
        : '(idle)';
    selfCount.set(key, (selfCount.get(key) || 0) + 1);
}

// Also aggregate by source file (excluding <anonymous> / builtins)
const byFile = new Map();
for (const [key, count] of selfCount) {
    const m = key.match(/ @ ([^:]+):/);
    const fname = m ? m[1].split('/').pop() : '(none)';
    byFile.set(fname, (byFile.get(fname) || 0) + count);
}

console.log(`total samples: ${total}`);
console.log('\n== top functions (self time) ==');
[...selfCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .forEach(([name, count]) =>
        console.log(`${((100 * count) / total).toFixed(1).padStart(5)}%  ${String(count).padStart(6)}  ${name}`),
    );
console.log('\n== by source file ==');
[...byFile.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .forEach(([name, count]) =>
        console.log(`${((100 * count) / total).toFixed(1).padStart(5)}%  ${String(count).padStart(6)}  ${name}`),
    );
