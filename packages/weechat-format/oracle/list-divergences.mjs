#!/usr/bin/env node
/**
 * Compare the library decoder against the vendored WeeChat scanner and print
 * every input where the consumed extents differ, as JSON.
 *
 * Run `npm run oracle` first, then `npm run build:weechat-format`, then this:
 * the output is what oracle/divergences.json documents (each entry gets a
 * reason there). test/oracle.test.ts then asserts that exactly these inputs
 * differ, and that none of them diverges differently.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeAt } from '../dist/decode.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Walk an input the way the library does, collecting (offset, consumed) pairs. */
function libraryExtents(input) {
    const extents = [];
    let offset = 0;
    while (offset < input.length) {
        const result = decodeAt(input, offset);
        if (result === null || result.consumed <= 0) {
            offset += 1;
            continue;
        }
        extents.push([offset, result.consumed]);
        offset += result.consumed;
    }
    return extents;
}

/** Parse the oracle file, skipping its comment header. */
function readOracle() {
    const rows = [];
    for (const line of readFileSync(path.join(here, 'weechat-oracle.txt'), 'utf8').split('\n')) {
        if (line.length === 0 || line.startsWith('#')) {
            continue;
        }
        const [hex, extents] = line.split('\t');
        const input = Buffer.from(hex, 'hex').toString('utf8');
        rows.push({
            input,
            extents: (extents ?? '').split(',').filter(Boolean).map((entry) => {
                const [offset, size] = entry.split(':');
                return [Number(offset), Number(size)];
            }),
        });
    }
    return rows;
}

const divergences = [];
for (const row of readOracle()) {
    const ours = libraryExtents(row.input);
    if (JSON.stringify(ours) !== JSON.stringify(row.extents)) {
        divergences.push({ input: JSON.stringify(row.input), scanner: row.extents, library: ours });
    }
}

process.stdout.write(`${JSON.stringify(divergences, null, 2)}\n`);
process.stdout.write(`divergences: ${divergences.length} of ${readOracle().length} inputs\n`);
