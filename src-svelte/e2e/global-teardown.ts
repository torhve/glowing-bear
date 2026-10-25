import type { FullConfig } from '@playwright/test';
import { closeTestBuffers, relayBufferNames } from './helpers/relay-admin';

/* gbtest itself persists across test runs on purpose: the channel, the PM and the
 * relay stay up so a run does not have to rebuild them. What must NOT persist is the
 * throwaway channels specs join for themselves — `/part` leaves the buffer behind, so
 * each run added a dozen rows to the sidebar and a dozen candidates to the hotlist,
 * and a later run was asserting against leftovers it never created (53 buffers after
 * a few runs, 47 of them test channels; live probe 2026-10-07).
 *
 * The prefixes below are the channels specs name for themselves. The fixture's own
 * buffers — `#glowing-bear`, the `gbtest` server, `gbbot2`, `relay.relay.list` — do
 * not match. */
const TEST_BUFFER_PREFIXES = [
    'irc.gbtest.#gb',           // #gb-idle-, #gbown…, #gbmshallow/#gbmcapped, #gbhist-, #gb-smsg-, …
    'irc.gbtest.#core-clear-probe',
    'exec.exec.',               // buffers left by exec-based specs
];

export default async function globalTeardown(_config: FullConfig) {
    try {
        const closed = await closeTestBuffers(TEST_BUFFER_PREFIXES);
        // Naming what survives, so a leak outside the prefixes above shows up as a
        // growing list in the run output instead of silently slowing every later run.
        const remaining = await relayBufferNames();
        console.log(
            `[global-teardown] closed ${closed} test buffer(s); gbtest kept running with ${remaining.length} buffers: ${remaining.join(', ')}`,
        );
    } catch (err) {
        // The fixture may already be down (a run that never started it, or a manual
        // `npm run irc:stop`). Teardown is hygiene, not a test: say what happened and
        // leave the exit code to the tests.
        console.log(`[global-teardown] test buffers left in place: ${(err as Error).message}`);
    }
}
