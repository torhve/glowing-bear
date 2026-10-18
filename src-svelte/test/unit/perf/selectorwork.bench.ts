/**
 * Performance benchmark: how much work a background message costs the app.
 *
 * Item 3 of the performance plan is about work that is *not needed*: traffic in a
 * buffer you are not looking at must not recompute the active conversation, the
 * sidebar order, or the search list. Wall-clock flood time cannot answer that —
 * relay delivery and the line pipeline dominate it — so this bench reports two
 * distinct kinds of evidence:
 *
 *   TIMING  (unit-results.txt)      median wall time per pass, production-shaped
 *                                   payloads, medians over GB_PERF_REPS passes.
 *   WORK COUNTS (unit-counts.txt)   how many times each reactive source published,
 *                                   per pass. Deterministic, not noisy, and the
 *                                   form a regression guard can assert on.
 *
 * A publication of `sortedVisibleBuffers` IS one filter+sort execution: the store
 * has no other reason to run. Publication counts are therefore work counts, and
 * they are measured by subscribing to the stores from outside — no instrumentation
 * is added to application source, and the same bench runs unchanged against a
 * baseline checkout.
 *
 * `P-*` stages are synthetic cost probes: the price of ONE sidebar recompute or
 * ONE unread aggregation at a given buffer count. Multiply by the publication
 * count to get the cost a selector would remove.
 *
 * Run with:  npx vitest run --config vitest.perf.config.ts
 * Scales:    GB_PERF_SCALES="25,100,500" (default)
 */
import { describe, it, beforeAll, expect } from 'vitest';
import { get } from 'svelte/store';
import fs from 'node:fs';
import {
    buffers,
    servers,
    activeBufferId,
    previousBufferId,
    currentBuffer,
    visibleBuffers,
    sortedVisibleBuffers,
    localUnreadBuffers,
    hotlistClearedBuffers,
    createBuffer,
    sortBuffers,
    getEffectiveUnread,
    recalculateLinesPerScreen,
    endSyncPhase,
    setActiveBuffer,
} from '#lib/stores/models.ts';
import { hotlistEntries, sidebarOrder, sidebarRows } from '#lib/stores/bufferProjections.ts';
import { badgeState, documentTitle } from '#lib/stores/indicatorState.ts';
import type { BufferData, ProtocolMessage } from '#lib/types.ts';
import { createApiStoreReducers, flushApiLineBatch } from '#lib/api/api-store-reducers.ts';
import type { LineSnapshot } from '#lib/api/api-contracts.ts';
import type { ApiBufferId, ApiLineId } from '#lib/api/api-ids.ts';

// ---- Same mocks as perf/flood.bench.ts (isolate store logic from DOM) ----
vi.mock('#lib/stores/settings.ts', () => ({
    settings: {
        subscribe: (fn: (val: unknown) => void) => {
            fn({
                hostField: '', port: '9001', tls: false, password: '',
                savepassword: false, autoconnect: false, useTotp: false,
                themeDark: 'dark', themeLight: 'light', fontfamily: '', fontsize: '', customCSS: '',
                iToken: '', iAlb: '', onlyUnread: false, noembed: false,
                alwaysnicklist: false, orderbyserver: false,
                readlineBindings: false, useFavico: true, soundnotification: false,
                enableMathjax: false, enableQuickKeys: false, showNicklist: true,
                showQuickKeys: false, showJumpKeys: false, highlightWords: '',
                hotlistsync: true,
            });
            return () => {};
        },
    },
    updateSettings: vi.fn(),
    updatePartialSettings: vi.fn(),
}));

// Title/favicon call counts are MOCKED platform-call counts: they count how often
// the app asked for a presentation update, not native title writes or badge draws.
// vi.hoisted because vi.mock factories are hoisted above these declarations.
const { mockUpdateTitle, mockUpdateFavico } = vi.hoisted(() => ({
    mockUpdateTitle: vi.fn(),
    mockUpdateFavico: vi.fn(),
}));
vi.mock('#lib/notifications.ts', () => ({
    createHighlight: vi.fn(),
    playNotificationSound: vi.fn(),
    updateTitle: mockUpdateTitle,
    updateFavico: mockUpdateFavico,
    startIndicatorOwner: () => () => {},
    refreshIndicators: vi.fn(),
}));

