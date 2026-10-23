/**
 * A rejected password lands on the same status whichever transport carried it.
 *
 * A credential rejection is terminal on both transports — neither relay recovers
 * from it, and retrying spends the same password again — so both must say so the
 * same way. The status is what the top bar turns into a word, and it used to be
 * the one place where the two transports disagreed:
 *
 *   legacy  handleAttemptLoss wrote 'disconnected', and handleReconnectDecision's
 *           403/401 branch named the error, showed a toast, and returned without
 *           touching it — so a refusal read as "you pressed Leave".
 *   API     handleOrchestratorStatus 'failed' wrote 'error'.
 *
 * The legacy transport contradicted itself as well: a loss it would not retry
 * already ended at 'error' through the retry loop's terminal declaration, and
 * `first-connect-retry.test.ts` asserts exactly that. The auth branch was the
 * outlier, not the transport.
 *
 * The rule now written down: 'error' is a failure the app has named and will not
 * retry; 'disconnected' is a session that ended or a user who left. Nothing was
 * folded into 'disconnected' to be lost — a user-initiated departure has its own
 * `userDisconnect` field, and the banner reads the cause from `errors`, so its
 * wording never changed. What changed is the top bar: see
 * `connection-status-word.test.ts` for the words each status produces.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { connectionState } from '#lib/stores/connectionStore.ts';
import { updateSettings } from '#lib/stores/settings.ts';
import { connect as facadeConnect } from '#lib/stores/connectionManager.ts';
import { pendingRetryState } from '#lib/stores/connectionLifecycle.ts';
import * as legacy from '#lib/stores/legacyConnection.ts';

vi.mock('#lib/notifications.ts', async () => (await import('./helpers/mockNotifications.ts')).mockNotifications());

class FakeSocket {
    static readonly OPEN = 1;
    static readonly CONNECTING = 0;
    static readonly CLOSED = 3;
    static instances: FakeSocket[] = [];

    readyState = FakeSocket.CONNECTING;
    onopen: ((ev: Event) => void) | null = null;
    onclose: ((ev: CloseEvent) => void) | null = null;
    onerror: ((ev: Event) => void) | null = null;
    onmessage: ((ev: MessageEvent) => void) | null = null;

    constructor(public url: string) {
        FakeSocket.instances.push(this);
    }
    send() {}
    close(code?: number) {
        this.readyState = FakeSocket.CLOSED;
        this.onclose?.({ code: code ?? 1006, reason: '', wasClean: false } as CloseEvent);
    }
    addEventListener() {}
    removeEventListener() {}
}

/**
 * A stand-in for the API transport's orchestrator. It reports one status on
 * start(), which is all the app-level handler needs in order to run the branch
 * under test. Everything the real orchestrator owns — generation, abort, session
 * teardown — stays out of the picture.
 *
 * Hoisted because the mock factory below runs before this file's own statements.
 */
const { FakeOrchestrator } = vi.hoisted(() => {
    class FakeOrchestrator {
        static nextStatus: { state: string; error?: string } | null = null;
        static live: FakeOrchestrator[] = [];
        private readonly opts: { onStatus: (status: unknown) => void };

        constructor(opts: { onStatus: (status: unknown) => void }) {
            this.opts = opts;
            FakeOrchestrator.live.push(this);
        }
        start() {
            const status = FakeOrchestrator.nextStatus;
            if (status) this.opts.onStatus({ ...status, generation: 1, attempt: 1 });
        }
        startScheduledAttempt() {}
        stop() {}
        reconnectNow() {}
        getSession() {
            return null;
        }
    }
    return { FakeOrchestrator };
});

vi.mock('#lib/api/api-orchestrator.ts', () => ({
    ApiOrchestrator: FakeOrchestrator,
}));

const PROFILE = {
    host: 'relay.example',
    port: 9001,
    path: 'weechat',
    password: 'wrong-password',
    tls: false,
    noCompression: true,
};

function lastSocket(): FakeSocket {
    const socket = FakeSocket.instances[FakeSocket.instances.length - 1];
    if (!socket) throw new Error('connect() did not open a socket');
    return socket;
}

beforeEach(() => {
    FakeSocket.instances = [];
    FakeOrchestrator.live = [];
    FakeOrchestrator.nextStatus = null;
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('this test must not probe'))));
    // Autoconnect ON, so the retry loop is genuinely available to both transports.
    // The divergence is only interesting when a retry was possible and the failure
    // refused it: with autoconnect off both paths end in the shared scheduler.
    updateSettings({ protocol: 'legacy', autoconnect: true, useTotp: false });
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('a rejected password lands on the same status whichever transport carried it', () => {
    it('legacy: 403 names the cause and reports a failure', async () => {
        const attempt = facadeConnect(PROFILE);
        await Promise.resolve();

        lastSocket().close(403);
        await expect(attempt).rejects.toThrow();

        const state = get(connectionState);
        expect(state.errors.passwordError, 'the cause is named').toBe(true);
        // handleAttemptLoss wrote 'disconnected' on the way in; this branch is the
        // one that knows the attempt was refused rather than merely ended.
        expect(state.status, 'a failure the app will not retry reads as a failure').toBe('error');
        expect(legacy.isAttemptInProgress()).toBe(false);
        expect(pendingRetryState().active, 'a rejected credential is not retried').toBe(false);
    });

    it('API: the same rejection leaves the status at "error"', async () => {
        updateSettings({ protocol: 'api' });
        FakeOrchestrator.nextStatus = { state: 'failed', error: 'Authentication failed' };

        await expect(facadeConnect(PROFILE)).rejects.toThrow();

        const state = get(connectionState);
        expect(state.status, 'the API transport names a terminal failure an error').toBe('error');
    });

    it('the same rejection reads the same way on both transports', async () => {
        updateSettings({ protocol: 'legacy' });
        const legacyAttempt = facadeConnect(PROFILE);
        await Promise.resolve();
        lastSocket().close(401);
        await expect(legacyAttempt).rejects.toThrow();
        const legacyStatus = get(connectionState).status;

        updateSettings({ protocol: 'api' });
        FakeOrchestrator.nextStatus = { state: 'failed', error: 'Authentication failed' };
        await expect(facadeConnect({ ...PROFILE, port: 9002 })).rejects.toThrow();
        const apiStatus = get(connectionState).status;

        expect({ legacy: legacyStatus, api: apiStatus }).toEqual({
            legacy: 'error',
            api: 'error',
        });
    });
});
