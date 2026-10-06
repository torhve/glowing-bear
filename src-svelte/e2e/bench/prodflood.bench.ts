/**
 * Production-pipeline flood benchmark, measured inside the page.
 *
 * Why this exists next to flood.bench.ts:
 *
 * 1. flood.bench.ts measures with Playwright polling — `locator.count()` in a
 *    loop and `expect(row).toBeVisible()`. A CPU profile of that run showed
 *    `scrollIntoView` at 48% of all samples, which is Playwright's own
 *    actionability scrolling, not the app. This bench records the moment the
 *    final row appears with an in-page MutationObserver, so Playwright never
 *    touches the page during the measured window.
 * 2. It counts the side effects the app actually performs per batch — favicon
 *    `href` writes and `document.title` writes — so a coalescing win is visible
 *    as a count, not only as a timing difference.
 *
 * Run against the production build:
 *   npm run build && npx playwright test --config src-svelte/e2e/playwright.prodbench.config.ts -g prodflood
 */
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { createConnectedPage } from '../fixtures/auth';
import { switchToBuffer } from '../helpers/buffers';
import { irc, sendSequence } from '../helpers/irc-control';

const FLOOD_COUNT = Number(process.env.GB_E2E_FLOOD_COUNT ?? 2000);
const CHANNEL = '#glowing-bear';
const SNAPSHOT_PATH = process.env.GB_E2E_SNAPSHOT ?? '/tmp/gb-perf/e2e-prodflood-rows.json';

/** Installed before any app script runs; observes the page, never drives it. */
const INSTRUMENT = `
window.__pf = { marker: '', t0: 0, tLast: 0, rowsAdded: 0, faviconWrites: 0, titleWrites: 0, longtasks: [], sivCalls: 0, sivSamples: 0, sivStacks: {} };
(function () {
    // Who actually calls scrollIntoView? The CPU profile shows it as an
    // unattributed native root, so wrap it and keep a stack histogram.
    const orig = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function () {
        window.__pf.sivCalls++;
        if (window.__pf.sivSamples < 400) {
            window.__pf.sivSamples++;
            const st = (new Error().stack || '').split(String.fromCharCode(10)).slice(1, 5).join(' | ');
            window.__pf.sivStacks[st] = (window.__pf.sivStacks[st] || 0) + 1;
        }
        return orig.apply(this, arguments);
    };
})();
(function () {
    const isFaviconLink = (n) => n.nodeType === 1 && n.tagName === 'LINK' &&
        (n.rel || '').toLowerCase().includes('icon');
    const isTitle = (n) => n.nodeType === 1 && n.tagName === 'TITLE';
    const note = (n) => {
        if (!n) return;
        if (isFaviconLink(n)) window.__pf.faviconWrites++;
        else if (isTitle(n) || (n.parentNode && isTitle(n.parentNode))) window.__pf.titleWrites++;
    };
    const headObs = new MutationObserver((muts) => {
        for (const m of muts) {
            if (m.type === 'attributes' && m.attributeName === 'href') note(m.target);
            else if (m.type === 'characterData') note(m.target.parentNode);
            else if (m.type === 'childList') {
                for (const n of m.addedNodes) if (isTitle(n)) window.__pf.titleWrites++;
            }
        }
    });


    const rowObs = new MutationObserver((muts) => {
        const pf = window.__pf;
        for (const m of muts) {
            for (const n of m.addedNodes) {
                if (n.nodeType !== 1) continue;
                if (!n.matches || !n.matches('[data-testid="bufferline-row"]')) continue;
                pf.rowsAdded++;
                if (pf.tLast || !pf.marker) continue;
                const cell = n.querySelector('td.message');
                const text = (cell && (cell.textContent || (cell.dataset && cell.dataset.message))) || '';
                if (text.indexOf(pf.marker) >= 0) pf.tLast = performance.now();
            }
        }
    });
    // Observe the whole subtree from documentElement: Svelte can replace a tbody
    // or a table node (an observer pinned to one would silently stop seeing
    // rows), and document.body does not exist yet in an addInitScript.
    const root = document.documentElement || document;
    rowObs.observe(root, { childList: true, subtree: true });
    headObs.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['href'] });

    try {
        new PerformanceObserver((list) => {
            for (const e of list.getEntries()) window.__pf.longtasks.push(Math.round(e.duration));
        }).observe({ entryTypes: ['longtask'] });
    } catch { /* longtask observer unsupported */ }
})();
`;