vi.mock('#lib/windowFocus.ts', () => ({
    initWindowFocusTracking: vi.fn(() => Promise.resolve(() => {})),
    isWindowFocused: () => true,
}));

vi.mock('#lib/stores/bufferResume.ts', () => ({
    lastBufferId: { subscribe: (fn: (val: string) => void) => { fn(''); return () => {}; }, set: vi.fn() },
    recordLastBuffer: vi.fn(),
    shouldResume: vi.fn().mockReturnValue(false),
}));

const {
    handleEvent,
    handleHotlistInfo,
    flushLineBatch,
} = await import('#lib/stores/handlers.ts');

/**
 * Deliver a batch the way the legacy transport does: each line arrives as its own
 * `_buffer_line_added` event through the dispatcher, which queues them and
 * flushes frame-aligned. Calling the flush explicitly stands in for the
 * animation-frame boundary, so one measured pass is one frame carrying N lines —
 * the shape a real burst produces, which calling the line handler directly would
 * not reproduce.
 */
function deliverFrame(messages: ProtocolMessage[]): void {
    for (const msg of messages) handleEvent(msg);
    flushLineBatch();
}

/** One `_buffer_line_added` event per line, as the protocol actually sends them. */
function frameLines(bufferId: string, count: number, startIdx: number, rng: () => number): ProtocolMessage[] {
    const out: ProtocolMessage[] = [];
    for (let i = 0; i < count; i++) {
        const p = linePayload(bufferId, startIdx + i, rng);
        out.push({
            id: '_buffer_line_added',
            objects: [{ pointer: bufferId, content: [p] }],
        } as unknown as ProtocolMessage);
    }
    return out;
}

const SCALES = (process.env.GB_PERF_SCALES ?? '25,100,500').split(',').map(Number);
/** Buffer count the `S100-*` and cost-probe stages use. */
const MID = 100;
const BATCHES = 10;
const BATCH_SIZE = 20;
const FLOODED_LINES = BATCHES * BATCH_SIZE;
const BASE_EPOCH = 1_700_000_000_000;
const REPS = Number(process.env.GB_PERF_REPS ?? 5);
const PROBE_PASSES = 2000;

const NICKS = ['alice', 'gbbot', 'carol', 'dave'];
const COLORS = ['01', '02', '03', '04', '05', '06', '07'];

function makeRng(seed: number) {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 0xffffffff;
    };
}

function makeBuffer(id: string, number: number): BufferData {
    return createBuffer({
        pointers: [id],
        full_name: `irc.gbtest.#perf${number}`,
        short_name: `#perf${number}`,
        type: 2,
        number,
        notify: 3,
        local_variables: { type: 'channel', plugin: 'irc', server: 'gbtest', channel: `#perf${number}` },
    });
}

function linePayload(bufferId: string, i: number, rng: () => number) {
    const nick = NICKS[Math.floor(rng() * NICKS.length)]!;
    const color = COLORS[Math.floor(rng() * COLORS.length)]!;
    const r = rng();
    let message: string;
    let highlight = 0;
    if (r < 0.05) {
        message = `\x1912you \x19are mentioned in perf-${String(i).padStart(4, '0')}`;
        highlight = 1;
    } else if (r < 0.4) {
        message = `\x19${color}background message ${String(i).padStart(4, '0')} colored \x19tail`;
    } else {
        message = `background message ${String(i).padStart(4, '0')} the quick brown fox jumps over the lazy dog`;
    }
    return {
        buffer: bufferId,
        date: BASE_EPOCH + i * 50,
        date_long: 0,
        prefix: `\x19${color}${nick}\x19`,
        message,
        tags_array: ['irc_privmsg', 'irc_msgtype', 'irc_msgtype_private'],
        displayed: 1,
        notify_level: highlight ? 3 : 1,
        highlight,
        id: 10_000 + i,
    };
}


