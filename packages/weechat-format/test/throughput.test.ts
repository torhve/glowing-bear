/**
 * Throughput baseline against the two existing parsers.
 *
 * This is the executable half of the plan's benchmark step: it records what the
 * current Svelte parser and the original AngularJS parser cost on the same corpus
 * as the new library, and fails if the library is materially slower than the
 * parser it would replace. Absolute numbers move with the machine, so the gate is
 * a ratio, not a constant; the numbers themselves are printed for the record.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { parseWeeChatText } from '../src/parse.js';
import { CTL } from './helpers/ctl.js';
import { loadLegacyParsers, measure } from './helpers/legacy-parsers.js';
import type { LegacyParsers } from './helpers/legacy-parsers.js';

const C = CTL.color;

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
    `${CTL.setAttr}\u0001underlined bold`,
    `${CTL.removeAttr}\u0001not bold`,
    `${C}Eemphasised${C}E`,
    `${C}${CTL.reset}back to chat colors`,
].join('');
const malformedLine = `${C}F0x${C}*03,@12${C}F@1${C}bD${C}47${C}Z${plain}`;
const longUnit = `${C}F03red ${C}B04bg ${C}*01~02both ${CTL.setAttr}\u0001bold ${C}${CTL.reset}plain `;

const CORPUS: Array<{ name: string; input: string }> = [
    { name: 'plain text', input: plain },
    { name: 'typical chat line', input: chatLine },
    { name: 'formatted line', input: formattedLine },
    { name: 'malformed controls', input: malformedLine },
    { name: 'long line (x4)', input: longUnit.repeat(4) },
];

describe('throughput baseline', () => {
    let parsers: LegacyParsers;

    beforeAll(async () => {
        parsers = await loadLegacyParsers();
    });

    // Measurement windows take longer than Vitest's default test timeout.
    it('is not materially slower than the parser it would replace', { timeout: 30_000 }, () => {
        const rows: string[] = [];
        rows.push('corpus                 library      current      angular-legacy   library/current');

        for (const item of CORPUS) {
            const library = measure(() => parseWeeChatText(item.input), 80, 2);
            const current = measure(() => parsers.current(item.input), 80, 2);
            const angular = measure(() => parsers.legacy(item.input), 80, 2);
            const ratio = library / current;
            rows.push(
                `  ${item.name.padEnd(20)} ${library.toFixed(0).padStart(8)}  ` +
                `${current.toFixed(0).padStart(9)}  ${angular.toFixed(0).padStart(13)}` +
                `  ${ratio.toFixed(2)}x`,
            );
            // A generous margin: measurement noise plus the library's extra work
            // (diagnostics, immutable style snapshots). Being slower than the
            // parser being replaced by more than this is a regression.
            expect(
                ratio,
                `${item.name}: library ${library.toFixed(0)} ns vs current ${current.toFixed(0)} ns`,
            ).toBeLessThan(3);
        }

        console.log(`\nthroughput (ns/call, median of 2 x 80ms windows)\n${rows.join('\n')}`);
    });

    it('scales linearly with input length', { timeout: 20_000 }, () => {
        const single = measure(() => parseWeeChatText(longUnit), 80, 2);
        const quadruple = measure(() => parseWeeChatText(longUnit.repeat(4)), 80, 2);
        const growth = quadruple / single;
        console.log(`\nscaling: x1 ${single.toFixed(0)} ns, x4 ${quadruple.toFixed(0)} ns (${growth.toFixed(2)}x)`);
        expect(growth).toBeLessThan(6);
    });

    it('produces the same run count the current parser produces for well-formed input', () => {
        // Run counts are the allocation-pressure proxy: fewer or equal runs means
        // less downstream rendering work, and a large increase would not be free.
        const libraryRuns = parseWeeChatText(chatLine).length;
        const currentRuns = parsers.current(chatLine).filter((part) => (part.text ?? '').length > 0).length;
        console.log(`\nrun counts for a typical chat line: library ${libraryRuns}, current ${currentRuns}`);
        expect(libraryRuns).toBeLessThanOrEqual(currentRuns + 1);
    });
});
