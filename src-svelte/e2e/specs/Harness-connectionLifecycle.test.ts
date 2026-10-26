import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { createConnectedPage } from '../fixtures/auth';
import { disconnect } from '../helpers/connection';

// The connection lifecycle ring is what lets a harness failure say *why* the app had no session
// (see helpers/appState.ts). This spec is the check that the ring is real: it must hold the session
// the harness built, and a deliberate Leave must name the teardown that ran it.
test.describe.configure({ mode: 'serial' });

let page: Awaited<ReturnType<typeof createConnectedPage>>;

/** One ring entry, the same shape helpers/appState.ts reads when a failure quotes the ring. */
type RingEntry = { t: number; event: string; detail?: string };

/** Read the ring out of the page, or null when the harness flag never installed it. */
function readRing(target: Page): Promise<RingEntry[] | null> {
    return target.evaluate(() =>
        (
            window as Window & {
                __gbE2eDebugEntries?: () => RingEntry[];
            }
        ).__gbE2eDebugEntries?.() ?? null,
    );
}

test.beforeAll(async ({ browser }) => {
    page = await createConnectedPage(browser);
});

test.afterAll(async () => {
    await page.close();
});

test('the lifecycle ring records the session it built', async () => {
    const ring = await readRing(page);
    expect(ring, 'window.__gbE2eDebugEntries was never installed').not.toBeNull();
    expect(ring!.some((e) => e.event === 'connect:start')).toBe(true);
    expect(ring!.some((e) => e.event === 'status:connected')).toBe(true);
});

test('a deliberate Leave names the teardown and who ran it', async () => {
    await disconnect(page);
    const ring = await readRing(page);
    expect(ring!.some((e) => e.event === 'disconnect')).toBe(true);
    const stop = ring!.find((e) => e.event === 'orchestrator:stop');
    expect(stop, 'no orchestrator:stop entry recorded for a Leave').not.toBeUndefined();
    expect(stop!.detail, 'the stop entry carries no call site').toBeTruthy();
});
