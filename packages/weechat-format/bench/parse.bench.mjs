#!/usr/bin/env node
/**
 * Throughput benchmark for the built artifact.
 *
 * Run with: npm run bench   (builds dist first)
 *
 * Vitest 5 removed its benchmark runner, so this is a small self-contained
 * harness: fixed-duration sampling, median of samples, and a scaling guard that
 * fails the run if parsing grows worse than linearly with line length. Message
 * rendering parses every line on every model update, so a change that makes
 * parsing quadratic in line length, or that allocates per character, must not
 * land silently.
 *
 * Exits non-zero when the scaling guard fails, so it can gate CI.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

const distEntry = path.resolve(import.meta.dirname, '../dist/index.js');
if (!existsSync(distEntry)) {
    console.error('bench: dist/index.js is missing — run npm run build first');
    process.exit(1);
}

const { parseWeeChatStyle, parseWeeChatText } = await import(distEntry);

const C = '\u0019';

const plain = 'a fairly long ordinary chat message with no formatting controls at all';
const chatLine = `${C}0212:34 ${C}14nick${C}28: ${C}F03red ${C}B04bg ${C}\u001cplain tail`;
const formattedLine = [
    `${C}0212:34`,
    `${C}14nick`,
    `${C}28:`,
    `${C}F*03bold red`,
    `${C}F|04kept bold lightred`,
    `${C}B@00123bg`,
    `${C}*@00012~@00034both`,
    `${C}\u001a\u0001underlined bold`,
    `${C}\u001b\u0001not bold`,
    `${C}Eemphasised${C}E`,
    `${C}\u001cback to chat colors`,
].join('');
const malformedLine = `${C}F0x${C}*03,@12${C}F@1${C}bD${C}47${C}Z${plain}`;
const longLine = `${C}F03red ${C}B04bg ${C}*01~02both ${C}\u001a\u0001bold ${C}\u001cplain `;

/** Measure one call of `fn` for `durationMs`, returning nanoseconds per call. */
function measure(fn, durationMs = 150, samples = 5) {
    // Warm up so the first sample is not dominated by lazy compilation.
    for (let i = 0; i < 200; i++) fn();

    const results = [];
    for (let sample = 0; sample < samples; sample++) {
        const start = process.hrtime.bigint();
        let calls = 0;
        while (Number(process.hrtime.bigint() - start) / 1e6 < durationMs) {
            fn();
            calls++;
        }
        const elapsed = Number(process.hrtime.bigint() - start);
        results.push(elapsed / calls);
    }
    results.sort((a, b) => a - b);
    return results[Math.floor(results.length / 2)];
}

const cases = [
    ['plain text', () => parseWeeChatText(plain)],
    ['typical chat line', () => parseWeeChatText(chatLine)],
    ['heavily formatted line', () => parseWeeChatText(formattedLine)],
    ['malformed controls', () => parseWeeChatText(malformedLine)],
    ['nick color field', () => parseWeeChatStyle(`${C}F03`)],
    ['prefix color field', () => parseWeeChatStyle(`${C}14`)],
];

console.log('weechat-format benchmark (median of 5 x 150ms samples)\n');
const measured = [];
for (const [name, fn] of cases) {
    const nsPerCall = measure(fn);
    const opsPerSecond = 1e9 / nsPerCall;
    measured.push({ name, nsPerCall, opsPerSecond });
    console.log(
        `  ${name.padEnd(26)} ${nsPerCall.toFixed(1).padStart(9)} ns/call` +
        `  ${(opsPerSecond / 1000).toFixed(1).padStart(10)} k ops/s`,
    );
}

// ---- Scaling guard -----------------------------------------------------------

console.log('\nscaling (input length x1 / x2 / x4):');
const scales = [1, 2, 4].map((factor) => measure(() => parseWeeChatText(longLine.repeat(factor)), 120, 3));
for (let i = 0; i < scales.length; i++) {
    console.log(`  x${[1, 2, 4][i]}  ${scales[i].toFixed(1)} ns/call`);
}

// Linear growth means x4 input costs about 4x the time. Anything approaching
// quadratic (8x+) fails the guard. 6x leaves room for allocation noise.
const growth = scales[2] / scales[0];
const inputGrowth = 4;
console.log(`\n  growth x4 input / x1 input: ${growth.toFixed(2)}x (linear = ${inputGrowth}x, limit 6x)`);

const runs = parseWeeChatText(longLine.repeat(4)).length;
console.log(`  runs for x4 input: ${runs}`);

if (growth > 6) {
    console.error('\nbench: parsing scaled worse than linearly for 4x input — regression');
    process.exit(1);
}
console.log('\nbench: scaling guard passed');
