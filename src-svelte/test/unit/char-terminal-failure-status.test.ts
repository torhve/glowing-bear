/**
 * Characterization tests for B4: what a rejected password leaves the connection
 * status set to.
 *
 * A credential rejection is terminal on both transports — neither relay recovers
 * from it, and retrying spends the same password again. But the two transports
 * arrive at that decision by different routes, and the status they land on is
 * part of what the user sees:
 *
 *   legacy  handleAttemptLoss (legacyConnection.ts:208) writes 'disconnected'
 *           at :214, and handleReconnectDecision's 403/401 branch never changes
 *           it — it names the error and shows a toast, then returns.
 *   API     handleOrchestratorStatus 'failed' (apiConnection.ts:320) writes
 *           'error'.
 *
 * The shared terminal-failure helper (connectionLifecycle.ts declareTerminalFailure)
 * does write 'error' for both, but the legacy auth path never reaches it: it is
 * terminal *without* going through scheduleRetry, which is the only caller.
 *
 * These tests pin the two statuses as they are today. They are the bug report for
 * the §13 decision about which status is correct; they are not a claim that
 * 'disconnected' is wrong.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { connectionState } from '#lib/stores/connectionStore.ts';
import { updateSettings } from '#lib/stores/settings.ts';
import { connect as facadeConnect } from '#lib/stores/connectionManager.ts';
import { pendingRetryState } from '#lib/stores/connectionLifecycle.ts';
import * as legacy from '#lib/stores/legacyConnection.ts';

vi.mock('#lib/notifications.ts', () => ({
    createHighlight: vi.fn(),
    playNotificationSound: vi.fn(),
    updateTitle: vi.fn(),
    updateFavicon: vi.fn(),
    updateFavico: vi.fn(),
    startIndicatorOwner: () => () => {},
    refreshIndicators: vi.fn(),
    onDisconnect: vi.fn(),
}));

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
 */
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

describe('B4 characterization: a rejected password lands on two different statuses', () => {
    it('legacy: 403 leaves the status at "disconnected" while naming the cause', async () => {
        const attempt = facadeConnect(PROFILE);
        await Promise.resolve();

        lastSocket().close(403);
        await expect(attempt).rejects.toThrow();

        const state = get(connectionState);
        expect(state.errors.passwordError, 'the cause is named').toBe(true);
        // The status the attempt wrote before the decision, unchanged by it.
        expect(state.status, 'a terminal legacy auth failure reads as a plain disconnect').toBe('disconnected');
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

    it('the same event, two statuses — this is the divergence, recorded', async () => {
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
            legacy: 'disconnected',
            api: 'error',
        });
    });
});
