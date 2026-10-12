/**
 * The API transport's answer to "is an attempt running?"
 *
 * This one line is the difference between a countdown the reader can see and one
 * they cannot. The orchestrator used to publish 'reconnecting' when an attempt
 * failed, so reading its status happened to answer the question. Now the shared
 * scheduler owns the waiting state and the orchestrator's status is whatever the
 * attempt last wrote — which for a session that died during bootstrap is
 * 'bootstrapping', forever. Reading the status then reports an attempt that is
 * not running, and the banner hides its own countdown because it believes a retry
 * is already underway.
 *
 * Pinned here rather than only at the orchestrator, because the transport is the
 * consumer that decides what the banner does.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const fake = vi.hoisted(() => ({ instance: null as unknown as FakeOrchestrator | null }));

class FakeOrchestrator {
    /** The status a bootstrap-phase attempt left behind, and never corrected. */
    currentStatus = { state: 'bootstrapping', generation: 1, attempt: 0, error: undefined, nextRetryAt: undefined };
    attemptInFlight = true;
    started = false;

    constructor(_opts: unknown) {
        fake.instance = this;
    }

    // Deliberately never settles: the connect() promise stays unsettled so the
    // transport keeps an orchestrator installed and the question stays answerable.
    start(): void { this.started = true; }
    dispose(): void {}
    stop(): void {}
    destroy(): void {}
    reconnectNow(): void {}
    clearRetry(): void {}
    startScheduledAttempt(): void {}
    getSession(): null { return null; }
    getSocket(): null { return null; }
}

vi.mock('#lib/api/api-orchestrator.ts', () => ({ ApiOrchestrator: FakeOrchestrator }));

const PROFILE = { host: 'relay.test', port: 9010, path: '', password: 'pw', tls: false, noCompression: false };

async function api() {
    return await import('#lib/stores/apiConnection.ts');
}

describe('API transport attempt-in-progress', () => {
    beforeEach(() => {
        fake.instance = null;
    });

    afterEach(() => {
        void import('#lib/stores/apiConnection.ts').then((m) => m.__resetAllStateForTest());
        fake.instance = null;
    });

    it('follows the orchestrator, not the status the last attempt left behind', async () => {
        const m = await api();
        void m.connect(PROFILE).catch(() => undefined);
        await vi.waitFor(() => expect(fake.instance).not.toBeNull());

        // An attempt really is running.
        expect(fake.instance!.attemptInFlight).toBe(true);
        expect(m.isAttemptInProgress()).toBe(true);

        // The attempt ended and the client is waiting out a backoff. The status
        // still reads 'bootstrapping': a transport that read it would report an
        // attempt in flight, disable Retry, and suppress the countdown it just
        // scheduled.
        fake.instance!.attemptInFlight = false;
        expect(fake.instance!.currentStatus.state).toBe('bootstrapping');
        expect(m.isAttemptInProgress()).toBe(false);
    });

    it('reports no attempt in flight when there is no orchestrator at all', async () => {
        const m = await api();
        m.__resetAllStateForTest();
        expect(m.isAttemptInProgress()).toBe(false);
    });
});