function hotlistMessage(entries: { buffer: string; unread: number; notification?: number }[]): ProtocolMessage {
    return {
        objects: [{
            pointer: '0x0',
            content: entries.map((e) => ({ buffer: e.buffer, count: [0, e.unread, e.notification ?? 0, 0] })),
        }],
    } as unknown as ProtocolMessage;
}

function nickDiffMessage(bufferId: string, name: string, diff: number): ProtocolMessage {
    return {
        objects: [{
            pointer: bufferId,
            content: [{ pointers: [bufferId], prefix: '', visible: name, name, _diff: diff }],
        }],
    } as unknown as ProtocolMessage;
}

function renamedMessage(bufferId: string, label: string): ProtocolMessage {
    return {
        objects: [{
            pointer: bufferId,
            content: [{
                pointers: [bufferId],
                full_name: `irc.gbtest.#perf-${label}`,
                short_name: `#perf-${label}`,
                number: 1,
                type: 2,
                notify: 3,
                local_variables: { type: 'channel', plugin: 'irc', server: 'gbtest' },
            }],
        }],
    } as unknown as ProtocolMessage;
}

/** Seed `count` buffers; buffer 1 is the active one. */
function seed(count: number): { activeId: string; backgroundIds: string[] } {
    const map: Record<string, BufferData> = {};
    const ids: string[] = [];
    for (let i = 1; i <= count; i++) {
        const id = String(i);
        map[id] = makeBuffer(id, i);
        ids.push(id);
    }
    buffers.set(map);
    servers.set({ 'irc.gbtest': { id: '0x0', unread: 0 } });
    activeBufferId.set(ids[0]!);
    previousBufferId.set('');
    localUnreadBuffers.set(new Set());
    hotlistClearedBuffers.set(new Set());
    endSyncPhase();
    recalculateLinesPerScreen(500); // maxBufferLines = 1000 → no trimming in bench
    return { activeId: ids[0]!, backgroundIds: ids.slice(1) };
}

/**
 * Subscribe to every reactive source the sidebar and the chat view read, and count
 * publications. A publication of a derived store means its callback ran, so these
 * counts are the work counts the regression guards assert on.
 */
function openWorkMeter() {
    const counts = {
        currentBuffer: 0,
        visibleBuffers: 0,
        sortedVisibleBuffers: 0,
        buffers: 0,
        // The item-3 projections. `sidebarRows` is what the sidebar actually
        // subscribes to, so its count is the number of times a row could re-render;
        // `sidebarOrder` is the structural projection and counts re-sorts that
        // reached a consumer.
        sidebarRows: 0,
        sidebarOrder: 0,
        hotlistEntries: 0,
        // The indicator stores are the only path to the title and the badge, so
        // these counts replace the old `updateTitle`/`updateFavico` call counts:
        // a publication here means the value the user sees genuinely changed.
        documentTitle: 0,
        badgeState: 0,
    };
    const unsubs = [
        currentBuffer.subscribe(() => { counts.currentBuffer += 1; }),
        visibleBuffers.subscribe(() => { counts.visibleBuffers += 1; }),
        sortedVisibleBuffers.subscribe(() => { counts.sortedVisibleBuffers += 1; }),
        buffers.subscribe(() => { counts.buffers += 1; }),
        sidebarRows.subscribe(() => { counts.sidebarRows += 1; }),
        sidebarOrder.subscribe(() => { counts.sidebarOrder += 1; }),
        hotlistEntries.subscribe(() => { counts.hotlistEntries += 1; }),
        documentTitle.subscribe(() => { counts.documentTitle += 1; }),
        badgeState.subscribe(() => { counts.badgeState += 1; }),
    ];
    return {
        counts,
        close() { for (const u of unsubs) u(); },
    };
}

function median(values: number[]): number {
    const s = [...values].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)]!;
}

const TIMING: { key: string; median: number; min: number; max: number; extra: string }[] = [];
const WORK: { key: string; counts: Record<string, number>; extra: string }[] = [];

