/**
 * Production buffer-reactivity benchmark.
 *
 * prodflood.bench.ts measures the buffer you are looking at. prodbadge.bench.ts
 * measures the badge. Neither can see what this one is about: how much work
 * the app does for traffic in a buffer you are NOT looking at, at a sidebar
 * scale where that work has a cost. This bench measures it in the shipped build:
 *
 *   R-idle      quiet window — what the app does when nothing arrives
 *               (includes a hotlist poll: the poll interval is 15 s, so a
 *               16 s window contains at least one)
 *   R-bg        flood a background buffer: sidebar rows, title, favicon,
 *               script time, layout count
 *   R-active    flood the visible buffer — regression control
 *   R-search    background flood with the buffer search popover open
 *   R-switch    buffer-switch latency while a background flood is in flight
 *   R-type      input latency (Event Timing) while a background flood is in flight
 *
 * Measurement audit (a zero count is only meaningful if the counter can count):
 *   `document.title = x` mutates the <title> TEXT NODE, which is a
 *   characterData mutation, not an attribute mutation. prodbadge.bench.ts
 *   observes only attributes ['href','title'] + childList, and every recorded
 *   run of it reports titleWrites=0 while the title visibly reads "(2000)
 *   Glowing Bear …" — a counter that cannot count is worse than no counter.
 *   Here the title is counted by wrapping the `title` accessor itself (the
 *   authoritative count) AND by a MutationObserver that includes
 *   characterData (the cross-check), and the bench refuses to run until a
 *   self-test proves both counters move on a known write.
 *
 * Run against the production build:
 *   npm run build && npx playwright test --config src-svelte/e2e/playwright.prodbench.config.ts -g prodreact
 */
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { createConnectedPage } from '../fixtures/auth';
import { switchToBuffer, bufferItemForName } from '../helpers/buffers';
import { sendSequence } from '../helpers/irc-control';

const COUNT = Number(process.env.GB_E2E_R_COUNT ?? 1000);
const REPEATS = Number(process.env.GB_E2E_REPEATS ?? 3);
const FLOOD_CHANNEL = '#glowing-bear';
/** Buffer kept on screen while the flood arrives elsewhere. */
const VIEW_BUFFER = process.env.GB_E2E_VIEW_BUFFER ?? 'gbtest';
/** Extra channels joined to give the sidebar a scale worth measuring. */
const EXTRA_CHANNELS = Number(process.env.GB_E2E_EXTRA_CHANNELS ?? 24);
/** Idle window: longer than the 15 s hotlist poll so a poll is inside it. */
const IDLE_MS = Number(process.env.GB_E2E_IDLE_MS ?? 16000);
// e2e-arm.sh exports GB_E2E_SNAPSHOT pointing into the run directory; honour it
// so the arm's identity gate has a file to hash.
const SNAPSHOT_PATH = process.env.GB_E2E_R_SNAPSHOT ?? process.env.GB_E2E_SNAPSHOT ?? '/tmp/gb-perf/e2e-react-snapshot.json';

/**
 * Installed before any app script runs. Observes the page; never drives it.
 * Every counter is a browser-side count of something the app actually did.
 */