/** The flood payload for one round, in delivery order. */
function floodTexts(tag: string): string[] {
    const out: string[] = [];
    for (let i = 1; i <= FLOOD_COUNT; i++) {
        out.push(`pfb ${tag} ${String(i).padStart(5, '0')} over the lazy dog`);
    }
    return out;
}

function median(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
}

test('prodflood: in-page measurement of a 2000-message flood', async ({ browser }) => {
    fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });

    const page = await createConnectedPage(browser, { initScript: INSTRUMENT });
    const profiling = process.env.GB_E2E_PROFILE === '1';
    const cdp = await page.context().newCDPSession(page);
    // Layout counts come from the browser, so "the follow effect forces a layout
    // per batch" can be measured rather than inferred from CPU samples.
    await cdp.send('Performance.enable');
    const layoutMetrics = async (): Promise<{ count: number; durationMs: number; scriptMs: number }> => {
        const { metrics } = await cdp.send('Performance.getMetrics');
        const pick = (name: string) => metrics.find((m: { name: string }) => m.name === name)?.value ?? 0;
        // ScriptDuration is the browser's own tally of main-thread JavaScript time.
        // A change that only removes store-pipeline work barely moves wall time at
        // 2000 messages, so this is the metric that can actually see it.
        return {
            count: pick('LayoutCount'),
            durationMs: pick('LayoutDuration') * 1000,
            scriptMs: pick('ScriptDuration') * 1000,
        };
    };
    try {
        if (cdp) {
            await cdp.send('Profiler.enable');
            await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
            await cdp.send('Profiler.start');
        }
        // The flood lands on the buffer being rendered, which is what makes the
        // row timing measurable. But a client with nothing unread never draws a
        // badge, so without a holder buffer this workload silently skips the
        // unread/title/favicon path that a real flood exercises. Leaving one
        // unread elsewhere keeps the total non-zero for the whole run.
        const UNREAD_HOLDER = process.env.GB_E2E_UNREAD_HOLDER ?? '';
        await switchToBuffer(page, CHANNEL);
        if (UNREAD_HOLDER) {
            // A private message from the bot opens a query buffer WeeChat is not
            // looking at, so it stays unread for the whole run and the
            // unread/title/favicon path stays live. Sending to a channel would
            // land in the buffer on screen and be read immediately.
            await irc.raw(`PRIVMSG ${UNREAD_HOLDER} :pfb holder ${Date.now()}`);
        }

        // One flood per arm is far too noisy to resolve anything under ~30%:
        // baseline arms of the same build have measured anywhere from 550 ms to
        // 1400 ms. Several floods in the same page give the comparison a median
        // to stand on without paying page setup again.
        const REPEATS = Number(process.env.GB_E2E_REPEATS ?? 3);
        const renders: number[] = [];
        const sends: number[] = [];
        const layoutTotals: { layouts: number; layoutMs: number; scriptMs: number }[] = [];
        let last: any = {};

        for (let round = 0; round < REPEATS; round++) {
            // Unique per round: tLast only stamps on a row that has not been
            // seen yet, so the marker must be a message this page has not had.
            const tag = `r${round}`;
            const marker = `pfb ${tag} ${String(FLOOD_COUNT).padStart(5, '0')}`;
            await page.evaluate((m: string) => {
                const pf = (window as any).__pf;
                pf.marker = m;
                pf.tLast = 0;
                pf.rowsAdded = 0;
                pf.faviconWrites = 0;
                pf.titleWrites = 0;
                pf.longtasks = [];
                pf.sivCalls = 0;
                pf.sivStacks = {};
                pf.sivSamples = 0;
            }, marker);

            // t0 is stamped before the flood is sent, so the measured span is the
            // user-visible one: first message in, last row on screen. Sending is
            // now fast enough (~120 ms) that stamping after it would quietly drop
            // the first slice of the app's own work from the window.
            const layoutsBefore = await layoutMetrics();
            await page.evaluate(() => { (window as any).__pf.t0 = performance.now(); });
            const sendStart = Date.now();
            await sendSequence(CHANNEL, floodTexts(tag));
            sends.push(Date.now() - sendStart);

            try {
                await page.waitForFunction(
                    () => (window as any).__pf.tLast > 0,
                    null,
                    { timeout: Number(process.env.GB_E2E_WAIT_MS ?? 90000), polling: 50 },
                );
            } catch (e) {
                const dbg = await page.evaluate(() => {
                    const p = (window as any).__pf;
                    const rows = Array.from(document.querySelectorAll('[data-testid="bufferline-row"]'));
                    return {
                        marker: p.marker, t0: p.t0, tLast: p.tLast, rowsAdded: p.rowsAdded,
                        lastSeenText: p.lastSeenText, domRows: rows.length,
                        tail: rows.slice(-4).map((r) => (r.querySelector('td.message')?.dataset?.message ?? r.textContent ?? '').slice(0, 60)),
                    };
                });
                console.log('[prodflood][debug] ' + JSON.stringify(dbg, null, 1));
                throw e;
            }

            const pf = await page.evaluate(() => {
                const p = (window as any).__pf;
                return {
                    renderMs: p.tLast - p.t0,
                    rowsAdded: p.rowsAdded,
                    lastSeenText: p.lastSeenText,
                    bodyRows: document.querySelectorAll('[data-testid="bufferline-row"]').length,
                    faviconWrites: p.faviconWrites,
                    titleWrites: p.titleWrites,
                    longtaskCount: p.longtasks.length,
                    longtaskTotalMs: p.longtasks.reduce((s: number, v: number) => s + v, 0),
                    longtaskMaxMs: p.longtasks.reduce((m: number, v: number) => Math.max(m, v), 0),
                    sivCalls: p.sivCalls,
                    sivStacks: Object.entries(p.sivStacks).sort((a, b) => b[1] - a[1]).slice(0, 5),
                };
            });
            const layoutsAfter = await layoutMetrics();
            const layouts = layoutsAfter.count - layoutsBefore.count;
            const layoutMs = layoutsAfter.durationMs - layoutsBefore.durationMs;
            const scriptMs = layoutsAfter.scriptMs - layoutsBefore.scriptMs;
            layoutTotals.push({ layouts, layoutMs, scriptMs });

            renders.push(pf.renderMs);
            last = pf;
            console.log(
                `[prodflood][round ${round}] render=${pf.renderMs.toFixed(0)}ms send=${sends[round]}ms ` +
                `rows=${pf.rowsAdded} faviconWrites=${pf.faviconWrites} scrollIntoView=${pf.sivCalls} ` +
                `layouts=${layouts} layoutMs=${layoutMs.toFixed(0)} scriptMs=${scriptMs.toFixed(0)}`,
            );
        }

        if (cdp) {
            const { profile } = await cdp.send('Profiler.stop');
            fs.writeFileSync('/tmp/gb-perf/e2e-prodflood-profile.json', JSON.stringify(profile));
            console.log(`[prodflood] profile samples=${profile?.nodes?.length ?? 0} saved=/tmp/gb-perf/e2e-prodflood-profile.json`);
        }

        // Output identity: the visible rows, prefix + message, in DOM order.
        const rows = await page.evaluate(() => {
            const out: { p: string; m: string }[] = [];
            for (const el of Array.from(document.querySelectorAll('[data-testid="bufferline-row"]'))) {
                const tr = el as HTMLElement;
                out.push({
                    p: tr.querySelector('td.prefix')?.textContent?.trim() ?? '',
                    m: tr.querySelector('td.message')?.dataset?.message ?? tr.querySelector('td.message')?.textContent?.trim() ?? '',
                });
            }
            return out;
        });
        fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(rows));

        console.log(
            `[prodflood] renderMedian=${median(renders).toFixed(0)}ms ` +
            `renderMin=${Math.min(...renders).toFixed(0)}ms renderMax=${Math.max(...renders).toFixed(0)}ms ` +
            `rounds=${renders.map((r) => r.toFixed(0)).join(',')} sendMedian=${median(sends).toFixed(0)}ms ` +
            `rows=${last.rowsAdded} faviconWrites=${last.faviconWrites} titleWrites=${last.titleWrites} ` +
            `longtasks=${last.longtaskCount}(sum=${last.longtaskTotalMs}ms max=${last.longtaskMaxMs}ms) ` +
            `scrollIntoView=${last.sivCalls} bodyRows=${last.bodyRows} visibleRows=${rows.length} ` +
            `layouts=${layoutTotals.reduce((t, r) => t + r.layouts, 0)} ` +
            `layoutMs=${layoutTotals.reduce((t, r) => t + r.layoutMs, 0).toFixed(0)} ` +
            `scriptMs=${layoutTotals.reduce((t, r) => t + r.scriptMs, 0).toFixed(0)} snapshot=${SNAPSHOT_PATH}`,
        );
        for (const [stack, count] of (last.sivStacks ?? [])) {
            console.log(`[prodflood][siv] x${count} ${stack}`);
        }

        expect(median(renders)).toBeGreaterThan(0);
        expect(last.rowsAdded).toBeGreaterThanOrEqual(FLOOD_COUNT);
        expect(rows.length).toBeGreaterThan(0);
    } finally {
        await cdp?.detach().catch(() => {});
        await page.close();
    }
}, 180000);
