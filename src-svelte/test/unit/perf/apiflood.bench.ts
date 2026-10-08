/**
 * Performance benchmark: message flood through the API store reducers.
 *
 * `flood.bench.ts` drives `handleBufferLineAdded`, which is the LEGACY
 * protocol handler. The app connects over the WeeChat `api` relay, whose hot
 * path is `api-store-reducers.ts` — so the legacy bench measures a transport
 * production does not use. This bench drives the API reducers directly with the
 * same payload, the same buffer regime and the same snapshot gate.
 *
 * The API relay delivers one `buffer_line_added` event per line, so a "batch"
 * here is BATCH_SIZE separate `lineAdded` calls, exactly as the wire delivers
 * them. There is no coalescing layer to amortise them.
 *
 * Run with:  npx vitest run --config vitest.perf.config.ts
 *
 * Snapshots go to /tmp/gb-perf/api-snapshot-*.json for byte comparison between
 * baseline and candidate builds.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { get } from 'svelte/store';
import fs from 'node:fs';
import {
    buffers,
    activeBufferId,
    recalculateLinesPerScreen,
    localUnreadBuffers,
    servers,
} from '#lib/stores/models.ts';
import type { BufferData, BufferLine } from '#lib/types.ts';
import type { BufferSnapshot, LineSnapshot } from '#lib/api/api-contracts.ts';
import type { ApiBufferId, ApiLineId } from '#lib/api/api-ids.ts';

// ---- Same mocks as flood.bench.ts (isolate store logic from DOM) ----
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

const apiReducersModule = await import('#lib/api/api-store-reducers.ts');
const { createApiStoreReducers } = apiReducersModule;
// The baseline arm has no batching layer, so it exports no flush. Resolving it
// optionally keeps ONE bench file valid in both arms: the baseline applies each
// line synchronously, the candidate applies a frame's worth at a time.
const flushApiLineBatch = (apiReducersModule as { flushApiLineBatch?: () => void })
    .flushApiLineBatch ?? (() => {});

// ---- Workload parameters (identical to flood.bench.ts) ----
const EXISTING_LINES = 300;
const BATCHES = 30;
const BATCH_SIZE = 20;
const FLOODED_LINES = BATCHES * BATCH_SIZE; // 600
const BASE_EPOCH = 1_700_000_000_000; // fixed → deterministic timestamps
const REPS = Number(process.env.GB_PERF_REPS ?? 5);

const API_BUFFER_ID = 1_700_000_000_000_001 as ApiBufferId;
const BUFFER_KEY = String(API_BUFFER_ID);
const CORE_KEY = '1000000000000001';
// Sidebar size for the 'unread' scenario — the size of the local-unread id Set
// each coalesced store write would otherwise have copied.
const SIDE_BUFFERS = 24;

const NICKS = ['alice', 'gbbot', 'carol', 'dave'];
const COLORS = ['01', '02', '03', '04', '05', '06', '07'];

/** Deterministic pseudo-random (LCG) so every run floods identical content. */
function makeRng(seed: number) {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 0xffffffff;
    };
}

/** Same payload mix as the legacy bench, shaped as an API LineSnapshot. */
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

function coreSnapshot(): BufferSnapshot {
    return {
        ...bufferSnapshot(),
        id: 1000000000000001 as ApiBufferId,
        name: 'core.weechat',
        shortName: 'weechat',
        number: 0,
        semanticType: 'free',
        localVariables: {},
    };
}

/**
 * Extra sidebar buffers for the 'unread' scenario. Coalescing the local-unread
 * id Set and the servers map only costs anything when they hold more than one
 * entry — a real client has dozens of buffers and several of them unread.
 */
function sideSnapshots(count: number): BufferSnapshot[] {
    return Array.from({ length: count }, (_, i) => ({
        ...bufferSnapshot(),
        id: (2000000000000001 + i) as ApiBufferId,
        name: `irc.bench.#side${i}`,
        shortName: `#side${i}`,
        number: i + 2,
    }));
}

/** Canonical snapshot of buffer state; same field set as flood.bench.ts. */
function snapshotBuffer(buf: BufferData): string {
    const lines = buf.lines.map((l: BufferLine) => ({
        date: l.date,
        lineId: l.lineId,
        text: l.text,
        prefixtext: l.prefixtext,
        shortTime: l.shortTime,
        highlight: l.highlight,
        isUserMessage: l.isUserMessage,
        notifyLevel: l.notifyLevel,
        showHiddenBrackets: l.showHiddenBrackets,
        isDateSeparator: l.isDateSeparator,
        prefix: l.prefix.map(p => ({ t: p.text, c: p.classes })),
        content: l.content.map(p => ({ t: p.text, c: p.classes }))
    }));
    return JSON.stringify({
        id: buf.id,
        lines,
        unread: buf.unread,
        notification: buf.notification,
        localUnread: buf.localUnread,
        lastSeen: buf.lastSeen,
        readBoundaryKnown: buf.readBoundaryKnown,
        readBoundaryId: buf.readBoundaryId,
        requestedLines: buf.requestedLines,
        active: buf.active,
        pendingReadBoundaryUnread: buf.pendingReadBoundaryUnread
    });
}

