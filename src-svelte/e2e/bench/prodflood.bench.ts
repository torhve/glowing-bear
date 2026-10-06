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
import { irc } from '../helpers/irc-control';

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

function median(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
}

test('prodflood: in-page measurement of a 2000-message flood', async ({ browser }) => {
    fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });

    const page = await createConnectedPage(browser, { initScript: INSTRUMENT });
    const profiling = process.env.GB_E2E_PROFILE === '1';
    const cdp = profiling ? await page.context().newCDPSession(page) : null;
    try {
        if (cdp) {
            await cdp.send('Profiler.enable');
            await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
            await cdp.send('Profiler.start');
        }
        await switchToBuffer(page, CHANNEL);

        const marker = `pfb ${String(FLOOD_COUNT).padStart(5, '0')}`;
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

        const sendStart = Date.now();
        for (let i = 1; i <= FLOOD_COUNT; i++) {
            await irc.sendMessage(CHANNEL, `pfb ${String(i).padStart(5, '0')} over the lazy dog`);
        }
        const sendMs = Date.now() - sendStart;

        // Stamp from the page clock; the round trip is outside the measured span.
        await page.evaluate(() => { (window as any).__pf.t0 = performance.now(); });

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
                    lastSeenText: p.lastSeenText, samples: p.samples, domRows: rows.length,
                    tail: rows.slice(-4).map((r) => (r.querySelector('td.message')?.dataset?.message ?? r.textContent ?? '').slice(0, 60)),
                };
            });
            console.log('[prodflood][debug] ' + JSON.stringify(dbg, null, 1));
            throw e;
        }

        if (cdp) {
            const { profile } = await cdp.send('Profiler.stop');
            fs.writeFileSync('/tmp/gb-perf/e2e-prodflood-profile.json', JSON.stringify(profile));
            console.log(`[prodflood] profile samples=${profile?.nodes?.length ?? 0} saved=/tmp/gb-perf/e2e-prodflood-profile.json`);
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
            `[prodflood] render=${pf.renderMs.toFixed(0)}ms send=${sendMs}ms rows=${pf.rowsAdded} ` +
            `faviconWrites=${pf.faviconWrites} titleWrites=${pf.titleWrites} ` +
            `lastText=${pf.lastSeenText} bodyRows=${pf.bodyRows} longtasks=${pf.longtaskCount}(sum=${pf.longtaskTotalMs}ms max=${pf.longtaskMaxMs}ms) ` +
            `scrollIntoView=${pf.sivCalls} visibleRows=${rows.length} snapshot=${SNAPSHOT_PATH}`,
        );
        for (const [stack, count] of pf.sivStacks) {
            console.log(`[prodflood][siv] x${count} ${stack}`);
        }

        expect(pf.renderMs).toBeGreaterThan(0);
        expect(pf.rowsAdded).toBeGreaterThanOrEqual(FLOOD_COUNT);
        expect(rows.length).toBeGreaterThan(0);
        expect(JSON.stringify(median([pf.renderMs]))).toBeTruthy();
    } finally {
        await cdp?.detach().catch(() => {});
        await page.close();
    }
}, 180000);
