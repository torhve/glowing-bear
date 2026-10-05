#!/usr/bin/env node
/**
 * Generate the consumption corpus and run it through the vendored WeeChat
 * scanner, producing the local artifacts test/oracle.test.ts compares against:
 * (generated evidence, not tracked; the repo keeps the ledger)
 *
 *   oracle/corpus.txt          one hex-encoded input per line
 *   oracle/weechat-oracle.txt  the same inputs with gui_color_code_size() extents
 *
 * Inputs are restricted to ASCII on purpose: WeeChat measures bytes, JavaScript
 * measures UTF-16 code units, and for ASCII the two are the same. Unicode
 * handling is covered by test/unicode.test.ts instead.
 *
 * Usage: npm run oracle   (builds the C harness first if needed)
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const C = '\u0019';
const SET = '\u001a';
const REM = '\u001b';
const RST = '\u001c';
const ATTR_FLAGS = ['%', '.', '*', '!', '/', '_', '|'];
const BAR_REFS = ['F', 'B', 'D', '_', '-', '#', 'i', 'l', 's'];

/** Deterministic corpus: an inventory, its truncation ladder, payload variants, sequences, and seeded noise. */
function buildCorpus() {
    const cases = new Set();
    const add = (value) => {
        if (value.length > 0 && value.length <= 64) {
            cases.add(value);
        }
    };

    // 1. Control inventory: one representative of every recognized form.
    const inventory = [
        `${C}F03`,
        `${C}F00`,
        `${C}F99`,
        `${C}F@00012`,
        `${C}F@99999`,
        `${C}F@|00088`,
        `${C}F@%.*!/_|00012`,
        `${C}F|03`,
        `${C}F*03`,
        `${C}B04`,
        `${C}B@00015`,
        `${C}B@|00015`,
        `${C}*03~04`,
        `${C}*03,04`,
        `${C}*@00012~@00015`,
        `${C}*|03~04`,
        `${C}@00012`,
        `${C}@00000`,
        `${C}E`,
        `${C}${RST}`,
        `${RST}`,
        `${C}bF`,
        `${C}bB`,
        `${C}bD`,
        `${C}b_`,
        `${C}b-`,
        `${C}b#`,
        `${C}bi`,
        `${C}bl`,
        `${C}bs`,
        `${SET}\u0001`,
        `${SET}\u0002`,
        `${SET}\u0003`,
        `${SET}\u0004`,
        `${SET}\u0005`,
        `${SET}\u0006`,
        `${REM}\u0001`,
        `${REM}\u0006`,
        `${SET}*`,
        `${REM}/`,
        `${C}03`,
        `${C}46`,
    ];
    for (const value of inventory) {
        add(value);
    }

    // 2. Truncation ladder: every prefix of every inventory entry.
    for (const value of inventory) {
        for (let length = 1; length < value.length; length++) {
            add(value.slice(0, length));
        }
    }

    // 3. Payload variants: two-digit and extended payloads with attribute-flag runs.
    const twoDigit = ['00', '03', '09', '10', '17', '26', '46', '99', 'ab', '0a', 'a0', ' 1', '1 ', '-1', '+1'];
    const extended = ['00000', '00012', '00088', '09999', '10000', '99999', '-1234', '123456', 'abcde', '12 45', '1234 '];
    const flagRuns = [''];
    for (const flag of ATTR_FLAGS) {
        flagRuns.push(flag);
    }
    for (const first of ATTR_FLAGS) {
        for (const second of ATTR_FLAGS) {
            flagRuns.push(first + second);
        }
    }
    flagRuns.push('%.*!/_|');
    flagRuns.push('||');
    flagRuns.push('|%');
    for (const flags of flagRuns) {
        for (const payload of twoDigit) {
            add(`${C}F${flags}${payload}`);
            add(`${C}*${flags}${payload}~04`);
            add(`${C}*${flags}${payload},04`);
            add(`${C}*${flags}${payload}`);
        }
        for (const payload of extended) {
            add(`${C}F@${flags}${payload}`);
            add(`${C}*@${flags}${payload}~@00015`);
        }
        for (const payload of extended) {
            add(`${C}B${flags}${payload}`);
            add(`${C}B@${flags}${payload}`);
            add(`${C}*03~${flags}${payload}`);
            add(`${C}*03~@${flags}${payload}`);
        }
    }

    // 4. Separator and pair variants, including malformed ones.
    for (const separator of [',', '~', ';', ':', '']) {
        for (const bg of ['04', '@00015', '@12', '@', 'ab', '']) {
            add(`${C}*03${separator}${bg}`);
            add(`${C}*@00012${separator}${bg}`);
        }
    }
    for (const pair of ['00000', '00012', '99999', '1234', '123', '12', '1', '', '1234a', 'a2345']) {
        add(`${C}@${pair}`);
    }

    // 5. Bar references, valid and unrecognized.
    for (const reference of BAR_REFS) {
        add(`${C}b${reference}`);
        add(`${C}b${reference}text`);
    }
    for (const reference of ['Z', 'z', '0', ' ', '\u0019', '\u001c']) {
        add(`${C}b${reference}`);
    }

    // 6. Attribute set/remove controls with supported and unsupported payloads.
    for (const payload of ['\u0001', '\u0002', '\u0003', '\u0004', '\u0005', '\u0006', '*', '!', '/', '_', '|', '%', '.', '0', 'a', ' ', '\u0019', '\u001c', '\u0007', '\u0000']) {
        add(`${SET}${payload}`);
        add(`${REM}${payload}`);
        add(`${SET}${payload}text`);
    }

    // 7. Sequences: controls back to back, with and without text between them.
    const sequencePieces = [
        `${C}F03`, `${C}B04`, `${C}*03~04`, `${C}E`, `${C}${RST}`, `${RST}`,
        `${C}@00012`, `${SET}\u0001`, `${REM}\u0001`, `${C}F@|00088`, `${C}bF`, 'text', ' ',
    ];
    for (const first of sequencePieces) {
        for (const second of sequencePieces) {
            add(first + second);
            add(`${first}a${second}`);
            for (const third of sequencePieces) {
                add(first + second + third);
            }
        }
    }

    // 8. Seeded pseudo-random noise over a control-heavy alphabet.
    const alphabet = [
        C, SET, REM, RST, 'F', 'B', '*', '@', '%', '.', '!', '/', '_', '|', 'E', 'b', 'D',
        '-', '#', 'i', 'l', 's', ',', '~', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
        'a', 'Z', ' ', '\u0001', '\u0002', '\u0006',
    ];
    let state = 0x9e3779b9;
    const nextRandom = () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 0x100000000;
    };
    for (let index = 0; index < 4000; index++) {
        const length = 1 + Math.floor(nextRandom() * 24);
        let value = '';
        for (let position = 0; position < length; position++) {
            value += alphabet[Math.floor(nextRandom() * alphabet.length)];
        }
        add(value);
    }

    // 9. Shapes that actually arrive from a relay.
    add(`${C}03${C}F03nick${C}F04${RST} message text`);
    add(`${C}bF${C}bD${C}bB`);
    add(`${C}F@|00088(Leaving${C}${RST}`);
    add(`${C}Eemphasised${C}Eplain`);
    add(`${C}*@|00000~@00015combined`);

    return [...cases].sort();
}

