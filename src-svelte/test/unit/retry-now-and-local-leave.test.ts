/**
 * Task 3: the facade's retry/leave commands.
 *
 * Two decisions this pins.
 *
 * 1. Leave is LOCAL. The legacy transport used to send a quit frame on
 *    disconnect — faithful to upstream Angular Glowing Bear, and wrong whatever
 *    a relay does with it: leaving a session must not carry a command that quits
 *    the user's WeeChat. Live probe on gbtest's WeeChat 4.10.1: the bare `quit`
 *    line that Protocol.formatQuit() produces is not part of the relay's command
 *    grammar (a command reaches WeeChat as `input <buffer> <data>`), so it was
 *    inert there — logged as a plain client disconnect, no command executed,
 *    WeeChat stayed up. Inert is not the same as correct, and it made Leave read
 *    as if it quit WeeChat when it did not. The API transport already refused
 *    this explicitly. Quitting WeeChat stays available, but only as a command the
 *    user types: InputBar gates /quit behind a confirm and sends it through
 *    `sendWeeChatCommand`, which is the form the relay does accept.
 *
 * 2. Retry delegates; it never reconnects. The facade's own connect() probes
 *    the relay to classify it, and a probe that fails mid-retry would move a
 *    session onto the other protocol — the mid-connection fallback the
 *    dual-protocol rule forbids. So retryNow() must reach the transport's own
 *    takeover path and must not touch the network.
 *
 * A fake WebSocket stands in for the relay. Its readyState is forced OPEN
 * before Leave so the removed /quit guard WOULD have fired: with a CONNECTING
 * socket the assertion passes for the wrong reason.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { activeTransport, connectionState } from '#lib/stores/connectionStore.ts';
import { updateSettings } from '#lib/stores/settings.ts';
import {
    connect as facadeConnect,
    disconnect as facadeDisconnect,
    getActiveTransport,
    retryNow,
    sendWeeChatCommand,
} from '#lib/stores/connectionManager.ts';
import * as legacy from '#lib/stores/legacyConnection.ts';
import { pendingRetryState } from '#lib/stores/connectionLifecycle.ts';

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

    sent: string[] = [];
    closeCalls: Array<{ code?: number; reason?: string }> = [];
    readyState = FakeSocket.CONNECTING;
    binaryType = '';
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;

    constructor(public url: string) {
        FakeSocket.instances.push(this);
    }

    send(data: unknown): void {
        this.sent.push(typeof data === 'string' ? data : `<binary ${data instanceof ArrayBuffer ? data.byteLength : typeof data}>`);
    }

    close(code?: number, reason?: string): void {
        this.closeCalls.push({ code, reason });
        this.readyState = FakeSocket.CLOSED;
    }

    sentQuitFrame(): boolean {
        return this.sent.some((frame) => frame.includes('quit'));
    }
}

/**
 * Connect through the facade with the protocol pinned to legacy, so the
 * transport is selected the way production selects it and no probe runs.
 * `connect()` never resolves without a handshake, so it is deliberately not
 * awaited — the socket exists synchronously.
 */
function connectLegacy(): FakeSocket {
    // Caught on purpose. These tests kill the socket, so the connect promise is
    // expected to reject; the app's own call sites already catch it
    // (legacyConnection.ts). Left uncaught it surfaces as an unhandled rejection,
    // which fails the suite for a condition the app cannot produce.
    facadeConnect({
        host: 'relay.example',
        port: 9001,
        path: 'weechat',
        password: 'testpassword123',
        tls: false,
        noCompression: true,
    }).catch(() => undefined);
    const socket = FakeSocket.instances[FakeSocket.instances.length - 1];
    if (!socket) throw new Error('facadeConnect() did not open a socket');
    // The removed guard was `readyState === WebSocket.OPEN`. A CONNECTING
    // socket would make "no /quit was sent" true for the wrong reason.
    socket.readyState = FakeSocket.OPEN;
    return socket;
}

/** Simulate a lost session: the socket dies after a real bootstrap. */
function loseSession(socket: FakeSocket): void {
    connectionState.update((current) => ({ ...current, wasEverConnected: true }));
    socket.onclose?.({ code: 1006, reason: '', wasClean: false } as CloseEvent);
}

function fetchMock(): ReturnType<typeof vi.fn> {
    return globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
}

beforeEach(() => {
    FakeSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeSocket);
    // Any probe becomes a visible call; retryNow() must never make one.
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('retryNow must not probe'))));
    // Reset both transports and the facade's selected transport: connect()
    // refuses a duplicate while `connecting` is still true.
    facadeDisconnect();
    updateSettings({ protocol: 'legacy', autoconnect: true, useTotp: false });
    connectionState.update((current) => ({ ...current, userDisconnect: false, wasEverConnected: false }));
});

