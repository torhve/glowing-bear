import type { Page } from '@playwright/test';

/**
 * The shipped retry waits are long on purpose: 30s for the first ladder step, 10s for
 * the handshake deadline, 3s for the probe that classifies a relay, 10s for the wait
 * left before a tab regaining focus may cut in front of a scheduled retry.
 *
 * A spec that asserts what happens AFTER one of those waits spends its wall clock on
 * the wait. The numbers themselves belong to `test/unit/connection-lifecycle.test.ts`
 * and `test/unit/handshake-deadline.test.ts`, which drive them with fake timers.
 *
 * Setting `window.__gbE2eTimingScale` before the app's first module shortens every
 * one of them in a dev build — see the `HARNESS_TIMING_SCALE` block in
 * `src/lib/stores/connectionLifecycle.ts`. One scale for all of them, because they are
 * related: the focus takeover only cuts in front of a wait longer than its threshold,
 * so a short ladder beside the shipped threshold would leave nothing to take over.
 */
export const FAST_TIMING_SCALE = 0.2;

/** Shorten the retry waits for this page. Install before the first navigation. */
export async function installFastTiming(page: Page, scale: number = FAST_TIMING_SCALE): Promise<void> {
    await page.addInitScript((value) => {
        (window as Window & { __gbE2eTimingScale?: number }).__gbE2eTimingScale = value;
    }, scale);
}

/** The shipped wait as this page sees it, for an assertion about a deadline it waits for. */
export function fastMs(shippedMs: number, scale: number = FAST_TIMING_SCALE): number {
    return shippedMs * scale;
}
