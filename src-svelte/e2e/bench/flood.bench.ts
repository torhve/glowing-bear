/**
 * E2E performance benchmark: full-pipeline message flood.
 *
 * Connects to the gbtest relay, floods 2000 IRC messages into #glowing-bear
 * via the control API, and measures how long until the UI has rendered the
 * final message (the DOM is capped at maxBufferLines rows, so "rendered"
 * means: the last message's row is visible).
 *
 * Run with:
 *   npx playwright test --config src-svelte/e2e/playwright.bench.config.ts
 *
 * Writes a per-row content snapshot to /tmp/gb-perf/e2e-rows.json for
 * byte comparison between baseline and optimized builds.
 */
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { createConnectedPage } from '../fixtures/auth';
import { switchToBuffer } from '../helpers/buffers';
import { irc } from '../helpers/irc-control';

const FLOOD_COUNT = 2000;
const CHANNEL = '#glowing-bear';

test('flood: 2000 messages full pipeline', async ({ browser }) => {
    fs.mkdirSync('/tmp/gb-perf', { recursive: true });
    const page = await createConnectedPage(browser);

    try {
        await switchToBuffer(page, CHANNEL);

        // Baseline row count (buffer may already contain history).
        const rowSel = '[data-testid="bufferline-row"]';
        const baseRows = await page.locator(rowSel).count();

        // Start the flood; measure send time separately.
        const t0 = Date.now();
        let firstNewRowAt = -1;
        let sawBaseRows = baseRows;

        // Poll for the first new row to appear (measures first-render latency).
        const pollFirst = (async () => {
            const start = Date.now();
            for (;;) {
                const n = await page.locator(rowSel).count();
                if (n > baseRows) {
                    firstNewRowAt = Date.now() - start;
                    return;
                }
                await new Promise(r => setTimeout(r, 10));
                if (Date.now() - start > 30000) return;
            }
        })();

        for (let i = 1; i <= FLOOD_COUNT; i++) {
            await irc.sendMessage(CHANNEL, `flood message ${String(i).padStart(4, '0')} over the lazy dog`);
        }
        const sendEnd = Date.now();

        // Wait for the final message row to be visible.
        const lastRow = page.locator('td.message[data-message*="flood message 2000"]').last();
        await expect(lastRow).toBeVisible({ timeout: 60000 });
        const tEnd = Date.now();

        // Let the UI settle (trim + rAF pinning) then snapshot visible rows.
        await new Promise(r => setTimeout(r, 500));
        const rows = await page.evaluate(() => {
            const out: { p: string; m: string; h: boolean }[] = [];
            for (const el of Array.from(document.querySelectorAll('[data-testid="bufferline-row"]'))) {
                const tr = el as HTMLElement;
                const prefix = tr.querySelector('td.prefix')?.textContent?.trim() ?? '';
                const msg = (tr.querySelector('td.message') as HTMLElement | null)?.dataset.message ?? '';
                out.push({ p: prefix, m: msg, h: tr.classList.contains('highlight') });
            }
            return out;
        });
        fs.writeFileSync('/tmp/gb-perf/e2e-rows.json', JSON.stringify(rows));

        const totalMs = tEnd - t0;
        const sendMs = sendEnd - t0;
        const renderMs = tEnd - sendEnd;
        const finalRows = rows.length;
        console.log(
            `[bench] flood ${FLOOD_COUNT} msgs: total=${totalMs}ms send=${sendMs}ms render-after-send=${renderMs}ms ` +
            `first-row-latency=${firstNewRowAt}ms finalVisibleRows=${finalRows} rate=${(FLOOD_COUNT / (totalMs / 1000)).toFixed(0)} msgs/s`
        );
        expect(finalRows).toBeGreaterThan(0);
    } finally {
        await page.close();
    }
}, 300000);