const INSTRUMENT = `(() => {
    const st = window.__pr = {
        titleWrites: 0, titleWritesDom: 0, titleSentinelSeen: false,
        faviconWrites: 0, distinct: {},
        sidebarMutations: 0, sidebarNodesAdded: 0, sidebarNodesRemoved: 0,
        longtasks: [], inputs: [], canvasEncodes: 0,
    };

    // --- title: wrap the accessor itself -----------------------------------
    // This is the authoritative count: it fires exactly when the app assigns
    // document.title, independent of how the DOM represents that assignment.
    const proto = Object.getPrototypeOf(document) || Document.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'title')
        || Object.getOwnPropertyDescriptor(Document.prototype, 'title');
    if (desc && desc.get && desc.set) {
        Object.defineProperty(document, 'title', {
            configurable: true,
            enumerable: desc.enumerable,
            get() { return desc.get.call(document); },
            set(v) { st.titleWrites++; desc.set.call(document, v); },
        });
    }

    // drawOnCanvas encodes with toDataURL only when it decides the picture
    // changed, so this separates "the badge was asked for" from "the badge
    // picture actually changed and was written".
    const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function () {
        st.canvasEncodes++;
        return origToDataURL.apply(this, arguments);
    };

    const isFavicon = (n) => n && n.nodeType === 1 && n.tagName === 'LINK'
        && (n.getAttribute('rel') || '').toLowerCase().includes('icon');
    const isTitleNode = (n) => n && n.nodeType === 1 && n.tagName === 'TITLE';
    const obs = new MutationObserver((muts) => {
        for (const m of muts) {
            if (m.type === 'attributes') {
                if (isFavicon(m.target) && m.attributeName === 'href') {
                    st.faviconWrites++;
                    const href = String(m.target.getAttribute('href') || '');
                    st.distinct[href] = (st.distinct[href] || 0) + 1;
                } else if (isTitleNode(m.target)) {
                    st.titleWritesDom++;
                }
            } else if (m.type === 'characterData') {
                // document.title = x lands here: the <title> text node changes.
                if (isTitleNode(m.target.parentNode)) st.titleWritesDom++;
            } else if (m.type === 'childList') {
                for (const n of m.addedNodes) {
                    if (isFavicon(n)) st.faviconWrites++;
                    else if (isTitleNode(n) || isTitleNode(n.parentNode)) st.titleWritesDom++;
                }
            }
        }
    });
    obs.observe(document.documentElement || document, {
        subtree: true, childList: true, characterData: true,
        attributes: true, attributeFilter: ['href', 'title'],
    });

    // --- sidebar churn ------------------------------------------------------
    window.__prObserveSidebar = () => {
        const el = document.querySelector('[data-testid="buffer-list-items"]');
        if (!el) return false;
        const so = new MutationObserver((muts) => {
            for (const m of muts) {
                st.sidebarMutations++;
                st.sidebarNodesAdded += m.addedNodes.length;
                st.sidebarNodesRemoved += m.removedNodes.length;
            }
        });
        so.observe(el, { subtree: true, childList: true, characterData: true, attributes: true });
        return true;
    };

    // --- long tasks + real input latency ------------------------------------
    try {
        new PerformanceObserver((l) => {
            for (const e of l.getEntries()) st.longtasks.push(Math.round(e.duration));
        }).observe({ entryTypes: ['longtask'] });
    } catch { /* unsupported */ }
    try {
        // Event Timing measures the browser's own input-to-presentation latency:
        // what a keystroke costs while the app is busy, with no app hooks.
        new PerformanceObserver((l) => {
            for (const e of l.getEntries()) {
                if (e.name === 'keydown' || e.name === 'input' || e.name === 'pointerdown') {
                    st.inputs.push({ name: e.name, dur: Math.round(e.duration) });
                }
            }
        }).observe({ type: 'event', durationThreshold: 16 });
    } catch { /* unsupported */ }

    // Self-test: prove the counters can count. A zero that came from a broken
    // observer is indistinguishable from a zero that came from no work. The DOM
    // counter is read after a frame because MutationObserver callbacks run at the
    // end of the task, not inside the assignment.
    window.__prSelfTest = async () => {
        const keep = document.title;
        const t0 = st.titleWrites, d0 = st.titleWritesDom;
        document.title = keep + ' \u00b7 selftest';
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const ok = st.titleWrites > t0 && st.titleWritesDom > d0;
        st.titleSentinelSeen = ok;
        document.title = keep;

        // Same audit for the badge counter: prove an href write on the favicon
        // link is actually observed before trusting a zero that says "no draw".
        const link = document.querySelector("link[rel='icon'][sizes='32x32']");
        const f0 = st.faviconWrites;
        const keepHref = link ? link.getAttribute('href') : null;
        if (link) link.setAttribute('href', 'data:,selftest');
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        st.faviconSelfTest = st.faviconWrites > f0;
        if (link && keepHref !== null) link.setAttribute('href', keepHref);
        st.faviconSelfTestSeen = st.faviconWrites === f0;
        return ok && st.faviconSelfTest;
    };
    window.__prReset = () => {
        st.titleWrites = 0; st.titleWritesDom = 0; st.faviconWrites = 0;
        st.distinct = {}; st.sidebarMutations = 0; st.sidebarNodesAdded = 0;
        st.sidebarNodesRemoved = 0; st.longtasks = []; st.inputs = [];
    };
    window.__prRead = () => ({
        titleWrites: st.titleWrites, titleWritesDom: st.titleWritesDom,
        faviconWrites: st.faviconWrites, distinctHrefs: Object.keys(st.distinct).length,
        sidebarMutations: st.sidebarMutations,
        sidebarNodesAdded: st.sidebarNodesAdded, sidebarNodesRemoved: st.sidebarNodesRemoved,
        longtaskCount: st.longtasks.length,
        longtaskMaxMs: st.longtasks.reduce((m, v) => Math.max(m, v), 0),
        longtaskTotalMs: st.longtasks.reduce((s, v) => s + v, 0),
        inputCount: st.inputs.length,
        inputMaxMs: st.inputs.reduce((m, i) => Math.max(m, i.dur), 0),
        inputMedianMs: (() => {
            const d = st.inputs.map((i) => i.dur).sort((a, b) => a - b);
            return d.length ? d[Math.floor(d.length / 2)] : 0;
        })(),
        canvasEncodes: st.canvasEncodes,
        title: document.title,
        // Cross-check for the badge counter: if the href is still the plain file
        // the badge never drew, and faviconWrites=0 means "no draw", not "no work".
        faviconHref: String((document.querySelector("link[rel='icon'][sizes='32x32']") || {}).getAttribute ? document.querySelector("link[rel='icon'][sizes='32x32']").getAttribute('href') : '').slice(0, 24),
    });
})();`;