function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}

const scannerSource = path.join(here, 'weechat_color_scan.c');
// The vendored scanner is a local artifact, so a fresh checkout has nothing to
// compile. Say so instead of letting cc report a missing input file.
if (!existsSync(scannerSource)) {
    throw new Error('oracle/weechat_color_scan.c is missing. It is a local artifact, not tracked in this repo; re-vendor gui_color_code_size() and gui_color_attr_get_flag() verbatim from WeeChat 4.10.1 (src/gui/gui-color.c:609-772 and :189-214, GUI_COLOR_* constants in src/gui/gui-color.h:102-158) with the GPL-3.0-or-later attribution header, then rerun. The tracked ledger in oracle/divergences.json records what that scanner was shown to do.');
}
const binaryDir = path.join(here, 'build');
const binary = path.join(binaryDir, 'weechat-color-scan');
if (!existsSync(binary)) {
    mkdirSync(binaryDir, { recursive: true });
    execFileSync('cc', ['-O2', '-std=c99', '-Wall', '-Wextra', '-o', binary, scannerSource], { stdio: 'inherit' });
}

const corpus = buildCorpus();
const corpusText = `${corpus.map((value) => Buffer.from(value, 'utf8').toString('hex')).join('\n')}\n`;

const output = execFileSync(binary, [], { input: corpusText, encoding: 'utf8' });
const lines = output.trimEnd().split('\n');
if (lines.length !== corpus.length) {
    throw new Error(`oracle produced ${lines.length} lines for ${corpus.length} inputs`);
}

const header = [
    '# WeeChat consumption oracle, generated by `npm run oracle`.',
    '# Scanner: gui_color_code_size(), WeeChat 4.10.1 src/gui/gui-color.c:609-772.',
    '# Vendored source: oracle/weechat_color_scan.c',
    `# Vendored source sha256: ${sha256(readFileSync(scannerSource))}`,
    `# Corpus sha256: ${sha256(corpusText)}`,
    '# Inputs are ASCII hex so byte offsets and UTF-16 offsets coincide.',
    '# Format: <hex input>\t<offset>:<size>,<offset>:<size>,...',
].join('\n');

writeFileSync(path.join(here, 'corpus.txt'), corpusText);
writeFileSync(path.join(here, 'weechat-oracle.txt'), `${header}\n${output}`);
process.stdout.write(`oracle: ${corpus.length} inputs written to oracle/corpus.txt and oracle/weechat-oracle.txt\n`);
