/**
 * Chat-walk benchmark and virtualisation equivalence gate.
 *
 * prodflood.bench.ts hashes the rows that happen to be in the DOM at the end of
 * a flood. That gate is exactly the wrong shape for a change that renders *fewer*
 * rows: such a change is expected to alter the DOM snapshot while leaving the
 * conversation identical. This bench asks the question a reader can actually
 * answer instead — "scroll from the oldest row to the newest and write down every
 * message you pass". A view that renders a window of the buffer must produce the
 * same ordered sequence as a view that renders all of it.
 *
 * It also measures what a virtualised view risks: scroll geometry. `scrollHeight`
 * is the scrollbar's length and the follow-pin's target, so a window that estimates
 * the height of rows it has not rendered shows up here as scrollHeight changing
 * while the reader moves, and as a walk that cannot reach the ends.
 *
 * Metrics per round:
 *   rows        distinct rows collected, in first-seen order
 *   steps       viewport steps taken from top to bottom
 *   heightDrift how many steps changed scrollHeight while the reader was mid-walk
 *   walkMs      wall time of the walk itself
 *   peakNodes   largest chat-container element count seen during the walk
 *   scriptMs / layoutMs / styleMs / taskMs  the browser's own buckets for the walk
 *
 * Run against the production build:
 *   npm run build && npx playwright test --config src-svelte/e2e/playwright.prodbench.config.ts -g prodwalk
 */
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { createConnectedPage } from '../fixtures/auth';
import { switchToBuffer } from '../helpers/buffers';
import { sendSequence } from '../helpers/irc-control';

const COUNT = Number(process.env.GB_E2E_WALK_COUNT ?? 2000);
const REPEATS = Number(process.env.GB_E2E_REPEATS ?? 3);
const CHANNEL = '#glowing-bear';
const SNAPSHOT_PATH =
    process.env.GB_E2E_WALK_SNAPSHOT ?? process.env.GB_E2E_SNAPSHOT ?? '/tmp/gb-perf/e2e-walk.json';

/**
 * Walk the chat container top → bottom inside the page and return every row the
 * reader passed, in first-seen order.
 *
 * The walk drives the container the way a reader does — by setting its scroll
 * position — and never asks the app to scroll anything. Rows are identified by the
 * element itself (a WeakMap), so a row that stays on screen across two steps is
 * counted once, and a row that is created and destroyed between steps is still
 * counted once.
 */
const WALK_IN_PAGE = `
(async (stepFraction) => {
    const container = document.querySelector('[data-testid="chat-messages"]');
    if (!container) return { error: 'no chat container' };
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
    const seen = new WeakMap();
    const out = [];
    let steps = 0;
    let heightDrift = 0;
    let peakNodes = 0;
    let lastScrollHeight = container.scrollHeight;

    const collect = () => {
        const nodes = container.querySelectorAll('[data-testid="bufferline-row"]');
        peakNodes = Math.max(peakNodes, container.querySelectorAll('*').length);
        for (const el of nodes) {
            if (seen.has(el)) continue;
            seen.set(el, true);
            out.push({
                p: el.querySelector('td.prefix')?.textContent?.trim() ?? '',
                m: el.querySelector('td.message')?.dataset?.message ??
                   el.querySelector('td.message')?.textContent?.trim() ?? '',
            });
        }
    };

    // Top first: a capped buffer scrolled to the tail is the normal state, and the
    // walk must reach the oldest row the client still holds.
    container.scrollTop = 0;
    await frame();
    await frame();
    collect();

    const clientHeight = container.clientHeight;
    const step = Math.max(40, Math.floor(clientHeight * stepFraction));
    for (let guard = 0; guard < 500; guard++) {
        const before = container.scrollTop;
        container.scrollTop = before + step;
        await frame();
        await frame();
        collect();
        steps++;
        if (container.scrollHeight !== lastScrollHeight) {
            // A height that moves under a reader who is only scrolling is an
            // estimate being corrected, not the reader moving.
            if (before > 0) heightDrift++;
            lastScrollHeight = container.scrollHeight;
        }
        if (container.scrollTop + container.clientHeight >= container.scrollHeight - 2) break;
        if (container.scrollTop <= before) break;
    }

    return {
        rows: out.length,
        steps,
        heightDrift,
        peakNodes,
        scrollHeight: container.scrollHeight,
        clientHeight,
        atBottom: container.scrollTop + container.clientHeight >= container.scrollHeight - 2,

        sequence: out,
    };
})(0.8)
`;

function median(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
}

