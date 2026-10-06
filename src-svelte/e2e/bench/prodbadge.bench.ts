/**
 * Production badge benchmark: a flood that lands on a buffer you are NOT looking at.
 *
 * The flood benchmark renders the buffer the messages arrive in, which is what
 * makes row timing measurable — but a message read the moment it arrives is not
 * unread, so the whole unread/title/favicon path takes its no-badge exit and the
 * badge cost is invisible. This bench keeps `#glowing-bear` off screen while it
 * floods, so every batch raises the unread total and redraws the badge.
 *
 * Completion is read from `document.title`, which `updateTitle()` renders as
 * `(N) Glowing Bear - <buffer>` — a user-visible number rather than an internal
 * counter.
 *
 * Run through src-svelte/e2e/playwright.prodbench.config.ts.
 *   GB_E2E_BADGE_COUNT=2000 GB_E2E_REPEATS=3 GB_E2E_PROFILE=1
 */
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { createConnectedPage } from '../fixtures/auth';
import { switchToBuffer } from '../helpers/buffers';
import { sendSequence } from '../helpers/irc-control';

const COUNT = Number(process.env.GB_E2E_BADGE_COUNT ?? 2000);
const FLOOD_CHANNEL = '#glowing-bear';
/** The buffer kept on screen while the flood arrives elsewhere. */
const VIEW_BUFFER = process.env.GB_E2E_VIEW_BUFFER ?? 'gbtest';
const SNAPSHOT_PATH = process.env.GB_E2E_SNAPSHOT ?? '/tmp/gb-perf/e2e-prodbadge-snapshot.json';

const INSTRUMENT = `(() => {
    window.__pb = { faviconWrites: 0, titleWrites: 0, hrefs: [], distinct: {}, longtasks: [] };
    const isFavicon = (n) => n.nodeType === 1 && n.tagName === 'LINK'
        && (n.getAttribute('rel') || '').toLowerCase() === 'icon';
    const isTitle = (n) => n.nodeType === 1 && n.tagName === 'TITLE';

    const obs = new MutationObserver((muts) => {
        const pb = window.__pb;
        for (const m of muts) {
            if (m.type === 'attributes' && isFavicon(m.target)) {
                pb.faviconWrites++;
                // Count distinct href values, not just writes: if a redraw
                // produces the same bytes the browser records nothing, so the
                // distinct count is what tells us how many draws were actually
                // different pictures rather than how many times we asked.
                const href = String(m.target.getAttribute('href') || '');
                if (!pb.distinct[href]) pb.distinct[href] = 0;
                pb.distinct[href]++;
                if (pb.hrefs.length < 4) pb.hrefs.push(href.slice(0, 40));
            }
            else if (m.type === 'childList') {
                for (const n of m.addedNodes) if (isTitle(n)) pb.titleWrites++;
            }
        }
    });
    obs.observe(document.documentElement || document, {
        subtree: true, childList: true, attributes: true, attributeFilter: ['href'],
    });

    try {
        new PerformanceObserver((list) => {
            for (const e of list.getEntries()) window.__pb.longtasks.push(Math.round(e.duration));
        }).observe({ entryTypes: ['longtask'] });
    } catch { /* longtask observer unsupported */ }
})();`;

/** Read the `(N)` prefix `updateTitle()` writes, or null when there is none. */
async function titleUnread(page: import('@playwright/test').Page): Promise<number | null> {
    return page.evaluate(() => {
        const m = /^\((\d+)\)/.exec(document.title);
        return m ? Number(m[1]) : null;
    });
}

function median(values: number[]): number {
    const s = [...values].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
}

function texts(tag: string): string[] {
    const out: string[] = [];
    for (let i = 1; i <= COUNT; i++) {
        out.push(`pbb ${tag} ${String(i).padStart(5, '0')} over the lazy dog`);
    }
    return out;
}