function reportTiming(key: string, reps: number[], extra = ''): void {
    const sorted = [...reps].sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)]!;
    const line = `${key} median ${med.toFixed(1)}ms min ${sorted[0]!.toFixed(1)} max ${sorted[sorted.length - 1]!.toFixed(1)} ${extra}`;
    TIMING.push({ key, median: med, min: sorted[0]!, max: sorted[sorted.length - 1]!, extra });
    fs.appendFileSync('/tmp/gb-perf/unit-results.txt', line + '\n');
    console.log(`[perf] ${line}`);
}

function reportWork(key: string, counts: Record<string, number>, extra = ''): void {
    const parts = Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ');
    const line = `${key} ${parts} ${extra}`.trim();
    WORK.push({ key, counts, extra });
    fs.appendFileSync('/tmp/gb-perf/unit-counts.txt', line + '\n');
    console.log(`[work] ${line}`);
}

/** Canonical final-state snapshot: unread totals, ordering, and line counts. */
function snapshotState(label: string): void {
    const map = get(buffers);
    const ids = Object.keys(map).sort();
    const state = {
        ids,
        order: get(sortedVisibleBuffers).map((b) => b.id),
        buffers: ids.map((id) => {
            const b = map[id]!;
            return {
                id,
                lines: b.lines.length,
                firstLine: b.lines[0]?.lineId ?? null,
                lastLine: b.lines[b.lines.length - 1]?.lineId ?? null,
                shortName: b.shortName,
                unread: b.unread,
                notification: b.notification,
                localUnread: b.localUnread,
                effectiveUnread: getEffectiveUnread(b),
                lastSeen: b.lastSeen,
                readBoundaryKnown: b.readBoundaryKnown,
                readBoundaryId: b.readBoundaryId ?? null,
                active: b.active,
                pinned: b.pinned,
                hidden: b.hidden,
                number: b.number,
            };
        }),
    };
    fs.writeFileSync(`/tmp/gb-perf/unit-snapshot-selector-${label}.json`, JSON.stringify(state));
}

beforeAll(() => {
    fs.mkdirSync('/tmp/gb-perf', { recursive: true });
    fs.writeFileSync('/tmp/gb-perf/unit-counts.txt', '');
    // Chrome's console.debug is a no-op in production; jsdom would write to the
    // stream, so match browser reality (arguments are still evaluated).
    console.debug = () => {};
});

