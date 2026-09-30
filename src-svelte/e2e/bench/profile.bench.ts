/**
 * CPU-profile diagnostic via CDP: run the flood under Profiler.start/stop,
 * save the profile JSON for offline analysis.
 *
 * Run:
 *   npx playwright test --config src-svelte/e2e/playwright.bench.config.ts -g profile
 *   node src-svelte/e2e/bench/analyze-cpuprofile.mjs /tmp/gb-perf/cpu-profile.json
 */
import { test } from '@playwright/test';
import fs from 'node:fs';
import { createConnectedPage } from '../fixtures/auth';
import { switchToBuffer } from '../helpers/buffers';
import { irc } from '../helpers/irc-control';

const FLOOD_COUNT = 2000;
const CHANNEL = '#glowing-bear';

test('profile: capture cpu profile during flood', async ({ browser }) => {
    const page = await createConnectedPage(browser);
    const cdp = await page.context().newCDPSession(page);

    try {
        await switchToBuffer(page, CHANNEL);

        await cdp.send('Profiler.enable');
        await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
        await cdp.send('Profiler.start', { sampledCpuProfile: true });

        const t0 = Date.now();
        for (let i = 1; i <= FLOOD_COUNT; i++) {
            await irc.sendMessage(CHANNEL, `prof message ${String(i).padStart(4, '0')}`);
        }
        const lastRow = page.locator('td.message[data-message*="prof message 2000"]').last();
        await lastRow.waitFor({ state: 'visible', timeout: 60000 });
        const tEnd = Date.now();

        const { profile } = await cdp.send('Profiler.stop');
        fs.writeFileSync('/tmp/gb-perf/cpu-profile.json', JSON.stringify(profile));
        console.log(`[profile] flood wall=${tEnd - t0}ms samples=${profile?.nodes?.length ?? 0} saved=/tmp/gb-perf/cpu-profile.json`);
    } finally {
        await cdp.detach().catch(() => {});
        await page.close();
    }
}, 300000);