test('prodwalk: scroll the whole buffer and hash what was passed', async ({ browser }) => {
    fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });

    const page = await createConnectedPage(browser);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    const metrics = async () => {
        const { metrics } = await cdp.send('Performance.getMetrics');
        const pick = (name: string) => metrics.find((m: { name: string }) => m.name === name)?.value ?? 0;
        return {
            layoutCount: pick('LayoutCount'),
            layoutMs: pick('LayoutDuration') * 1000,
            scriptMs: pick('ScriptDuration') * 1000,
            styleCount: pick('RecalcStyleCount'),
            styleMs: pick('RecalcStyleDuration') * 1000,
            taskMs: pick('TaskDuration') * 1000,
        };
    };

    interface Round {
        walkMs: number; rows: number; steps: number; heightDrift: number;
        peakNodes: number; scriptMs: number; layoutMs: number; layoutCount: number;
        styleMs: number; styleCount: number; taskMs: number;
    }
    const rounds: Round[] = [];
    let lastSequence: { p: string; m: string }[] = [];

    try {
        await switchToBuffer(page, CHANNEL);
        // Flood first so the buffer is at its line cap and the walk has a full
        // retained window to traverse — the state a capped channel is in.
        const tag = `w${Date.now()}`;
        await sendSequence(
            CHANNEL,
            Array.from({ length: COUNT }, (_, i) => `pw ${tag} ${String(i + 1).padStart(5, '0')} quick brown fox`),
        );
        // Let the flood finish rendering before measuring the walk.
        await page.waitForFunction(
            () => {
                const c = document.querySelector('[data-testid="chat-messages"]');
                if (!c) return false;
                return c.scrollTop + c.clientHeight >= c.scrollHeight - 2;
            },
            null,
            { timeout: 60000, polling: 100 },
        );

        for (let round = 0; round < REPEATS; round++) {
            const before = await metrics();
            const t0 = Date.now();
            const walk = await page.evaluate(WALK_IN_PAGE);
            const walkMs = Date.now() - t0;
            const after = await metrics();
            lastSequence = walk.sequence ?? [];
            const r: Round = {
                walkMs,
                rows: walk.rows,
                steps: walk.steps,
                heightDrift: walk.heightDrift,
                peakNodes: walk.peakNodes,
                scriptMs: after.scriptMs - before.scriptMs,
                layoutMs: after.layoutMs - before.layoutMs,
                layoutCount: after.layoutCount - before.layoutCount,
                styleMs: after.styleMs - before.styleMs,
                styleCount: after.styleCount - before.styleCount,
                taskMs: after.taskMs - before.taskMs,
            };
            rounds.push(r);
            const line =
                `walkMedian=${r.walkMs}ms rows=${r.rows} steps=${r.steps} heightDrift=${r.heightDrift} ` +
                `peakNodes=${r.peakNodes} scrollHeight=${walk.scrollHeight} clientHeight=${walk.clientHeight} ` +
                `atBottom=${walk.atBottom} scriptMs=${r.scriptMs.toFixed(0)} layoutMs=${r.layoutMs.toFixed(0)} ` +
                `layoutCount=${r.layoutCount} styleMs=${r.styleMs.toFixed(0)} styleCount=${r.styleCount} ` +
                `taskMs=${r.taskMs.toFixed(0)}`;
            console.log(`[prodwalk][round ${round}] ${line}`);
        }

        const med = (pick: (r: Round) => number) => median(rounds.map(pick));
        console.log(
            `[prodwalk] walkMedian=${med((r) => r.walkMs)}ms rows=${med((r) => r.rows)} ` +
            `peakNodes=${med((r) => r.peakNodes)} heightDrift=${med((r) => r.heightDrift)} ` +
            `scriptMs=${med((r) => r.scriptMs)} layoutMs=${med((r) => r.layoutMs)} ` +
            `layoutCount=${med((r) => r.layoutCount)} styleMs=${med((r) => r.styleMs)} ` +
            `styleCount=${med((r) => r.styleCount)} taskMs=${med((r) => r.taskMs)} ` +
            `snapshot=${SNAPSHOT_PATH}`,
        );

        fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(lastSequence));
        expect(walkOk(lastSequence, COUNT)).toBe(true);
    } finally {
        await cdp?.detach().catch(() => {});
        await page.close();
    }
}, 240000);


/**
 * The walk must have reached the tail of the flood. Only the retained window is
 * reachable — a capped buffer drops its oldest lines — so the assertion is on the
 * newest message being present, not on `COUNT`.
 */
function walkOk(sequence: { p: string; m: string }[], count: number): boolean {
    if (sequence.length === 0) return false;
    const tail = sequence[sequence.length - 1]?.m ?? '';
    return tail.includes(String(count).padStart(5, '0'));
}