test('prodbadge: unread badge redraw cost of a 2000-message flood to another buffer', async ({ browser }) => {
    test.setTimeout(240000);
    fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });

    const page = await createConnectedPage(browser, { initScript: INSTRUMENT });
    const profiling = process.env.GB_E2E_PROFILE === '1';
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    const layoutMetrics = async (): Promise<{ count: number; durationMs: number }> => {
        const { metrics } = await cdp.send('Performance.getMetrics');
        const pick = (name: string) => metrics.find((m: { name: string }) => m.name === name)?.value ?? 0;
        return { count: pick('LayoutCount'), durationMs: pick('LayoutDuration') * 1000 };
    };

    try {
        // Keep the flood buffer off screen for the whole run.
        await switchToBuffer(page, VIEW_BUFFER);
        await page.waitForFunction(
            () => document.title.indexOf('Glowing Bear') >= 0,
            null, { timeout: 30000, polling: 100 },
        );

        const REPEATS = Number(process.env.GB_E2E_REPEATS ?? 3);
        const elapsed: number[] = [];
        const sends: number[] = [];
        let last: any = {};

        for (let round = 0; round < REPEATS; round++) {
            const tag = `b${round}`;

            // Reset to a known unread state. The badge cost depends on how many
            // *different* pictures the flood produces, and a round that starts at
            // 2000 unread produces far fewer than one that starts at zero. Without
            // this, round 2 of an arm measures a different workload than round 1,
            // and an A/B compares an arm against itself.
            await switchToBuffer(page, FLOOD_CHANNEL);
            await switchToBuffer(page, VIEW_BUFFER);
            const before = await titleUnread(page);
            await page.evaluate(() => {
                const pb = window.__pb;
                pb.faviconWrites = 0;
                pb.titleWrites = 0;
                pb.hrefs = [];
                pb.longtasks = [];
            });

            if (profiling) {
                await cdp.send('Profiler.enable');
                await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
                await cdp.send('Profiler.start');
            }

            const layoutsBefore = await layoutMetrics();
            const start = Date.now();
            await sendSequence(FLOOD_CHANNEL, texts(tag));
            sends.push(Date.now() - start);

            // Wait for the app to report this round's unread total in the title.
            let seen = 0;
            try {
                await page.waitForFunction(
                    (n: number) => {
                        const m = /^\((\d+)\)/.exec(document.title);
                        return !!m && Number(m[1]) >= n;
                    },
                    COUNT,
                    { timeout: Number(process.env.GB_E2E_WAIT_MS ?? 120000), polling: 50 },
                );
                seen = await titleUnread(page);
            } catch {
                seen = await titleUnread(page);
                console.log(`[prodbadge][round ${round}] title never reached ${COUNT}; got ${seen}`);
            }
            const ms = Date.now() - start;

            if (profiling) {
                const { profile } = await cdp.send('Profiler.stop');
                fs.writeFileSync('/tmp/gb-perf/e2e-prodbadge-profile.json', JSON.stringify(profile));
                console.log(`[prodbadge] profile samples=${profile?.nodes?.length ?? 0} saved=/tmp/gb-perf/e2e-prodbadge-profile.json`);
            }

            const layoutsAfter = await layoutMetrics();
            const pb = await page.evaluate(() => {
                const p = window.__pb;
                return {
                    faviconWrites: p.faviconWrites,
                    distinctHrefs: Object.keys(p.distinct).length,
                    titleWrites: p.titleWrites,
                    hrefs: p.hrefs,
                    longtaskCount: p.longtasks.length,
                    longtaskTotalMs: p.longtasks.reduce((s: number, v: number) => s + v, 0),
                    title: document.title,
                };
            });
            last = { ...pb, seen };

            elapsed.push(ms);
            console.log(
                `[prodbadge][round ${round}] elapsed=${ms}ms send=${sends[round]}ms unreadBefore=${before} unread=${seen} ` +
                `faviconWrites=${pb.faviconWrites} distinctHrefs=${pb.distinctHrefs} titleWrites=${pb.titleWrites} ` +
                `layouts=${layoutsAfter.count - layoutsBefore.count} layoutMs=${(layoutsAfter.durationMs - layoutsBefore.durationMs).toFixed(0)} ` +
                `longtasks=${pb.longtaskCount}(sum=${pb.longtaskTotalMs}ms)`,
            );
        }

        const med = median(elapsed);
        console.log(
            `[prodbadge] elapsedMedian=${med}ms elapsedMin=${Math.min(...elapsed)}ms elapsedMax=${Math.max(...elapsed)}ms ` +
            `rounds=${elapsed.join(',')} sendMedian=${median(sends)}ms faviconWrites=${last.faviconWrites} ` +
            `href=${JSON.stringify(last.hrefs[0] ?? '')}`,
        );

        // Snapshot of the observable end state: the title's unread number and the
        // badge href. Both arms must agree, otherwise the optimisation changed
        // what the user sees.
        const snapshot = {
            title: last.title,
            unread: last.seen,
            hrefPrefixes: last.hrefs,
        };
        fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2));
        console.log(`[prodbadge] snapshot=${SNAPSHOT_PATH}`);

        expect(last.seen).toBeGreaterThanOrEqual(COUNT);
    } finally {
        await cdp.detach().catch(() => {});
        await page.close().catch(() => {});
    }
});