describe('perf: background traffic work', () => {
    /**
     * Run `body` REPS times, timing each pass and counting publications on the last
     * pass (counts are deterministic; timing needs the median).
     */
    async function measure(
        key: string,
        scale: number,
        body: (seeded: { activeId: string; backgroundIds: string[] }, rng: () => number) => void,
        extra = '',
    ): Promise<void> {
        const reps: number[] = [];
        let workCounts: Record<string, number> = {};
        for (let rep = 0; rep < REPS; rep++) {
            const seeded = seed(scale);
            const rng = makeRng(7717 + rep);
            const meter = openWorkMeter();
            const last = rep === REPS - 1;
            // Work counts are read from the final pass only, so every number in
            // unit-counts.txt describes the same pass the snapshot was taken from.
            if (last) {
                mockUpdateTitle.mockClear();
                mockUpdateFavico.mockClear();
            }
            const t0 = performance.now();
            body(seeded, rng);
            flushLineBatch();
            flushApiLineBatch();
            reps.push(performance.now() - t0);
            if (last) {
                workCounts = {
                    ...meter.counts,
                    updateTitleCalls: mockUpdateTitle.mock.calls.length,
                    updateFavicoCalls: mockUpdateFavico.mock.calls.length,
                };
                snapshotState(key.replace(/[^A-Za-z0-9-]/g, '_'));
            }
            meter.close();
        }
        reportWork(key, workCounts, extra);
        reportTiming(key, reps, `scale=${scale} ${extra}`.trim());
    }

    it('S-bg: flood one background buffer at 25/100/500 buffers', async () => {
        for (const scale of SCALES) {
            await measure(`S${scale}-bg`, scale, (s, rng) => {
                for (let b = 0; b < BATCHES; b++) {
                    deliverFrame(frameLines(s.backgroundIds[0]!, BATCH_SIZE, b * BATCH_SIZE, rng));
                }
            }, 'transport=legacy target=background');
        }
    }, 180000);

    it('S-multi: distribute the same traffic across ten background buffers', async () => {
        await measure('S100-multi', MID, (s, rng) => {
            let idx = 0;
            for (let b = 0; b < BATCHES; b++) {
                const msgs: ProtocolMessage[] = [];
                for (let k = 0; k < 10; k++) {
                    msgs.push(...frameLines(s.backgroundIds[k]!, BATCH_SIZE, idx * BATCH_SIZE, rng));
                    idx++;
                }
                deliverFrame(msgs);
            }
        }, 'transport=legacy target=10-background lines=2000');
    }, 180000);

    it('S-active: flood the visible buffer (regression control)', async () => {
        await measure('S100-active', MID, (s, rng) => {
            for (let b = 0; b < BATCHES; b++) {
                deliverFrame(frameLines(s.activeId, BATCH_SIZE, b * BATCH_SIZE, rng));
            }
        }, 'transport=legacy target=active');
    }, 180000);

    it('S-hotlist: repeated hotlist snapshots that change nothing', async () => {
        await measure('S100-hotlist', MID, (s) => {
            for (let i = 0; i < 20; i++) handleHotlistInfo(hotlistMessage([]));
        }, 'transport=legacy events=20 snapshots');
    }, 120000);

    it('S-nick: nicklist diffs in a background buffer', async () => {
        await measure('S100-nick', MID, (s) => {
            for (let i = 0; i < 20; i++) {
                handleEvent({ id: '_nicklist_diff', objects: nickDiffMessage(s.backgroundIds[0]!, `nick${i}`, 43).objects } as unknown as ProtocolMessage);
            }
        }, 'transport=legacy events=20 nicks');
    }, 120000);

    it('S-meta: rename events on a background buffer', async () => {
        await measure('S100-meta', MID, (s) => {
            for (let i = 0; i < 20; i++) {
                handleEvent({ id: '_buffer_renamed', objects: renamedMessage(s.backgroundIds[0]!, String(i)).objects } as unknown as ProtocolMessage);
            }
        }, 'transport=legacy events=20 renames');
    }, 120000);

    it('A-bg: the same background flood over the API transport', async () => {
        const reducers = createApiStoreReducers();
        await measure('A100-bg', MID, (s, rng) => {
            const apiId = Number(s.backgroundIds[0]) as ApiBufferId;
            for (let i = 0; i < FLOODED_LINES; i++) {
                const p = linePayload(s.backgroundIds[0]!, i, rng);
                const line: LineSnapshot = {
                    id: (20_000 + i) as ApiLineId,
                    epochMs: p.date,
                    displayed: true,
                    highlight: p.highlight === 1,
                    notifyLevel: p.notify_level,
                    prefix: p.prefix,
                    message: p.message,
                    tags: p.tags_array,
                };
                reducers.lineAdded(apiId, line);
            }
        }, 'transport=api target=background');
    }, 180000);

    it('A-hotlist: API hotlist snapshots that change nothing', async () => {
        const reducers = createApiStoreReducers();
        await measure('A100-hotlist', MID, (s) => {
            const apiId = Number(s.backgroundIds[0]) as ApiBufferId;
            for (let i = 0; i < 20; i++) {
                reducers.hotlist(new Map([[apiId, {
                    priority: 2,
                    date: '2026-10-08T12:00:00.000Z',
                    counts: { low: 0, message: 0, private: 0, highlight: 0 },
                }]]));
            }
        }, 'transport=api events=20 snapshots');
    }, 120000);
});

