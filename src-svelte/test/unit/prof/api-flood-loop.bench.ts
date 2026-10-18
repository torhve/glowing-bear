/**
 * Profiling workload: the API-reducer flood repeated many times, CPU-profiled.
 *
 * Mirrors perf/apiflood.bench.ts (same seeds, same payload mix, same buffer
 * regime) so the profile describes the measured benchmark, and mirrors
 * prof/flood-loop.bench.ts so the API and legacy paths can be compared from
 * the same analyzer.
 *
 * NOT a benchmark. Run:
 *   npx vitest run --config vitest.proftest.config.ts api-flood-loop
 *   node scripts/perf/cpuprofile.mjs artifacts/perf/profiles/api-flood.cpuprofile
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { get } from 'svelte/store';
import {
    buffers,
    activeBufferId,
    recalculateLinesPerScreen,
} from '#lib/stores/models.ts';
import type { BufferSnapshot, LineSnapshot } from '#lib/api/api-contracts.ts';
import type { ApiBufferId, ApiLineId } from '#lib/api/api-ids.ts';
import { startCpuProfile } from './cpu-profile.ts';

vi.mock('#lib/stores/settings.ts', () => ({
    settings: {
        subscribe: (fn: (val: unknown) => void) => {
            fn({
                hostField: '', port: '9001', tls: false, password: '',
                savepassword: false, autoconnect: false, useTotp: false,
                themeDark: 'dark', themeLight: 'light', fontfamily: '', fontsize: '', customCSS: '',
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

const { createApiStoreReducers, flushApiLineBatch } = await import('#lib/api/api-store-reducers.ts');

const EXISTING_LINES = 300;
const BATCHES = 30;
const BATCH_SIZE = 20;
const BASE_EPOCH = 1_700_000_000_000;
const NICKS = ['alice', 'gbbot', 'carol', 'dave'];
const COLORS = ['01', '02', '03', '04', '05', '06', '07'];
const ITERS = Number(process.env.GB_PROF_ITERS ?? 40);
const WARMUP = 3;
const OUT_DIR = 'artifacts/perf/profiles';

const API_BUFFER_ID = 1_700_000_000_000_001 as ApiBufferId;
const BUFFER_KEY = String(API_BUFFER_ID);

function makeRng(seed: number) {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 0xffffffff;
    };
}

function lineSnapshot(i: number, rng: () => number): LineSnapshot {
    const nick = NICKS[Math.floor(rng() * NICKS.length)]!;
    const color = COLORS[Math.floor(rng() * COLORS.length)]!;
    const r = rng();
    let message: string;
    let highlight = false;
    let tags: string[];
    if (r < 0.05) {
        message = `\x1912you \x19are mentioned in flood-${String(i).padStart(4, '0')}`;
        highlight = true;
        tags = ['irc_privmsg', 'notify_private', `nick_${nick}`];
    } else if (r < 0.4) {
        message = `\x19${color}flood message ${String(i).padStart(4, '0')} colored \x19tail`;
        tags = ['irc_privmsg', 'notify_message', `nick_${nick}`];
    } else {
        message = `flood message ${String(i).padStart(4, '0')} the quick brown fox jumps over the lazy dog`;
        tags = ['irc_privmsg', 'notify_message', `nick_${nick}`];
    }
    const epochMs = BASE_EPOCH + i * 50;
    const iso = new Date(epochMs).toISOString();
    return {
        id: (10_000 + i) as ApiLineId,
        y: -1,
        date: iso,
        datePrinted: iso,
        epochMs,
        displayed: true,
        highlight,
        notifyLevel: highlight ? 3 : 1,
        prefix: `\x19${color}${nick}\x19`,
        message,
        tags,
    };
}

function bufferSnapshot(): BufferSnapshot {
    return {
        id: API_BUFFER_ID,
        name: 'irc.bench.#bench',
        shortName: '#bench',
        number: 1,
        contentType: 'formatted',
        semanticType: 'channel',
        hidden: false,
        title: '#bench',
        modes: '',
        inputPrompt: '',
        input: '',
        inputPosition: 0,
        inputMultiline: false,
        hasNicklist: true,
        nicklistCaseSensitive: false,
        nicklistDisplayGroups: true,
        timeDisplayed: true,
        localVariables: { type: 'channel', plugin: 'irc', server: 'bench' },
        lastReadLineId: -1,
        notify: 3,
    };
}

describe('prof: API reducer flood loop', () => {
    beforeAll(() => {
        console.debug = () => {};
    });

    it(`repeats the API flood ${ITERS}x under a CPU profile`, async () => {
        const times: number[] = [];
        const stop = startCpuProfile(`${OUT_DIR}/api-flood.cpuprofile`);
        for (let iter = 0; iter < ITERS + WARMUP; iter++) {
            buffers.set({});
            activeBufferId.set('');
            recalculateLinesPerScreen(500);
            const reducers = createApiStoreReducers();
            reducers.buffers([bufferSnapshot()]);

            const rng = makeRng(1234);
            for (let i = 0; i < EXISTING_LINES; i++) {
                reducers.lineAdded(API_BUFFER_ID, lineSnapshot(i, rng));
                if (i % BATCH_SIZE === BATCH_SIZE - 1) flushApiLineBatch();
            }
            flushApiLineBatch();
            const t0 = performance.now();
            for (let b = 0; b < BATCHES; b++) {
                for (let k = 0; k < BATCH_SIZE; k++) {
                    reducers.lineAdded(API_BUFFER_ID, lineSnapshot(EXISTING_LINES + b * BATCH_SIZE + k, rng));
                }
                flushApiLineBatch();
            }
            times.push(performance.now() - t0);
            expect(get(buffers)[BUFFER_KEY]!.lines.length).toBe(EXISTING_LINES + BATCHES * BATCH_SIZE);
        }
        stop();
        const sorted = [...times].sort((a, b) => a - b);
        console.log(`[prof] api-flood median ${sorted[Math.floor(sorted.length / 2)].toFixed(1)}ms over ${times.length} iters`);
    }, 300000);
});
