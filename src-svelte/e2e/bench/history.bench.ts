/**
 * E2E performance benchmark: large history load (real world "open buffer with
 * history" / "reconnect" path).
 *
 * 1. Flood N IRC messages into #glowing-bear (builds WeeChat history server-side).
 * 2. Reload the page (autoconnect re-establishes the relay connection; WeeChat
 *    resends the buffer history as _buffer_line_info).
 * 3. Measure reload → final history row visible.
 *
 * Run with:
 *   npx playwright test --config src-svelte/e2e/playwright.bench.config.ts -g history
 *
 * Writes a per-row content snapshot to /tmp/gb-perf/e2e-history-rows.json.
 */
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { createConnectedPage } from '../fixtures/auth';
import { switchToBuffer } from '../helpers/buffers';
import { waitForAppReady } from '../helpers/connection';
import { irc } from '../helpers/irc-control';

const HISTORY_COUNT = 3000;
const CHANNEL = '#glowing-bear';

test('history: reload with 3000 lines of history', async ({ browser }) => {
    fs.mkdirSync('/tmp/gb-perf', { recursive: true });
    const page = await createConnectedPage(browser, {
        // Persist credentials via the form (not the settings store): the form's
        // local checkbox state is what handleConnect persists on connect.
        beforeConnect: async (p) => {
            await p.getByTestId('savepassword-checkbox').check();
            await p.getByTestId('autoconnect-checkbox').check();
        },
    });

    try {
        await switchToBuffer(page, CHANNEL);

        // Build server-side history (fast: the flood path is already optimized).
        for (let i = 1; i <= HISTORY_COUNT; i++) {
            await irc.sendMessage(CHANNEL, `hist message ${String(i).padStart(4, '0')} over the lazy dog`);
        }
        const builtRow = page.locator(`td.message[data-message*="hist message ${String(HISTORY_COUNT).padStart(4, '0')}"]`).last();
        await expect(builtRow).toBeVisible({ timeout: 60000 });

        // Full reconnect: WeeChat resends the buffer history on focus.
        const t0 = Date.now();
        await page.reload();
        await waitForAppReady(page);
        const lastRow = page.locator(`td.message[data-message*="hist message ${String(HISTORY_COUNT).padStart(4, '0')}"]`).last();
        await expect(lastRow).toBeVisible({ timeout: 60000 });
        const tEnd = Date.now();

        // Settle then snapshot visible rows for output-identity comparison.
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
        fs.writeFileSync('/tmp/gb-perf/e2e-history-rows.json', JSON.stringify(rows));

        console.log(
            `[bench] history ${HISTORY_COUNT} lines: reload-to-last-row=${tEnd - t0}ms finalVisibleRows=${rows.length}`
        );
        expect(rows.length).toBeGreaterThan(0);
    } finally {
        await page.close();
    }
}, 300000);
