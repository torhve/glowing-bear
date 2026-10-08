/**
 * Profiling workload: the flood and history scenarios repeated many times, with
 * a CPU profile captured around the timed region only.
 *
 * NOT a benchmark — it exists only to be profiled. Kept out of
 * vitest.perf.config.ts (separate config: vitest.proftest.config.ts).
 *
 * Run:
 *   npx vitest run --config vitest.proftest.config.ts
 *   node scripts/perf/cpuprofile.mjs artifacts/perf/profiles/flood.cpuprofile
 *
 * Workload mirrors perf/flood.bench.ts and perf/history.bench.ts (same LCG
 * seeds, same payload mix, same buffer regime) so the profile describes the
 * measured benchmarks.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { get } from 'svelte/store';
import {
    buffers,
    activeBufferId,
    recalculateLinesPerScreen,
    createBuffer,
} from '#lib/stores/models.ts';
import type { BufferData, ProtocolMessage } from '#lib/types.ts';
import { startCpuProfile } from './cpu-profile.ts';

vi.mock('#lib/stores/settings.ts', () => ({
    settings: {
        subscribe: (fn: (val: unknown) => void) => {
            fn({
                hostField: '', port: '9001', tls: false, password: '',
                savepassword: false, autoconnect: false, useTotp: false,
                theme: 'dark', fontfamily: '', fontsize: '', customCSS: '',
                iToken: '', iAlb: '', onlyUnread: false, noembed: false,
                alwaysnicklist: false, orderbyserver: false,
                readlineBindings: false, useFavico: false, soundnotification: false,
                enableMathjax: false, enableQuickKeys: false, showNicklist: true,
                showQuickKeys: false, showJumpKeys: false, highlightWords: '', hotlistsync: true
            });
            return () => {};
        }
    },
    updateSettings: vi.fn(),
    updatePartialSettings: vi.fn()
}));

vi.mock('#lib/notifications.ts', () => ({
    createHighlight: vi.fn(),
    playNotificationSound: vi.fn(),
    updateTitle: vi.fn(),
    updateFavico: vi.fn(),
    startIndicatorOwner: () => () => {},
    refreshIndicators: vi.fn(),
}));

vi.mock('#lib/windowFocus.ts', () => ({
    initWindowFocusTracking: vi.fn(() => Promise.resolve(() => {})),
    isWindowFocused: () => true,
}));

vi.mock('#lib/stores/bufferResume.ts', () => ({
    lastBufferId: {
        subscribe: (fn: (val: string) => void) => { fn(''); return () => {}; },
        set: vi.fn(),
    },
    recordLastBuffer: vi.fn(),
    shouldResume: vi.fn().mockReturnValue(false),
}));

const { handleBufferLineAdded, handleLineInfo } = await import('#lib/stores/handlers.ts');

const EXISTING_LINES = 300;
const BATCHES = 30;
const BATCH_SIZE = 20;
const HISTORY_LINES = 5000;
const BASE_EPOCH = 1_700_000_000_000;
const NICKS = ['alice', 'gbbot', 'carol', 'dave'];
const COLORS = ['01', '02', '03', '04', '05', '06', '07'];
const ITERS = Number(process.env.GB_PROF_ITERS ?? 40);
const WARMUP = 3;
const OUT_DIR = 'artifacts/perf/profiles';

function makeRng(seed: number) {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 0xffffffff;
    };
}

function linePayload(i: number, rng: () => number) {
    const nick = NICKS[Math.floor(rng() * NICKS.length)]!;
    const color = COLORS[Math.floor(rng() * COLORS.length)]!;
    const r = rng();
    let message: string;
    let highlight = 0;
    if (r < 0.05) {
        message = `\x1912you \x19are mentioned in flood-${String(i).padStart(4, '0')}`;
        highlight = 1;
    } else if (r < 0.4) {
        message = `\x19${color}flood message ${String(i).padStart(4, '0')} colored \x19tail`;
    } else {
        message = `flood message ${String(i).padStart(4, '0')} the quick brown fox jumps over the lazy dog`;
    }
    return {
        buffer: '0xbench',
        date: BASE_EPOCH + i * 50,
        date_long: 0,
        prefix: `\x19${color}${nick}\x19`,
        message,
        tags_array: ['irc_privmsg', 'irc_msgtype', 'irc_msgtype_private'],
        displayed: 1,
        notify_level: highlight ? 3 : 1,
        highlight,
        id: 10_000 + i
    };
}

function makeLineMsgs(bufferId: string, count: number, startIdx: number, rng: () => number) {
    const content = [];
    for (let i = 0; i < count; i++) content.push(linePayload(startIdx + i, rng));
    return { objects: [{ pointer: bufferId, content }] } as ProtocolMessage;
}

function makeBenchBuffer(): BufferData {
    return createBuffer({
        pointers: ['0xbench'],
        full_name: 'bench',
        short_name: 'bench',
        type: 2,
        notify: 3,
        local_variables: { type: 'channel', plugin: 'irc', server: 'irc.freenode.net' }
    });
}

function resetStores(): BufferData {
    buffers.set({});
    activeBufferId.set('');
    recalculateLinesPerScreen(500);
    const buffer = makeBenchBuffer();
    buffers.set({ [buffer.id]: buffer });
    return buffer;
}

describe('prof: flood loop', () => {
    beforeAll(() => {
        console.debug = () => {};
    });

    it(`repeats the flood ${ITERS}x under a CPU profile`, async () => {
        const times: number[] = [];
        const stop = startCpuProfile(`${OUT_DIR}/flood.cpuprofile`);
        for (let iter = 0; iter < ITERS + WARMUP; iter++) {
            const buffer = resetStores();
            const rng = makeRng(1234);
            for (let b = 0; b < EXISTING_LINES / BATCH_SIZE; b++) {
                handleBufferLineAdded(makeLineMsgs(buffer.id, BATCH_SIZE, b * BATCH_SIZE, rng));
            }
            const t0 = performance.now();
            for (let b = 0; b < BATCHES; b++) {
                handleBufferLineAdded(makeLineMsgs(buffer.id, BATCH_SIZE, EXISTING_LINES + b * BATCH_SIZE, rng));
            }
            const elapsed = performance.now() - t0;
            if (iter >= WARMUP) times.push(elapsed);
            expect(get(buffers)[buffer.id]!.lines.length).toBe(EXISTING_LINES + BATCHES * BATCH_SIZE);
        }
        await stop();
        times.sort((a, b) => a - b);
        console.log(`[prof] flood median ${times[Math.floor(times.length / 2)].toFixed(1)}ms over ${times.length} iters`);
    }, 300000);

    it(`repeats the ${HISTORY_LINES}-line history ${ITERS}x under a CPU profile`, async () => {
        const times: number[] = [];
        const stop = startCpuProfile(`${OUT_DIR}/history.cpuprofile`);
        for (let iter = 0; iter < ITERS + WARMUP; iter++) {
            const buffer = resetStores();
            activeBufferId.set(buffer.id);

            const rng = makeRng(777);
            const content = [];
            for (let i = 0; i < HISTORY_LINES; i++) content.push(linePayload(HISTORY_LINES - 1 - i, rng));
            const message = { objects: [{ pointer: buffer.id, content }] } as ProtocolMessage;

            const t0 = performance.now();
            handleLineInfo(message, true);
            const elapsed = performance.now() - t0;
            if (iter >= WARMUP) times.push(elapsed);
            expect(get(buffers)[buffer.id]!.requestedLines).toBe(HISTORY_LINES);
        }
        await stop();
        times.sort((a, b) => a - b);
        console.log(`[prof] history median ${times[Math.floor(times.length / 2)].toFixed(1)}ms over ${times.length} iters`);
    }, 300000);
});