describe('perf: API reducer flood benchmark', () => {
    beforeAll(() => {
        fs.mkdirSync('/tmp/gb-perf', { recursive: true });
        console.debug = () => {};
    });

    async function runScenario(
        scenario: 'inactive' | 'active' | 'unread',
        seed: number,
    ): Promise<{ median: number; min: number; max: number; reps: number[] }> {
        const reps: number[] = [];
        let snap = '';

        for (let rep = 0; rep < REPS; rep++) {
            buffers.set({});
            activeBufferId.set('');
            localUnreadBuffers.set(new Set());
            servers.set({ 'irc.bench': { id: 'irc.bench', unread: 0 } });
            recalculateLinesPerScreen(500); // maxBufferLines = 1000 → no trimming in bench

            const rng = makeRng(seed);
            const reducers = createApiStoreReducers();
            // core.weechat exists so the 'inactive' scenario has a buffer the user
            // IS looking at. Without one the snapshot reducer auto-activates the
            // flooded buffer, every line lands in the active buffer, and nothing
            // tallies — the scenario measured an inactive buffer that was not one.
            reducers.buffers([coreSnapshot(), bufferSnapshot()]);
            activeBufferId.set(scenario === 'active' ? BUFFER_KEY : CORE_KEY);
            if (scenario === 'unread') {
                const sides = sideSnapshots(SIDE_BUFFERS);
                reducers.buffers(sides);
                activeBufferId.set(CORE_KEY);
                localUnreadBuffers.update((current) => {
                    const next = new Set(current);
                    for (const snap of sides) next.add(String(snap.id));
                    return next;
                });
            }

            // Seed existing lines through the same code path (not timed).
            // `lineAdded` queues; the frame-aligned flush applies the queue, so the
            // bench flushes once per BATCH_SIZE events — one frame's worth of wire
            // traffic — which is exactly what the rAF does in the browser.
            for (let i = 0; i < EXISTING_LINES; i++) {
                reducers.lineAdded(API_BUFFER_ID, lineSnapshot(i, rng));
                if (i % BATCH_SIZE === BATCH_SIZE - 1) flushApiLineBatch();
            }
            flushApiLineBatch();
            expect(get(buffers)[BUFFER_KEY]?.lines.length).toBe(EXISTING_LINES);

            // Timed flood: one lineAdded per wire event, BATCH_SIZE events per burst.
            const t0 = performance.now();
            for (let b = 0; b < BATCHES; b++) {
                for (let k = 0; k < BATCH_SIZE; k++) {
                    reducers.lineAdded(API_BUFFER_ID, lineSnapshot(EXISTING_LINES + b * BATCH_SIZE + k, rng));
                }
                flushApiLineBatch();
            }
            const elapsed = performance.now() - t0;
            reps.push(elapsed);

            const finalBuf = get(buffers)[BUFFER_KEY]!;
            expect(finalBuf.lines.length).toBe(EXISTING_LINES + FLOODED_LINES);

            snap = snapshotBuffer(finalBuf);
        }

        fs.writeFileSync(`/tmp/gb-perf/api-snapshot-${scenario}.json`, snap);

        const sorted = [...reps].sort((a, b) => a - b);
        return {
            median: sorted[Math.floor(sorted.length / 2)],
            min: sorted[0]!,
            max: sorted[sorted.length - 1]!,
            reps,
        };
    }

    function report(scenario: 'inactive' | 'active' | 'unread', r: { median: number; min: number; max: number; reps: number[] }): void {
        const perLine = r.median / FLOODED_LINES;
        const letter = scenario === 'inactive' ? 'C' : scenario === 'active' ? 'D' : 'E';
        const line =
            `${letter} api-${scenario} median ${r.median.toFixed(1)}ms min ${r.min.toFixed(1)} max ${r.max.toFixed(1)} ` +
            `${perLine.toFixed(3)}ms/line reps=${r.reps.map((v) => v.toFixed(1)).join(',')}`;
        fs.appendFileSync('/tmp/gb-perf/unit-results.txt', line + '\n');
        console.log(`[perf] ${line}`);
    }

    it('API flood A: inactive buffer', async () => {
        report('inactive', await runScenario('inactive', 1234));
    }, 120000);

    it('API flood B: active buffer', async () => {
        report('active', await runScenario('active', 4321));
    }, 120000);

    it('API flood E: inactive buffer with a sidebar of unread buffers', async () => {
        report('unread', await runScenario('unread', 9091));
    }, 120000);
});
