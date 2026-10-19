/**
 * Warm the gbtest channel before a full E2E run.
 *
 * `start.sh` seeds no channel history: it only autojoins #glowing-bear. Several
 * specs reason about a buffer that already has lines in it — fetching older
 * history, read markers sitting inside an existing run of messages — and on a
 * freshly started fixture they fail for want of content rather than for want of
 * correct code. This sends a block of ordinary channel messages so the buffer is
 * not empty when those specs start looking at it.
 */
import { irc, sendSequence } from '../src-svelte/e2e/helpers/irc-control.ts';

const COUNT = Number(process.argv[2] ?? 200);
const runId = Date.now();

await irc.botJoin('#glowing-bear');
await irc.waitForChannel('#glowing-bear');

const texts = Array.from({ length: COUNT }, (_, i) => `warm-${runId}-${i}`);
await sendSequence('#glowing-bear', texts);

console.log(`warmed #glowing-bear with ${COUNT} messages (run ${runId})`);
process.exit(0);
