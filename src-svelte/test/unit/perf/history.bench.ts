/**
 * Performance benchmark: large history load through the store pipeline.
 *
 * Simulates opening a buffer with a large WeeChat history: a single
 * `_buffer_line_info` event carrying N lines (newest-first, as WeeChat sends)
 * through `handleLineInfo` — the same entry point production uses on buffer
 * focus / reconnect.
 *
 * Run with:  npx vitest run --config vitest.perf.config.ts
 *
 * Writes a canonical snapshot of the tail of the resulting buffer to
 * /tmp/gb-perf/ for byte comparison between baseline and optimized builds.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { get } from 'svelte/store';
import fs from 'node:fs';
import {
    buffers,
    activeBufferId,
    recalculateLinesPerScreen,
    createBuffer,
} from '$lib/stores/models';
import type { BufferData, ProtocolMessage, BufferLine } from '$lib/types';

// ---- Same mocks as flood.bench.ts (isolate store logic from DOM) ----
vi.mock('$lib/stores/settings', () => ({
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

vi.mock('$lib/notifications', () => ({
    createHighlight: vi.fn(),
    playNotificationSound: vi.fn(),
    updateTitle: vi.fn(),
    updateFavico: vi.fn(),
}));

vi.mock('$lib/windowFocus', () => ({
    initWindowFocusTracking: vi.fn(() => Promise.resolve(() => {})),
    isWindowFocused: () => true,
}));

vi.mock('$lib/stores/bufferResume', () => ({
    lastBufferId: {
        subscribe: (fn: (val: string) => void) => { fn(''); return () => {}; },
        set: vi.fn(),
    },
    recordLastBuffer: vi.fn(),
    shouldResume: vi.fn().mockReturnValue(false),
}));

const { handleLineInfo } = await import('$lib/stores/handlers');

// ---- Workload parameters ----
const HISTORY_LINES = 5000;
const BASE_EPOCH = 1_700_000_000_000; // fixed → deterministic timestamps
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
        message = `\x1912you \x19are mentioned in hist-${String(i).padStart(4, '0')}`;
        highlight = 1;
    } else if (r < 0.4) {
        message = `\x19${color}hist message ${String(i).padStart(4, '0')} colored \x19tail`;
    } else {
        message = `hist message ${String(i).padStart(4, '0')} the quick brown fox jumps over the lazy dog`;
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
        id: 20_000 + i
    };
}

/** Canonical snapshot of the TAIL of the buffer for output-identity checks. */
function snapshotTail(buf: BufferData, tail = 200): string {
    const lines = buf.lines.slice(-tail).map((l: BufferLine) => ({
        date: l.date,
        lineId: l.lineId,
        text: l.text,
        prefixtext: l.prefixtext,
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
        lineCount: buf.lines.length,
        lines,
        unread: buf.unread,
        notification: buf.notification,
        localUnread: buf.localUnread,
        lastSeen: buf.lastSeen,
        readBoundaryKnown: buf.readBoundaryKnown,
        readBoundaryId: buf.readBoundaryId,
        requestedLines: buf.requestedLines,
        active: buf.active
    });
}

describe('perf: history load benchmark', () => {
    beforeAll(() => {
        fs.mkdirSync('/tmp/gb-perf', { recursive: true });
        console.debug = () => {};
    });

    it(`load ${HISTORY_LINES} lines of history via handleLineInfo`, async () => {
        buffers.set({});
        activeBufferId.set('');
        recalculateLinesPerScreen(500);

        const rng = makeRng(777);
        const buffer = createBuffer({
            pointers: ['0xbench'],
            full_name: 'bench',
            short_name: 'bench',
            type: 2,
            notify: 3,
            local_variables: { type: 'channel', plugin: 'irc', server: 'irc.freenode.net' }
        });
        buffers.set({ [buffer.id]: buffer });
        activeBufferId.set(buffer.id);

        // WeeChat sends history NEWEST FIRST; mirror that ordering.
        const content = [];
        for (let i = 0; i < HISTORY_LINES; i++) {
            content.push(linePayload(HISTORY_LINES - 1 - i, rng));
        }
        const message = { objects: [{ pointer: buffer.id, content }] } as ProtocolMessage;

        const t0 = performance.now();
        handleLineInfo(message, true);
        const elapsed = performance.now() - t0;

        const finalBuf = get(buffers)[buffer.id]!;
        // The store trims to maxBufferLines (1000 here); all 5000 are still processed.
        expect(finalBuf.lines.length).toBeLessThanOrEqual(1000);
        expect(finalBuf.lines.length).toBeGreaterThan(0);
        // requestedLines counts all lines RECEIVED (skipped-but-trimmed ones included),
        // which is what the history re-fetch gates (requestedLines < 100) rely on.
        expect(finalBuf.requestedLines).toBe(HISTORY_LINES);

        const snap = snapshotTail(finalBuf);
        fs.writeFileSync('/tmp/gb-perf/history-snapshot.json', snap);
        const line = `H history ${HISTORY_LINES} lines ${elapsed.toFixed(1)}ms ${(elapsed / HISTORY_LINES).toFixed(3)}ms/line finalRows=${finalBuf.lines.length}`;
        fs.appendFileSync('/tmp/gb-perf/unit-results.txt', line + '\n');
        console.log(`[perf] ${line}`);
    }, 120000);
});
