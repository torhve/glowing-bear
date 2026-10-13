#!/usr/bin/env node
/**
 * Attribute a CDP CPU profile by *caller*, not just by callee.
 *
 * analyze-cpuprofile.mjs answers "which function held the samples". That is the
 * wrong question when half the samples are `(program)` — unattributed native
 * executable time. `(program)` has no name, so a self-time table cannot say who
 * asked the browser to do it, and "48% is the browser's own work" is a statement
 * with no owner.
 *
 * This walks each sample's node up to its nearest JavaScript ancestor and charges
 * the sample to that ancestor's subtree.
 *
 * MEASURED RESULT, recorded so nobody re-derives it: on a production-build flood
 * profile this attributes 83.6% of samples to `(root)`, because Chromium hangs
 * `(program)`, `(idle)` and `(garbage collector)` directly off the root node
 * rather than under the JavaScript that triggered them. The tool is correct about
 * the profile it is given and the profile does not contain the answer — caller
 * attribution of native render time is not available from a CDP CPU profile. Use
 * the CDP Performance buckets (LayoutDuration, RecalcStyleDuration, ScriptDuration,
 * TaskDuration) or a counter harness for that question.
 *
 * Usage: node analyze-cpuprofile-tree.mjs <cpu-profile.json>
 */

import fs from 'node:fs';

const file = process.argv[2];
if (!file) {
    console.error('usage: node analyze-cpuprofile-tree.mjs <cpu-profile.json>');
    process.exit(1);
}

const prof = JSON.parse(fs.readFileSync(file, 'utf8'));
const nodes = prof.nodeTable ?? prof.nodes ?? [];
const samples = prof.samples ?? [];

const byId = new Map(nodes.map((n) => [n.id, n]));
// Parent links: nodeTable children are callees, so invert them.
const parent = new Map();
for (const n of nodes) {
    for (const childId of n.children ?? []) {
        if (!parent.has(childId)) parent.set(childId, n.id);
    }
}

const NATIVE = new Set(['(program)', '(garbage collector)', '(idle)']);
const isNative = (cf) => !cf || NATIVE.has(cf.functionName || '(anon)');

/** Nearest JavaScript ancestor of a node, or null when the whole stack is native. */
function jsAncestor(node) {
    let current = node;
    while (current) {
        if (!isNative(current.callFrame)) return current;
        const parentId = parent.get(current.id);
        current = parentId === undefined ? null : byId.get(parentId);
    }
    return null;
}

const shortName = (cf) => {
    if (!cf) return '(none)';
    const url = cf.url ? cf.url.split('/').slice(-1)[0] : '';
    const fn = cf.functionName || '(anon)';
    return url ? `${fn} @ ${url}:${cf.lineNumber}` : fn;
};

const charged = new Map(); // nearest JS ancestor key -> sample count
const nativeDirect = new Map(); // native frame with no JS ancestor at all
let total = 0;
for (const id of samples) {
    total++;
    const node = byId.get(id);
    if (!node) continue;
    const owner = jsAncestor(node);
    if (owner) {
        const key = shortName(owner.callFrame);
        charged.set(key, (charged.get(key) ?? 0) + 1);
    } else {
        const key = node.callFrame?.functionName ?? '(anon)';
        nativeDirect.set(key, (nativeDirect.get(key) ?? 0) + 1);
    }
}

// Also: what native work sits under each JS owner? This is the part that says
// "this app call is what makes layout/paint happen".
const nativeUnder = new Map(); // js owner -> Map(native name -> count)
for (const id of samples) {
    const node = byId.get(id);
    if (!node || !isNative(node.callFrame)) continue;
    const owner = jsAncestor(parent.get(node.id) === undefined ? null : byId.get(parent.get(node.id)));
    if (!owner) continue;
    const ownerKey = shortName(owner.callFrame);
    const nativeName = node.callFrame.functionName ?? '(anon)';
    const inner = nativeUnder.get(ownerKey) ?? new Map();
    inner.set(nativeName, (inner.get(nativeName) ?? 0) + 1);
    nativeUnder.set(ownerKey, inner);
}

const sortDesc = (map) => [...map.entries()].sort((a, b) => b[1] - a[1]);

console.log(`total samples: ${total}`);
console.log('\n== samples charged to the nearest JavaScript caller ==');
for (const [key, count] of sortDesc(charged).slice(0, 25)) {
    console.log(`${((count / total) * 100).toFixed(1).padStart(5)}%  ${String(count).padStart(6)}  ${key}`);
}
console.log('\n== native samples with no JavaScript ancestor ==');
for (const [key, count] of sortDesc(nativeDirect).slice(0, 10)) {
    console.log(`${((count / total) * 100).toFixed(1).padStart(5)}%  ${String(count).padStart(6)}  ${key}`);
}
console.log('\n== native work underneath each JavaScript caller ==');
const owners = sortDesc(charged).slice(0, 12);
for (const [ownerKey] of owners) {
    const inner = sortDesc(nativeUnder.get(ownerKey) ?? new Map()).slice(0, 5);
    if (inner.length === 0) continue;
    console.log(`  ${ownerKey}`);
    for (const [nativeName, count] of inner) {
        console.log(`      ${nativeName}  ${count}`);
    }
}
