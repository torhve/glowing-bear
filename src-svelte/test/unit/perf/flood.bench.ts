/**
 * Performance benchmark: message flood through the store pipeline.
 *
 * Simulates the production hot path: `_buffer_line_added` events arriving in
 * batches of 20 (typical WeeChat burst cadence) into a channel buffer that
 * already holds 300 lines (realistic maxBufferLines regime).
 *
 * Run with:  npx vitest run --config vitest.perf.config.ts
 *
 * The benchmark also writes a canonical JSON snapshot of the resulting buffer
 * state to /tmp/gb-perf/ so that baseline and optimized builds can be
 * byte-compared for output identity.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { get } from 'svelte/store';
import fs from 'node:fs';
import {
    buffers,
    activeBufferId,
    recalculateLinesPerScreen,
    createBuffer,
} from '#lib/stores/models.ts';
import type { BufferData, ProtocolMessage, BufferLine } from '#lib/types.ts';

// ---- Same mocks as readmarker.test.ts (isolate store logic from DOM) ----
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

const { handleBufferLineAdded } = await import('#lib/stores/handlers.ts');

// ---- Workload parameters ----
const EXISTING_LINES = 300;
const BATCHES = 30;
const BATCH_SIZE = 20;
const FLOODED_LINES = BATCHES * BATCH_SIZE; // 600
const BASE_EPOCH = 1_700_000_000_000; // fixed → deterministic timestamps
// In-process repetitions. A single timed pass is ~25 ms and scheduling noise
// is a large fraction of it, so every run reports the MEDIAN over GB_PERF_REPS
// identical passes (default 5). Comparing medians across batches is what makes
// a paired A/B meaningful; a single pass is not a result.
const REPS = Number(process.env.GB_PERF_REPS ?? 5);

// Realistic payload variety: plain, colored, and highlighted IRC messages.
const NICKS = ['alice', 'gbbot', 'carol', 'dave'];
const COLORS = ['01', '02', '03', '04', '05', '06', '07'];

// Deterministic pseudo-random (LCG) so every run floods identical content.
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
    return {
        objects: [{ pointer: bufferId, content }]
    } as ProtocolMessage;
}

/** Canonical snapshot of buffer state for output-identity comparison. */
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

describe('perf: flood benchmark', () => {
    beforeAll(() => {
        fs.mkdirSync('/tmp/gb-perf', { recursive: true });
        // Chrome's console.debug is a no-op in production; jsdom would write to
        // the stream, so stub it to match browser reality (arguments are still
        // evaluated, which is the cost that matters).
        console.debug = () => {};
    });

    async function runScenario(
        scenario: 'inactive' | 'active',
        seed: number,
    ): Promise<{ median: number; min: number; max: number; reps: number[] }> {
        const reps: number[] = [];
        let snap = '';

        for (let rep = 0; rep < REPS; rep++) {
            // Reset stores
            buffers.set({});
            activeBufferId.set('');
            recalculateLinesPerScreen(500); // maxBufferLines = 1000 → no trimming in bench

            const rng = makeRng(seed);

            // Seed buffer with 300 existing lines through the same code path.
            const buffer = createBuffer({
                pointers: ['0xbench'],
                full_name: 'bench',
                short_name: 'bench',
                type: 2,
                notify: 3,
                local_variables: { type: 'channel', plugin: 'irc', server: 'irc.freenode.net' }
            });
            buffers.set({ [buffer.id]: buffer });
            if (scenario === 'active') activeBufferId.set(buffer.id);

            // Seed existing lines (not timed).
            for (let b = 0; b < EXISTING_LINES / BATCH_SIZE; b++) {
                handleBufferLineAdded(makeLineMsgs(buffer.id, BATCH_SIZE, b * BATCH_SIZE, rng));
            }
            expect(get(buffers)[buffer.id]?.lines.length).toBe(EXISTING_LINES);

            // Timed flood.
            const t0 = performance.now();
            for (let b = 0; b < BATCHES; b++) {
                handleBufferLineAdded(makeLineMsgs(buffer.id, BATCH_SIZE, EXISTING_LINES + b * BATCH_SIZE, rng));
            }
            const elapsed = performance.now() - t0;
            reps.push(elapsed);

            const finalBuf = get(buffers)[buffer.id]!;
            expect(finalBuf.lines.length).toBe(EXISTING_LINES + FLOODED_LINES);

            // Persist canonical snapshot for cross-build byte comparison.
            snap = snapshotBuffer(finalBuf);
        }

        const path = `/tmp/gb-perf/unit-snapshot-${scenario}.json`;
        fs.writeFileSync(path, snap);

        const sorted = [...reps].sort((a, b) => a - b);
        return {
            median: sorted[Math.floor(sorted.length / 2)],
            min: sorted[0]!,
            max: sorted[sorted.length - 1]!,
            reps,
        };
    }

    function report(scenario: 'inactive' | 'active', r: { median: number; min: number; max: number; reps: number[] }): void {
        const perLine = r.median / FLOODED_LINES;
        const letter = scenario === 'inactive' ? 'A' : 'B';
        const line =
            `${letter} ${scenario} median ${r.median.toFixed(1)}ms min ${r.min.toFixed(1)} max ${r.max.toFixed(1)} ` +
            `${perLine.toFixed(3)}ms/line reps=${r.reps.map((v) => v.toFixed(1)).join(',')}`;
        fs.appendFileSync('/tmp/gb-perf/unit-results.txt', line + '\n');
        console.log(`[perf] ${line}`);
    }

    it('flood A: inactive buffer', async () => {
        report('inactive', await runScenario('inactive', 1234));
    }, 120000);

    it('flood B: active buffer', async () => {
        report('active', await runScenario('active', 4321));
    }, 120000);
});
