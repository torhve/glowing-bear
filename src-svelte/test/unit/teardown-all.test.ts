/**
 * `teardownAll()` — the one teardown a Leave performs.
 *
 * The facade used to call both transports' `disconnect()`. Nothing visible broke,
 * because every step of a wipe happened to tolerate running twice. That is the
 * whole reason this file exists: it measures the number of times the cleanup runs,
 * which is the property the refactor was for and which no existing test pinned.
 * A future wipe that is NOT idempotent would have been silently wrong.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { activeTransport, connectionState } from '#lib/stores/connectionStore.ts';
import { updateSettings } from '#lib/stores/settings.ts';
import { buffers, connected } from '#lib/stores/models.ts';
import { connect as facadeConnect, disconnect as facadeDisconnect } from '#lib/stores/connectionManager.ts';
import { transportAdapterFor } from '#lib/stores/connectionLifecycle.ts';

// The counter this file is about. `resetAppState()` calls it, so counting it
// counts wipes.
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
    }
    addEventListener() {}
    removeEventListener() {}
}

function connectLegacy(): FakeSocket {
    // The rejection is expected here: a teardown settles an attempt that never
    // completed its handshake. Swallowing it is the same rule every production
    // call site of connect() follows.
    void facadeConnect({
        host: 'relay.example',
        port: 9001,
        path: 'weechat',
        password: 'testpassword123',
        tls: false,
        noCompression: true,
    }).catch(() => undefined);
    const socket = FakeSocket.instances[FakeSocket.instances.length - 1];
    if (!socket) throw new Error('facadeConnect() did not open a socket');
    socket.readyState = FakeSocket.OPEN;
    return socket;
}

beforeEach(() => {
    FakeSocket.instances = [];
    onDisconnect.mockClear();
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('this test must not probe'))));
    updateSettings({ protocol: 'legacy', autoconnect: true, useTotp: false });
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('teardownAll', () => {
    it('wipes once, not once per transport', () => {
        connectLegacy();
        expect(get(activeTransport)).toBe('legacy');

        facadeDisconnect();

        // The point of the change. Two transports' full teardowns would run this
        // twice, and every step of the wipe currently tolerates that — so the
        // only way to see the duplication is to count it.
        expect(onDisconnect, 'a Leave must run the shared cleanup exactly once').toHaveBeenCalledTimes(1);
    });

    it('closes the active transport\'s socket', () => {
        const socket = connectLegacy();

        facadeDisconnect();

        expect(socket.closeCalls).toEqual([{ code: 1000, reason: 'user disconnect' }]);
    });

    it('writes the outcome once, whichever transport was active', () => {
        connectLegacy();

        facadeDisconnect();

        const state = get(connectionState);
        expect(state.status).toBe('disconnected');
        expect(state.userDisconnect, 'a Leave is a deliberate departure').toBe(true);
        expect(get(connected)).toBe(false);
        expect(get(activeTransport), 'no transport is active after a Leave').toBeNull();
    });

    it('wipes even when no transport was ever selected', () => {
        // A connect attempt that failed before a transport was chosen can still
        // leave stores describing it, and there is no transport left to do the
        // wiping. The dual `disconnect()` covered this by wiping unconditionally;
        // an adapter-driven teardown must not lose it.
        connectLegacy();
        facadeDisconnect();
        onDisconnect.mockClear();

        buffers.update((current) => ({
            ...current,
            '99': { id: '99', number: 99, name: '#leftover', shortName: '#leftover', lines: [], allLinesFetched: true, lastSeen: 0 },
        }));
        expect(Object.keys(get(buffers))).toHaveLength(1);

        facadeDisconnect();

        expect(get(buffers), 'a Leave with nothing to tear down must still clear the stores').toEqual({});
    });
});

describe('the transport a teardown does not tear down', () => {
    // `teardownAll()` quiesces the inactive adapter instead of tearing it down,
    // which is only safe if `quiesce()` is a hard close. That was an argument
    // about how `connect()` is built; these pin it as a property of the adapter
    // instead, so a `quiesce()` weakened into a flag cannot pass unnoticed.
    //
    // The API side's close is pinned where it is implemented: api-session.test.ts
    // 'destroy rejects pending, closes socket and silences late frames', and
    // `quiesce()` reaches it through `orchestrator.stop() -> supersedeCurrent() ->
    // session.destroy()`.
    it('quiesce closes the socket it takes over and leaves no live session', () => {
        const socket = connectLegacy();

        transportAdapterFor('legacy')!.quiesce();

        expect(socket.closeCalls, 'quiesce must be a close, not a flag').toHaveLength(1);
        expect(socket.readyState).toBe(FakeSocket.CLOSED);
        expect(transportAdapterFor('legacy')!.hasLiveSession()).toBe(false);
    });

    it('leaves neither adapter holding a session, an attempt, or a retry', () => {
        connectLegacy();

        facadeDisconnect();

        for (const kind of ['api', 'legacy'] as const) {
            const adapter = transportAdapterFor(kind)!;
            expect(adapter.hasLiveSession(), `${kind} must not hold a session after a Leave`).toBe(false);
            expect(adapter.isAttemptInProgress(), `${kind} must not leave an attempt in flight`).toBe(false);
            expect(adapter.pendingRetry().active, `${kind} must not leave a retry armed`).toBe(false);
        }
    });
});