describe('Leave is local-only on the legacy transport', () => {
    it('sends no frame at all before closing the socket', () => {
        const socket = connectLegacy();

        // Reached through the adapter, which is the only thing that calls it:
        // tearing down a transport's own session is not a public command.
        legacy.transportAdapter.teardown();

        expect(socket.sent, 'a Leave must not send /quit').toHaveLength(0);
        expect(socket.closeCalls).toEqual([{ code: 1000, reason: 'user disconnect' }]);
    });

    it('sends no frame through the facade either', () => {
        const socket = connectLegacy();

        facadeDisconnect();

        expect(socket.sentQuitFrame(), 'the facade must not reintroduce /quit').toBe(false);
        expect(socket.sent, 'a Leave must not send anything').toHaveLength(0);
        expect(socket.closeCalls).toEqual([{ code: 1000, reason: 'user disconnect' }]);
    });

    it('still sends /quit when the user asks for it as a command', () => {
        const socket = connectLegacy();

        void sendWeeChatCommand('/quit');

        expect(socket.sentQuitFrame(), 'the composer path must keep working').toBe(true);
    });
});

describe('retryNow delegates to the transport that owns the profile', () => {
    it('reports in-progress while a handshake is running, so clicks cannot stack', () => {
        connectLegacy();

        expect(retryNow()).toBe('in-progress');
        expect(FakeSocket.instances).toHaveLength(1);
    });

    it('replaces the pending scheduled retry instead of adding a second loop', () => {
        vi.useFakeTimers();
        try {
            const socket = connectLegacy();
            loseSession(socket);
            expect(pendingRetryState().active, 'the loss must have scheduled a backoff retry').toBe(true);

            expect(retryNow()).toBe('retried');

            // The scheduled attempt is gone; only the immediate takeover remains.
            // Asserted on the retry loop itself rather than by counting timers:
            // an attempt that is in flight now legitimately arms its own
            // handshake deadline, and a count cannot tell those apart.
            expect(pendingRetryState().active, 'the takeover must not leave a second loop armed').toBe(false);
            expect(FakeSocket.instances).toHaveLength(2);
        } finally {
            legacy.transportAdapter.teardown();
            vi.useRealTimers();
        }
    });

    it('never probes, even when the protocol setting says auto', () => {
        const socket = connectLegacy();
        loseSession(socket);
        expect(fetchMock(), 'the pinned-legacy connect must not have probed').not.toHaveBeenCalled();

        // A user switching to 'auto' while offline must not turn a retry into a
        // re-classification: that is exactly the mid-connection fallback.
        updateSettings({ protocol: 'auto' });

        expect(retryNow()).toBe('retried');

        expect(fetchMock(), 'retryNow must not re-classify the relay').not.toHaveBeenCalled();
        expect(getActiveTransport()).toBe('legacy');
        expect(get(activeTransport)).toBe('legacy');
        expect(FakeSocket.instances).toHaveLength(2);
        expect(socket.url).toContain('9001');
    });

    it('refuses to retry after an explicit Leave', () => {
        connectLegacy();
        facadeDisconnect();

        // connectionData is cleared and userDisconnect is set; either alone must
        // stop a retry from resurrecting a profile the user left.
        expect(retryNow()).toBe('no-retry-loop');
        expect(FakeSocket.instances).toHaveLength(1);
    });

    it('refuses to retry when no transport was ever selected', () => {
        expect(getActiveTransport()).toBeNull();
        expect(retryNow()).toBe('no-retry-loop');
    });

    it('routes TOTP sessions to credential entry instead of reusing a stale code', () => {
        connectLegacy();
        loseSession(FakeSocket.instances[0]!);
        updateSettings({ useTotp: true });

        expect(retryNow()).toBe('needs-credentials');
        expect(FakeSocket.instances, 'a stale TOTP code must not be replayed').toHaveLength(1);
    });

    it('refuses without pretending a connect happened: userDisconnect stays set', () => {
        // retryNow() must not clear the flag. Only a successful handshake does
        // (apiConnection 'connected', legacyConnection handshake-complete), so a
        // refused retry cannot manufacture the state a real connect earns.
        connectLegacy();
        facadeDisconnect();
        expect(get(connectionState).userDisconnect).toBe(true);

        expect(retryNow()).toBe('no-retry-loop');
        expect(get(connectionState).userDisconnect).toBe(true);
    });

    it('a hung attempt blocks the existing Reconnect path too, so the guard adds no new lockout', () => {
        // `connecting` is cleared only by resetAllState(), which runs from
        // onclose/onerror/failed — a socket that neither opens nor closes leaves
        // it true indefinitely, and neither transport has a handshake timeout.
        // That is pre-existing: legacyConnection.connect() already refuses a
        // duplicate while `connecting` is true, which is what the toast's
        // Reconnect button goes through. isAttemptInProgress() surfaces the same
        // condition at the facade rather than introducing it.
        connectLegacy();
        expect(legacy.isAttemptInProgress(), 'no onopen, no onclose: still in progress').toBe(true);

        const socketsBefore = FakeSocket.instances.length;
        void legacy.connect({
            host: 'relay.example',
            port: 9001,
            path: 'weechat',
            password: 'testpassword123',
            tls: false,
            noCompression: true,
        });
        expect(FakeSocket.instances, 'the pre-existing duplicate guard').toHaveLength(socketsBefore);

        expect(retryNow()).toBe('in-progress');
    });
});