const stage = (key: string, median: number, extra: string) => {
    console.log(`${key} median ${median.toFixed(1)}ms ${extra}`);
};

function median(values: number[]): number {
    const s = [...values].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
}

function texts(tag: string): string[] {
    const out: string[] = [];
    for (let i = 1; i <= COUNT; i++) {
        out.push(`rb ${tag} ${String(i).padStart(5, '0')} over the lazy dog`);
    }
    return out;
}

/**
 * User-visible state, captured at a deterministic point in the round.
 *
 * The identity gate hashes this, so it must contain no timings and nothing
 * timing-dependent: unread totals are read while the flooded channel is still
 * off screen (every delivered line is unread at that moment), and the chat
 * state is read after the last delivered row is on screen. A snapshot that
 * mixed in medians or in-flight counts would differ between identical arms —
 * worse than having no gate at all.
 */
async function captureState(page: import('@playwright/test').Page) {
    return page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('[data-testid="buffer-item"]')).map((el) => ({
            name: el.querySelector('.buffer-name')?.textContent ?? '',
            badge: el.querySelector('[data-testid="unread-badge"]')?.textContent ?? '',
        }));
        const msgs = Array.from(document.querySelectorAll('[data-testid="chat-messages"] tr'));
        // Row text includes the line's clock. Two identical arms running a second
        // apart would then hash differently for a reason that has nothing to do
        // with the code, so clock text is normalised away and message content is
        // kept verbatim.
        const stripClock = (s) => (s ?? '').replace(/\d{1,2}:\d{2}(:\d{2})?/g, '<clock>');
        return {
            title: document.title,
            rows,
            messageRows: msgs.length,
            firstRow: stripClock(msgs[0] ? msgs[0].textContent : null),
            lastRow: stripClock(msgs[msgs.length - 1] ? msgs[msgs.length - 1].textContent : null),
        };
    });
}

