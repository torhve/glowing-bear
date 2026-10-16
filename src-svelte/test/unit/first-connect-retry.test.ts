/**
 * What decides whether a failed *first* connect is retried.
 *
 * `handleReconnectDecision()` used to short-circuit on `wasEverConnected`, which made
 * `autoconnect` a setting that only applied to sessions: a relay that was down when the
 * app opened was never retried at all, however the user had configured it, while the
 * same loss an hour later was retried with a countdown. The API transport retried the
 * first attempt; the legacy transport did not.
 *
 * These tests pin the decision at the point it is made, including the two branches that
 * must stay ahead of it — an explicit Leave, and a close that names a rejected
 * credential — and the ordering that makes the app's own message honest: an attempt is
 * settled *after* the retry decision, so a caller that awaits `connect()` learns the
 * outcome the app settled on rather than an early reading of one socket event.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { connectionState, setReconnectAttempts } from '#lib/stores/connectionStore.ts';
import { updateSettings } from '#lib/stores/settings.ts';
import { connect as facadeConnect } from '#lib/stores/connectionManager.ts';
import { pendingRetryState } from '#lib/stores/connectionLifecycle.ts';
import * as legacy from '#lib/stores/legacyConnection.ts';

const onDisconnect = vi.hoisted(() => vi.fn());

vi.mock('#lib/notifications.ts', () => ({
    createHighlight: vi.fn(),
    playNotificationSound: vi.fn(),
    updateTitle: vi.fn(),
    updateFavicon: vi.fn(),
    updateFavico: vi.fn(),
    startIndicatorOwner: () => () => {},
    refreshIndicators: vi.fn(),
    onDisconnect,
}));

/**
 * A socket that stays CONNECTING until the test says how it ended. A relay that is
 * down, a refused port, and a rejected credential all reach the app as a close event
 * with different codes, and the code is the only thing that distinguishes them.
 */
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
    close() { this.readyState = FakeSocket.CLOSED; }
    addEventListener() {}
    removeEventListener() {}

    /** Report the loss the way a browser would. */
    endWith(code: number) {
        this.readyState = FakeSocket.CLOSED;
        this.onerror?.({} as Event);
        this.onclose?.({ code, reason: '', wasClean: false } as CloseEvent);
    }
}

const PROFILE = {
    host: 'relay.example',
    port: 9001,
    path: 'weechat',
    password: 'testpassword123',
    tls: false,
    noCompression: true,
};

function lastSocket(): FakeSocket {
    const socket = FakeSocket.instances[FakeSocket.instances.length - 1];
    if (!socket) throw new Error('connect() did not open a socket');
    return socket;
}

function track<T>(p: Promise<T>): { outcome: () => 'pending' | 'resolved' | 'rejected' } {
    let outcome: 'pending' | 'resolved' | 'rejected' = 'pending';
    p.then(() => (outcome = 'resolved'), () => (outcome = 'rejected'));
    return { outcome: () => outcome };
}

/**
 * Start an attempt that never reaches the relay, and report how it ended.
 *
 * A tracked promise settles on a microtask, so the timer queue is flushed before it
 * is read — otherwise "rejected" is a claim about a callback that has not run yet.
 */
async function failFirstConnect(code: number) {
    const attempt = track(facadeConnect(PROFILE));
    lastSocket().endWith(code);
    await vi.advanceTimersByTimeAsync(0);
    return attempt;
}

beforeEach(() => {
    FakeSocket.instances = [];
    onDisconnect.mockClear();
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('this test must not probe'))));
    updateSettings({ protocol: 'legacy', autoconnect: true, useTotp: false, savepassword: false });
    // Module state survives between tests in a file, and `reconnectAttempts` is the
    // one that changes what the backoff ladder does.
    setReconnectAttempts(0);
});

afterEach(() => {
    if (pendingRetryState().active) legacy.transportAdapter.quiesce();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('a first connect that never reached the relay', () => {
    it('is retried when auto-reconnect is on, exactly like a lost session', async () => {
        const attempt = await failFirstConnect(1006);

        const pending = pendingRetryState();
        expect(pending.active, 'the user asked for auto-reconnect; a down relay is what it is for').toBe(true);
        expect(get(connectionState).status).toBe('reconnecting');
        expect(get(connectionState).reconnectAttempts).toBe(1);
        expect(get(connectionState).errors.serverUnreachable, '1006 is named as an unreachable relay').toBe(true);
        expect(attempt.outcome(), 'the attempt must still be settled for the caller').toBe('rejected');
    });

    it('settles only after the retry decision, so the caller sees the outcome the app chose', async () => {
        // The ordering is the whole point. `onerror` arrives before `onclose`, and
        // `onclose` is where the decision is made. Settling on `onerror` hands the
        // caller a rejection at a moment when the app has not yet decided whether it
        // is about to retry — which is how a retrying first connect ended up telling
        // the user to check their settings in one toast and "reconnecting in 30s" in
        // another.
        const attempt = track(facadeConnect(PROFILE));
        const socket = lastSocket();

        socket.onerror?.({} as Event);
        await vi.advanceTimersByTimeAsync(0);
        expect(attempt.outcome(), 'an error event alone is not the end of the attempt').toBe('pending');
        expect(pendingRetryState().active, 'no decision has been made yet').toBe(false);

        socket.onclose?.({ code: 1006, reason: '', wasClean: false } as CloseEvent);
        expect(pendingRetryState().active, 'the decision came first').toBe(true);
        await vi.advanceTimersByTimeAsync(0);
        expect(attempt.outcome(), 'and only then the rejection').toBe('rejected');
    });

    it('is not retried when auto-reconnect is off, and says why it stopped', async () => {
        updateSettings({ autoconnect: false });
        const attempt = await failFirstConnect(1006);

        expect(pendingRetryState().active, 'the user vetoed retries').toBe(false);
        expect(get(connectionState).status, 'a loss the app will not retry is an error').toBe('error');
        expect(get(connectionState).reconnectAttempts).toBe(0);
        expect(get(connectionState).errors.serverUnreachable).toBe(true);
        expect(attempt.outcome()).toBe('rejected');
    });

    it('is still terminal when the close names a rejected credential', async () => {
        // Auto-reconnect is on, so this is the branch that must stay ahead of the
        // retry: a rejected credential is not a fault the relay will recover from,
        // and trying it again spends the same password.
        for (const code of [401, 403]) {
            const attempt = await failFirstConnect(code);

            expect(pendingRetryState().active, `close code ${code} must not arm a retry`).toBe(false);
            expect(get(connectionState).reconnectAttempts, `close code ${code} is not an attempt`).toBe(0);
            expect(get(connectionState).errors.passwordError, `close code ${code} is named as a password problem`).toBe(true);
            expect(attempt.outcome(), `close code ${code} must not leave the caller waiting`).toBe('rejected');
        }
    });

    it('retries on the backoff ladder, not immediately', async () => {
        failFirstConnect(1006);

        // The first retry is the first rung of the ladder, the same one a lost
        // session walks. A down relay should not be hammered.
        await vi.advanceTimersByTimeAsync(29_000);
        expect(FakeSocket.instances, 'the ladder has not reached its first rung yet').toHaveLength(1);

        await vi.advanceTimersByTimeAsync(2_000);
        expect(FakeSocket.instances, 'the scheduled attempt actually opened a socket').toHaveLength(2);
    });
});
