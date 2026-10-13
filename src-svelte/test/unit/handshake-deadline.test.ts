/**
 * The handshake deadline.
 *
 * A relay that accepts the TCP connection and never answers the WebSocket
 * upgrade reports nothing to the browser: no `open`, no `close`, no `error`.
 * Before this there was no bound on it anywhere, and the consequence was not a
 * cosmetic stall — the status stayed `'connecting'`, and `ConnectionForm`
 * disables its own Connect button on that status, so the user could not retry,
 * cancel, or edit the address. Only a page reload escaped.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { connectionState } from '#lib/stores/connectionStore.ts';
import { updateSettings } from '#lib/stores/settings.ts';
import { connect as facadeConnect, disconnect as facadeDisconnect } from '#lib/stores/connectionManager.ts';
import { HANDSHAKE_TIMEOUT_MS, pendingRetryState } from '#lib/stores/connectionLifecycle.ts';
import * as legacy from '#lib/stores/legacyConnection.ts';

// `resetAppState()` calls it, so counting it counts wipes — which is what a
// deadline and a late close event must not each do.
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

class FakeSocket {
    static readonly OPEN = 1;
    static readonly CONNECTING = 0;
    static readonly CLOSED = 3;
    static instances: FakeSocket[] = [];

    readyState = FakeSocket.CONNECTING;
    closeCalls: Array<{ code?: number; reason?: string }> = [];
    /**
     * A browser is allowed to deliver `close` for a socket closed while it was
     * still CONNECTING. Off by default so the other tests can observe the
     * deadline alone; on for the test that checks the deadline and a real close
     * event do not both run the loss path.
     */
    deliverCloseOnClose = false;
    onopen: ((ev: Event) => void) | null = null;
    onclose: ((ev: CloseEvent) => void) | null = null;
    onerror: ((ev: Event) => void) | null = null;
    onmessage: ((ev: MessageEvent) => void) | null = null;

    constructor(public url: string) {
        FakeSocket.instances.push(this);
    }
    send() {}
    close(code?: number, reason?: string) {
        this.closeCalls.push({ code, reason });
        this.readyState = FakeSocket.CLOSED;
        if (this.deliverCloseOnClose) {
            this.onclose?.({ code: code ?? 1006, reason: '', wasClean: false } as CloseEvent);
        }
    }
    addEventListener() {}
    removeEventListener() {}
}

const PROFILE = {
    host: 'relay.example',
    port: 9001,
    path: 'weechat',
    password: 'testpassword123',
    tls: false,
    noCompression: true,
};

/** The last socket the facade opened. */
function lastSocket(): FakeSocket {
    const socket = FakeSocket.instances[FakeSocket.instances.length - 1];
    if (!socket) throw new Error('connect() did not open a socket');
    return socket;
}

/** Track a promise's outcome without awaiting it, so "still pending" is observable. */
function track<T>(p: Promise<T>): { outcome: () => 'pending' | 'resolved' | 'rejected' } {
    let outcome: 'pending' | 'resolved' | 'rejected' = 'pending';
    p.then(() => (outcome = 'resolved'), () => (outcome = 'rejected'));
    // A getter, not the value at call time: the whole point is to read it later.
    return { outcome: () => outcome };
}

beforeEach(() => {
    FakeSocket.instances = [];
    onDisconnect.mockClear();
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('this test must not probe'))));
    updateSettings({ protocol: 'legacy', autoconnect: false, useTotp: false });
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('the handshake deadline', () => {
    it('ends an attempt whose socket never opens and never closes', async () => {
        vi.useFakeTimers();
        const attempt = track(facadeConnect(PROFILE));

        await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS - 1000);
        expect(attempt.outcome(), 'the deadline has not passed yet').toBe('pending');
        expect(legacy.isAttemptInProgress()).toBe(true);
        expect(get(connectionState).status).toBe('connecting');

        await vi.advanceTimersByTimeAsync(2000);

        expect(attempt.outcome(), 'an await on a hung attempt must not outlive the page').toBe('rejected');
        expect(legacy.isAttemptInProgress(), 'the attempt may not stay in flight').toBe(false);
        expect(get(connectionState).status, 'the transport\'s own outcome for a lost attempt').toBe('disconnected');
        expect(get(connectionState).errors.serverUnreachable, 'a handshake timeout is an unreachable relay').toBe(true);
    });

    it('closes the socket it gave up on', async () => {
        vi.useFakeTimers();
        const socket = lastSocketAfterConnect();

        await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS + 2000);

        // No invented close code: 1006 is what a socket that never opened is,
        // and it is the code `detectError()` already names as unreachable.
        expect(socket.closeCalls, 'the dead socket must not be left open').toHaveLength(1);
        expect(socket.closeCalls[0]?.code, 'a code the server never saw would be a claim nothing earned').toBeUndefined();
        expect(socket.readyState).toBe(FakeSocket.CLOSED);
    });

    it('does not invent a second retry loop for a first connect that timed out', async () => {
        vi.useFakeTimers();
        track(facadeConnect(PROFILE));

        await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS + 2000);

        // The retry decision belongs to handleReconnectDecision(), and a first
        // connect that never became a session is not yet a loss to recover from.
        expect(pendingRetryState().active).toBe(false);
    });

    it('leaves no deadline armed behind a Leave', async () => {
        vi.useFakeTimers();
        const socket = lastSocketAfterConnect();

        facadeDisconnect();
        await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS + 5000);

        expect(get(connectionState).status, 'a Leave is the outcome; a later timer must not rewrite it').toBe('disconnected');
        expect(socket.closeCalls.length, 'the Leave closed it once').toBe(1);
    });

    it('runs the loss path once, even when the browser also reports the close', async () => {
        vi.useFakeTimers();
        const socket = lastSocketAfterConnect();
        // A browser may deliver `close` for a socket closed while it was still
        // CONNECTING. The deadline silences the socket's handlers before closing
        // it; if that silencing were soft, both the inline loss and the event
        // would run, and the app would wipe a session twice.
        socket.deliverCloseOnClose = true;

        await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS + 2000);

        expect(onDisconnect, 'one deadline is one loss').toBeInstanceOf(Function);
        expect(onDisconnect.mock.calls.length, 'a late close event must not run the loss path again').toBe(1);
        expect(socket.closeCalls.length, 'and must not close the socket again either').toBe(1);
    });

    it('bounds the attempt that is live now, not the one a reconnect replaced', async () => {
        vi.useFakeTimers();
        const first = lastSocketAfterConnect();

        // A connect while one is hung replaces it: the facade quiesces both
        // transports first, which disarms the hung attempt's deadline along with
        // everything else that attempt owned.
        const second = track(facadeConnect(PROFILE));
        const secondSocket = lastSocket();
        expect(FakeSocket.instances.length, 'the replacement opened its own socket').toBe(2);

        await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS + 2000);

        expect(first.readyState, 'the replaced socket is closed').toBe(FakeSocket.CLOSED);
        expect(first.closeCalls.length, 'once, by the replacement — not again by an older deadline').toBe(1);
        expect(second.outcome(), 'the live attempt is bounded by its own deadline').toBe('rejected');
        expect(secondSocket.readyState).toBe(FakeSocket.CLOSED);
        expect(legacy.isAttemptInProgress(), 'and it ends as an attempt, not as a hang').toBe(false);
    });
});

function lastSocketAfterConnect(): FakeSocket {
    track(facadeConnect(PROFILE));
    return lastSocket();
}
