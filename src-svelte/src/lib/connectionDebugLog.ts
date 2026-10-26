/**
 * Test-only diagnostic ring for connection lifecycle events.
 *
 * A session that vanishes mid-test leaves the app on the connect form with an empty sidebar and
 * says nothing: the orchestrator's `'disconnected'` status is produced by `stop()` / `dispose()`,
 * which is the one exit that names no failure anywhere (api-orchestrator.ts `handleSessionClose`,
 * apiConnection.ts's status branch). That silence is why an E2E race took a full run's worth of
 * archaeology to characterise at all.
 *
 * This module is inert unless the harness opts in — `window.__gbE2eDebug = true`, set by an init
 * script before the app's first script runs. With the flag absent it allocates nothing, logs
 * nothing, and exports no surface. It adds no timer, subscribes to nothing, and changes no
 * behaviour: it records events the app already produces, at the calls that already run.
 */

type Entry = { t: number; event: string; detail?: string };

const RING_LIMIT = 60;
const ring: Entry[] = [];

function debugEnabled(): boolean {
    return typeof window !== 'undefined' && (window as { __gbE2eDebug?: unknown }).__gbE2eDebug === true;
}

/** Records one lifecycle event. Free when the harness has not opted in. */
export function connectionDebugLog(event: string, detail?: string): void {
    if (!debugEnabled()) return;
    ring.push({ t: Date.now(), event, detail });
    if (ring.length > RING_LIMIT) ring.shift();
}

/**
 * Record an event together with the call site that produced it. The stack is built only when the
 * harness opted in, so an app that never asked for this pays nothing for it.
 */
export function connectionDebugLogFromCaller(event: string, depth = 3): void {
    if (!debugEnabled()) return;
    const frames = (new Error().stack ?? '')
        .split('\n')
        .slice(2, 2 + depth)
        .map((frame) => frame.trim().replace(/^at\s+/, ''));
    ring.push({ t: Date.now(), event, detail: frames.join(' <- ') });
    if (ring.length > RING_LIMIT) ring.shift();
}

/** Snapshot of the ring for the harness (`window.__gbE2eDebugEntries()`). */
function connectionDebugEntries(count = 25): Entry[] {
    return ring.slice(-count);
}

/**
 * Install the read side. Called once from the connection store's module body when the harness flag
 * is present, so a spec that never enables the flag never sees this function at all.
 */
export function installConnectionDebugRead(): void {
    if (typeof window === 'undefined' || !debugEnabled()) return;
    (window as { __gbE2eDebugEntries?: unknown }).__gbE2eDebugEntries = () => connectionDebugEntries();
}
