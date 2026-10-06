/**
 * Micro-benchmarks of the individual pieces of the line hot path.
 *
 * Purpose: absolute ns/call numbers for each step, so a profile percentage can
 * be converted into "how many milliseconds would removing this save". Run with
 * the profiling config (not the measured-benchmark config):
 *
 *   npx vitest run --config vitest.proftest.config.ts
 *
 * These are not correctness tests and are not part of `npm test`.
 */
import { describe, it, beforeAll } from 'vitest';
import fs from 'node:fs';
import { createBufferLine, parseRichText } from '#lib/stores/models.ts';
import { rawText2Rich } from '#lib/weechat-colors.ts';
import { parseWeeChatText } from '@glowingbear/weechat-format';

const C = '\u0019';

const PREFIX_COLOR = `${C}02alice${C}`;
const MSG_PLAIN = 'flood message 0001 the quick brown fox jumps over the lazy dog';
const MSG_COLOR = `${C}03flood message 0001 colored ${C}tail`;

function measure(name: string, fn: () => unknown, iters = 200_000): number {
    for (let i = 0; i < 5_000; i++) fn();
    let best = Infinity;
    let sink = 0;
    for (let sample = 0; sample < 5; sample++) {
        const t0 = performance.now();
        for (let i = 0; i < iters; i++) {
            const r = fn() as { length?: number };
            sink += typeof r === 'string' ? r.length : (r?.length ?? 0);
        }
        best = Math.min(best, ((performance.now() - t0) * 1e6) / iters);
    }
    // sink keeps the result alive so the call cannot be optimised away.
    void sink;
    fs.appendFileSync('/tmp/gb-perf/micro.txt', `${name}\t${best.toFixed(1)}\n`);
    return best;
    return best;
}

describe('micro: line hot path pieces', () => {
    beforeAll(() => {
        console.debug = () => {};
        fs.mkdirSync('/tmp/gb-perf', { recursive: true });
        fs.rmSync('/tmp/gb-perf/micro.txt', { force: true });
    });

    it('measures each piece', () => {
        const base = {
            buffer: '0xbench',
            date: 1_700_000_000_000,
            date_long: 0,
            tags_array: ['irc_privmsg', 'irc_msgtype', 'irc_msgtype_private'],
            displayed: 1,
            notify_level: 1,
            highlight: 0,
            id: 10_001,
            bufferType: 'channel' as const,
        };

        const full = measure('createBufferLine (colored message)', () =>
            createBufferLine({ ...base, prefix: PREFIX_COLOR, message: MSG_COLOR }),
        );
        const plain = measure('createBufferLine (plain message)', () =>
            createBufferLine({ ...base, prefix: 'alice', message: MSG_PLAIN }),
        );
        measure('createBufferLine (highlighted)', () =>
            createBufferLine({ ...base, prefix: PREFIX_COLOR, message: MSG_COLOR, highlight: 1 }),
        );

        measure('parseRichText(prefix, colored)', () => parseRichText(PREFIX_COLOR));
        measure('parseRichText(message, colored)', () => parseRichText(MSG_COLOR));
        measure('parseRichText(message, plain)', () => parseRichText(MSG_PLAIN));

        measure('rawText2Rich(colored)', () => rawText2Rich(MSG_COLOR));
        measure('rawText2Rich(plain)', () => rawText2Rich(MSG_PLAIN));
        measure('parseWeeChatText(colored)', () => parseWeeChatText(MSG_COLOR));
        measure('parseWeeChatText(plain)', () => parseWeeChatText(MSG_PLAIN));

        fs.appendFileSync(
            '/tmp/gb-perf/micro.txt',
            `createBufferLine colored - plain\t${(full - plain).toFixed(1)}\n`,
        );
    }, 300000);
});
