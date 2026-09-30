/**
 * Diagnostic benchmark: where does flood time go inside the browser?
 *
 * Installs in-page instrumentation (long tasks, rAF count + frame gaps,
 * scroll events, row inserts) and counts WS frames via Playwright, then
 * runs the same 2000-message flood. Run with:
 *   npx playwright test --config src-svelte/e2e/playwright.bench.config.ts -g diag
 */
import { test, expect, WebSocket } from '@playwright/test';
import { createConnectedPage } from '../fixtures/auth';
import { switchToBuffer } from '../helpers/buffers';
import { irc } from '../helpers/irc-control';

const FLOOD_COUNT = 2000;
const CHANNEL = '#glowing-bear';

test('diag: flood time breakdown', async ({ browser }) => {
    const page = await createConnectedPage(browser, {
        initScript: `
            window.__perf = {
                active: false,
                longtasks: [],
                rafCount: 0,
                maxFrameGapMs: 0,
                frameGaps: [],
                lastRafT: 0,
                scrollEvents: 0,
                rowInserts: 0,
            };
            try {
                new PerformanceObserver((list) => {
                    if (!window.__perf.active) return;
                    for (const e of list.getEntries()) window.__perf.longtasks.push(Math.round(e.duration));
                }).observe({ entryTypes: ['longtask'] });
            } catch {}
            const origRaf = window.requestAnimationFrame;
            window.requestAnimationFrame = (cb) => {
                if (window.__perf.active) {
                    window.__perf.rafCount++;
                    const t = performance.now();
                    if (window.__perf.lastRafT > 0) {
                        const gap = t - window.__perf.lastRafT;
                        window.__perf.maxFrameGapMs = Math.max(window.__perf.maxFrameGapMs, gap);
                        window.__perf.frameGaps.push(gap);
                    }
                    window.__perf.lastRafT = t;
                }
                return origRaf(cb);
            };
            document.addEventListener('scroll', () => {
                if (window.__perf.active) window.__perf.scrollEvents++;
            }, true);
            const mo = new MutationObserver((muts) => {
                if (!window.__perf.active) return;
                for (const m of muts) {
                    for (const n of m.addedNodes) {
                        if (n.nodeType === 1 && n.classList && n.classList.contains('bufferline')) window.__perf.rowInserts++;
                    }
                }
            });
            if (document.documentElement) {
                mo.observe(document.documentElement, { childList: true, subtree: true });
            }
        `,
    });

    // Count WebSocket frames received by the page.
    let wsFrames = 0;
    const onWs = (ws: WebSocket) => ws.on('framereceived', () => { wsFrames++; });
    page.on('websocket', onWs);

    try {
        await switchToBuffer(page, CHANNEL);
        const rowSel = '[data-testid="bufferline-row"]';
        const baseRows = await page.locator(rowSel).count();

        wsFrames = 0;
        await page.evaluate(() => {
            const p = (window as any).__perf;
            p.active = true;
            p.frameGaps.length = 0;
            p.longtasks.length = 0;
            p.lastRafT = 0;
        });
        const t0 = Date.now();
        for (let i = 1; i <= FLOOD_COUNT; i++) {
            await irc.sendMessage(CHANNEL, `diag message ${String(i).padStart(4, '0')} over the lazy dog`);
        }
        const sendEnd = Date.now();
        const lastRow = page.locator('td.message[data-message*="diag message 2000"]').last();
        await expect(lastRow).toBeVisible({ timeout: 60000 });
        const tEnd = Date.now();
        await new Promise(r => setTimeout(r, 300));
        await page.evaluate(() => { (window as any).__perf.active = false; });

        const perf = await page.evaluate(() => {
            const p = (window as any).__perf;
            const gaps = p.frameGaps;
            const gapsSorted = [...gaps].sort((a: number, b: number) => a - b);
            const p50 = gapsSorted.length ? gapsSorted[Math.floor(gapsSorted.length / 2)] : 0;
            const p90 = gapsSorted.length ? gapsSorted[Math.floor(gapsSorted.length * 0.9)] : 0;
            const sum = gaps.reduce((a: number, b: number) => a + b, 0);
            const longSum = p.longtasks.reduce((a: number, b: number) => a + b, 0);
            return {
                longtaskCount: p.longtasks.length,
                longtaskTotalMs: longSum,
                longtaskMax: p.longtasks.length ? Math.max(...p.longtasks) : 0,
                rafCount: p.rafCount,
                frameGapP50: p50,
                frameGapP90: p90,
                frameGapMax: p.maxFrameGapMs,
                frameGapSumMs: Math.round(sum),
                scrollEvents: p.scrollEvents,
                rowInserts: p.rowInserts,
            };
        });
        console.log('[diag] ' + JSON.stringify({
            totalMs: tEnd - t0,
            sendMs: sendEnd - t0,
            renderAfterSendMs: tEnd - sendEnd,
            wsFramesReceived: wsFrames,
            baseRows,
            ...perf,
        }, null, 1));
        expect(perf.rafCount).toBeGreaterThan(0);
    } finally {
        page.off('websocket', onWs);
        await page.close();
    }
}, 300000);