test('prodreact: buffer reactivity at scale against the production build', async ({ browser }) => {
    test.setTimeout(600000);
    fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });

    const page = await createConnectedPage(browser, { initScript: INSTRUMENT });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');

    const metrics = async (): Promise<Record<string, number>> => {
        const { metrics: ms } = await cdp.send('Performance.getMetrics');
        const pick = (name: string) => ms.find((m: { name: string }) => m.name === name)?.value ?? 0;
        return {
            scriptMs: pick('ScriptDuration') * 1000,
            layoutCount: pick('LayoutCount'),
            layoutMs: pick('LayoutDuration') * 1000,
            styleCount: pick('RecalcStyleCount'),
            styleMs: pick('RecalcStyleDuration') * 1000,
            taskMs: pick('TaskDuration') * 1000,
        };
    };
    const delta = (a: Record<string, number>, b: Record<string, number>) => {
        const out: Record<string, number> = {};
        for (const k of Object.keys(a)) out[k] = b[k] - a[k];
        return out;
    };
    const counters = () => page.evaluate(() => (window as any).__prRead());
    const reset = () => page.evaluate(() => (window as any).__prReset());
    /**
     * Badge draws are async (`drawBadge` waits for the base image), so counters
     * are read after a short settle. Reading them the instant the title reaches
     * the target reports faviconWrites=0 for a flood that did redraw the badge —
     * the exact class of misleading zero this bench is required to rule out.
     * This paces the app's own async presentation work, not a test condition.
     */
    const settle = () => page.waitForTimeout(1000);

    try {
        // Measurement self-test before anything is measured.
        const selfTest = await page.evaluate(() => (window as any).__prSelfTest());
        expect(selfTest, 'title counters did not react to a known document.title write').toBe(true);

        await switchToBuffer(page, VIEW_BUFFER);
        const sidebarReady = await page.evaluate(() => (window as any).__prObserveSidebar());
        expect(sidebarReady, 'sidebar container not found for mutation observation').toBe(true);

        // Grow the sidebar so per-message sidebar work has a measurable cost.
        if (EXTRA_CHANNELS > 0) {
            const names = Array.from({ length: EXTRA_CHANNELS }, (_, i) => `#gbperf${i + 1}`);
            // One channel per command: the gbtest IRC server does not deliver a
            // multi-channel /join reliably, and a bench that silently measures a
            // 5-buffer sidebar when it asked for a 25-buffer one is worse than one
            // that fails. Each join is confirmed before the next is issued.
            for (const name of names) {
                await page.getByTestId('message-input').fill(`/join ${name}`);
                await page.keyboard.press('Enter');
                await bufferItemForName(page, name).first()
                    .waitFor({ state: 'visible', timeout: 15000 });
            }
        }
        const rowCount = await page.getByTestId('buffer-item').count();
        await switchToBuffer(page, VIEW_BUFFER);

        const results: Record<string, number[]> = {};
        const detail: Record<string, unknown[]> = {};
        const states: unknown[] = [];
        const push = (key: string, ms: number, d: Record<string, unknown>) => {
            (results[key] ??= []).push(ms);
            (detail[key] ??= []).push(d);
        };

        for (let round = 0; round < REPEATS; round++) {
            // ---- R-idle: nothing arrives; includes at least one hotlist poll ----
            await reset();
            const idleBefore = await metrics();
            const idleStart = Date.now();
            await page.waitForTimeout(IDLE_MS);
            const idleMs = Date.now() - idleStart;
            const idleCounters = await counters();
            push('R-idle', idleMs, { windowMs: idleMs, ...idleCounters, ...delta(idleBefore, await metrics()) });

            // ---- R-bg: flood a buffer that is NOT on screen ----
            await switchToBuffer(page, FLOOD_CHANNEL);
            await switchToBuffer(page, VIEW_BUFFER);
            await reset();
            const bgBefore = await metrics();
            const bgStart = Date.now();
            await sendSequence(FLOOD_CHANNEL, texts(`b${round}`));
            await page.waitForFunction(
                (n: number) => {
                    const m = /^\((\d+)\)/.exec(document.title);
                    return !!m && Number(m[1]) >= n;
                },
                COUNT,
                { timeout: 120000, polling: 50 },
            );
            const bgMs = Date.now() - bgStart;
            await settle();
            // State is captured here, before anything is read again: every
            // delivered line is unread and the flooded channel is off screen.
            states.push({ afterBackgroundFlood: await captureState(page) });
            push('R-bg', bgMs, {
                ...(await counters()),
                ...delta(bgBefore, await metrics()),
            });

            // ---- R-active: flood the buffer that IS on screen (control) ----
            await switchToBuffer(page, FLOOD_CHANNEL);
            await reset();
            const actBefore = await metrics();
            const actStart = Date.now();
            await sendSequence(FLOOD_CHANNEL, texts(`a${round}`));
            await page.waitForFunction(
                () => document.querySelectorAll('[data-testid="chat-messages"] tr').length > 0
                    && /over the lazy dog/.test(
                        document.querySelectorAll('[data-testid="chat-messages"] tr')[
                            document.querySelectorAll('[data-testid="chat-messages"] tr').length - 1
                        ]?.textContent ?? '',
                    ),
                null, { timeout: 120000, polling: 50 },
            );
            const actMs = Date.now() - actStart;
            await settle();
            // The last delivered row is on screen now: this is the message-state
            // half of the identity snapshot.
            states[round] = {
                ...states[round],
                afterVisibleFlood: await captureState(page),
            };
            push('R-active', actMs, {
                ...(await counters()),
                ...delta(actBefore, await metrics()),
            });

            // ---- R-search: background flood with the search popover open ----
            await switchToBuffer(page, VIEW_BUFFER);
            await page.getByTestId('search-button').click();
            await expect(page.locator('#buffer-search-modal')).toBeVisible();
            // A query that matches every extra channel is the expensive case:
            // the popover re-filters the buffer set on each store change.
            await page.locator('#buffer-search').fill('gbperf');
            await reset();
            const srBefore = await metrics();
            const srStart = Date.now();
            await sendSequence(FLOOD_CHANNEL, texts(`s${round}`));
            await page.waitForTimeout(2000);
            const srMs = Date.now() - srStart;
            push('R-search', srMs, {
                ...(await counters()),
                ...delta(srBefore, await metrics()),
            });
            await page.keyboard.press('Escape');

            // ---- R-switch / R-type: interaction while traffic is in flight ----
            await switchToBuffer(page, VIEW_BUFFER);
            await reset();
            const sending = sendSequence(FLOOD_CHANNEL, texts(`i${round}`));
            await page.waitForTimeout(300);

            const swBefore = await metrics();
            const swStart = Date.now();
            await switchToBuffer(page, FLOOD_CHANNEL, { timeout: 30000 });
            const swMs = Date.now() - swStart;
            push('R-switch', swMs, { ...(await counters()), ...delta(swBefore, await metrics()) });

            await page.getByTestId('message-input').click();
            const typeStart = Date.now();
            await page.keyboard.type('ping');
            const typeMs = Date.now() - typeStart;
            push('R-type', typeMs, { ...(await counters()), ...delta(swBefore, await metrics()) });

            await sending;

            // Leave the channel drained and the view buffer stable for the next round.
            await switchToBuffer(page, VIEW_BUFFER);
        }

        for (const key of Object.keys(results)) {
            const vals = results[key]!;
            const extras = (detail[key] ?? []) as Record<string, unknown>[];
            const last = extras[extras.length - 1] ?? {};
            stage(
                key,
                median(vals),
                `reps=${vals.map((v) => v.toFixed(0)).join(',')} rows=${rowCount} ` +
                Object.entries(last)
                    .filter(([k]) => k !== 'title')
                    .map(([k, v]) => `${k}=${typeof v === 'number' ? (Number.isInteger(v) ? v : v.toFixed(1)) : JSON.stringify(v)}`)
                    .join(' '),
            );
        }
        const summary = Object.fromEntries(
            Object.entries(results).map(([k, v]) => [k, {
                medianMs: median(v),
                reps: v,
                detail: detail[k],
            }]),
        );
        // Two files, two purposes. The identity gate hashes a state-only
        // snapshot so identical arms must produce identical bytes; timings go
        // beside it, where their noise cannot break the gate.
        fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify({
            count: COUNT, repeats: REPEATS, extraChannels: EXTRA_CHANNELS,
            bufferItems: rowCount, states,
        }, null, 2));
        fs.writeFileSync(
            SNAPSHOT_PATH.replace(/\.json$/, '-detail.json'),
            JSON.stringify({ count: COUNT, repeats: REPEATS, bufferItems: rowCount, results: summary }, null, 2),
        );
        console.log(`[prodreact] bufferItems=${rowCount} flood=${COUNT} repeats=${REPEATS} snapshot=${SNAPSHOT_PATH}`);
    } finally {
        await page.close();
    }
});
