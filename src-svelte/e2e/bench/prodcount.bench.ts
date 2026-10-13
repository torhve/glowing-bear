/**
 * Work-count benchmark: count how often the hot code actually runs.
 *
 * Timing on this machine cannot resolve a change under ~20% at eight paired reps
 * (see docs/perf-ui-journal.md: two byte-identical arms produced per-pair ratios
 * from 0.81 to 1.21). A counter has no noise. When the question is "does this
 * code run 2,000 times or 14,000 times per flood", the answer is available
 * exactly, and it settles a hypothesis that a stopwatch cannot.
 *
 * It measures the *shipped* app instrumented with `gbCount()` calls in
 * BufferLineRow — a diagnostic build, not a candidate. The counters are read
 * after the flood finishes.
 *
 * Run:
 *   npm run build && npx playwright test --config src-svelte/e2e/playwright.prodbench.config.ts -g prodcount
 */
import { test, expect } from '@playwright/test';
import { createConnectedPage } from '../fixtures/auth';
import { switchToBuffer } from '../helpers/buffers';
import { sendSequence } from '../helpers/irc-control';

const COUNT = Number(process.env.GB_E2E_WALK_COUNT ?? 2000);
const CHANNEL = '#glowing-bear';

/** Every counter BufferLineRow increments, plus whatever else a build exposes. */
const READ_COUNTERS = `
(() => {
    const keys = [
        'rowRenders',
        'previousMessageEvals',
        'repeatedTimeEvals',
        'repeatedPrefixEvals',
        'tokenizeCalls',
        'metadataCalls',
        'dateCheckCalls',
        'extractNickCalls',
    ];
    const out = {};
    for (const key of keys) out[key] = window[key] ?? 0;
    const container = document.querySelector('[data-testid="chat-messages"]');
    out.rows = container ? container.querySelectorAll('[data-testid="bufferline-row"]').length : 0;
    return out;
})()
`;

test('prodcount: how many times does the row path run for one flood', async ({ browser }) => {
    const page = await createConnectedPage(browser);
    try {
        await switchToBuffer(page, CHANNEL);
        const tag = `c${Date.now()}`;
        await sendSequence(
            CHANNEL,
            Array.from({ length: COUNT }, (_, i) => `pc ${tag} ${String(i + 1).padStart(5, '0')} quick brown fox`),
        );
        // Wait for the LAST message to be rendered. Waiting for "scrolled to the
        // bottom" is useless here: a following view is at the bottom throughout the
        // flood, so the counters would be read mid-flood — which is exactly what
        // made the first two runs incomparable (1046 rows vs 2200).
        const lastMarker = `pc ${tag} ${String(COUNT).padStart(5, '0')}`;
        await page.waitForFunction(
            (marker) => {
                const c = document.querySelector('[data-testid="chat-messages"]');
                if (!c) return false;
                const rows = c.querySelectorAll('[data-testid="bufferline-row"]');
                for (const row of rows) {
                    if ((row.textContent ?? '').includes(marker)) return true;
                }
                return false;
            },
            lastMarker,
            { timeout: 120000, polling: 100 },
        );


        const counts = await page.evaluate(READ_COUNTERS);
        const line = Object.entries(counts)
            .map(([key, value]) => `${key}=${value}`)
            .join(' ');
        console.log(`[prodcount] ${line}`);
        console.log(`[prodcount] summary flood=${COUNT} ${line}`);
        expect(counts.rowRenders).toBeGreaterThan(0);
    } finally {
        await page.close();
    }
}, 180000);