describe('perf: cost of one recompute (synthetic probes)', () => {
    /**
     * Time a block of PROBE_PASSES recomputes. A single sidebar recompute is
     * sub-microsecond at these scales, so a per-call median would print 0.0 and
     * hide the signal; the block median is comparable across arms and the
     * per-recompute cost is derived from it.
     */
    function probeBlocks(run: () => void): number[] {
        const blocks: number[] = [];
        for (let rep = 0; rep < REPS; rep++) {
            const t0 = performance.now();
            for (let i = 0; i < PROBE_PASSES; i++) run();
            blocks.push(performance.now() - t0);
        }
        return blocks;
    }

    /** Per-recompute cost derived from the block median. */
    function probeExtra(blocks: number[]): string {
        const med = median(blocks);
        return `block=${PROBE_PASSES} recomputes perCall=${((med * 1000) / PROBE_PASSES).toFixed(2)}us synthetic=1 recompute`;
    }

    it('P-sort: one sidebar filter+sort at each scale', async () => {
        for (const scale of SCALES) {
            seed(scale);
            const meter = openWorkMeter();
            let seen = 0;
            const blocks = probeBlocks(() => {
                seen = sortBuffers(Object.values(get(buffers)).filter((b) => !b.hidden), false).length;
            });
            meter.close();
            expect(seen).toBe(scale);
            reportTiming(`P${scale}-sort`, blocks, probeExtra(blocks));
        }
    }, 120000);

    /**
     * Probes for the two consumers that were the next candidates.
     *
     * Both are component-internal `$derived` bodies, so the probe reproduces the
     * expression rather than importing the component. What matters is the cost of
     * ONE recompute multiplied by how often the store feeding it publishes —
     * `currentBuffer` for the nicklist, `visibleBuffers` for the search dialog —
     * and those publication counts are measured by the flood stages above.
     */
    it('P-nick: one nicklist group+filter at each nick count', async () => {
        seed(MID);
        const activeId = get(activeBufferId);
        for (const nickCount of [4, 50, 300]) {
            const groups: Record<string, { name: string; nicks: Array<{ name: string; color: string }> }> = {
                root: { name: 'root', nicks: [] },
                irc: { name: 'irc', nicks: [] },
            };
            for (let i = 0; i < nickCount; i++) {
                groups.irc!.nicks.push({ name: `nick${String(i).padStart(4, '0')}`, color: '01' });
            }
            const buf = get(buffers)[activeId]!;
            buf.nicklist = groups as never;
            let seen = 0;
            const blocks = probeBlocks(() => {
                const nicklist = get(buffers)[activeId]!.nicklist as unknown as Record<string, { nicks: Array<{ name: string }> }>;
                // The query must NOT match a group name: matching one lets
                // `some()` short-circuit and the probe measures nothing. This is
                // the case where the filter really walks every nick.
                seen = (Object.entries(nicklist) as [string, { nicks: Array<{ name: string }> }][])
                    .filter(([_name, group]) => group.nicks.some((n) => n.name.toLowerCase().includes('zzz-no-match')))
                    .sort((a, b) => (a[0] === 'root' ? -1 : b[0] === 'root' ? 1 : 0))
                    .length;
            });
            // A no-match query legitimately filters every group out; the probe
            // exists to measure the walk, not to prove a non-empty result.
            expect(seen).toBe(0);
            reportTiming(`Pnick${nickCount}`, blocks, `${probeExtra(blocks)} nicks=${nickCount} query=no-match`);
        }
    }, 120000);

    it('P-search: one buffer-search filter at each scale', async () => {
        for (const scale of SCALES) {
            seed(scale);
            let seen = 0;
            // The query matches every buffer, which is the expensive case: the
            // filter does the full scan and keeps everything.
            const blocks = probeBlocks(() => {
                seen = Object.values(get(buffers))
                    .filter((b) => !b.hidden)
                    .filter((b) =>
                        b.shortName.toLowerCase().includes('perf') ||
                        b.fullName.toLowerCase().includes('perf') ||
                        (b.rtitle || '').toLowerCase().includes('perf') ||
                        String(b.number).includes('perf'))
                    .length;
            });
            expect(seen).toBe(scale);
            reportTiming(`P${scale}-search`, blocks, `${probeExtra(blocks)} query=all-match`);
        }
    }, 120000);

    it('P-title: one global unread aggregation at each scale', async () => {
        for (const scale of SCALES) {
            seed(scale);
            let total = 0;
            const blocks = probeBlocks(() => {
                const map = get(buffers);
                total = 0;
                for (const id in map) total += getEffectiveUnread(map[id]!);
            });
            expect(total).toBeGreaterThanOrEqual(0);
            reportTiming(`P${scale}-title`, blocks, probeExtra(blocks));
        }
    }, 120000);
});
