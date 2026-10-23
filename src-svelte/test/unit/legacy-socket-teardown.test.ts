/**
 * The legacy transport's socket teardown, pinned at the point a refactor moved.
 *
 * `closeAllSockets(reason)` replaced four hand-written copies of "close every
 * tracked socket, clear the set, drop the current one". Three of the copies were
 * unconditional; the one at user disconnect was wrapped in
 * `if (webSockets.size > 0)`. That wrapper is the interesting part, because the
 * set and the current socket are not the same fact: `ws.onclose` removes its own
 * socket from the set and deliberately does *not* clear `ws`, so a transport can
 * hold a current socket that is already closed and untracked.
 *
 * Under the guard, teardown left that stale `ws` in place until the next
 * `connect()` happened to clear it. `ws` is what the close handlers compare
 * against to decide whether a socket is still their connection, so a stale one is
 * not merely untidy. These tests pin the precondition and the change together —
 * the precondition first, because an assertion that only holds when the stale
 * state never happened would prove nothing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { updateSettings } from '#lib/stores/settings.ts';
import {
    connect as facadeConnect,
    disconnect as facadeDisconnect,
} from '#lib/stores/connectionManager.ts';
import * as legacy from '#lib/stores/legacyConnection.ts';

vi.mock('#lib/notifications.ts', async () => (await import('./helpers/mockNotifications.ts')).mockNotifications());

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

    send(): void {}

    close(code?: number, reason?: string): void {
        this.closeCalls.push({ code, reason });
        this.readyState = FakeSocket.CLOSED;
    }
}

/**
 * Start a legacy attempt without awaiting it: `connect()` only settles on a
 * handshake these tests never complete, and the socket exists synchronously.
 */
function connectLegacy(): FakeSocket {
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
    socket.readyState = FakeSocket.OPEN;
    return socket;
}

beforeEach(() => {
    FakeSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('these tests must not probe'))));
    facadeDisconnect();
    // autoconnect off so a simulated loss settles instead of arming a 30 s timer
    // the test would then have to wait out or cancel.
    updateSettings({ protocol: 'legacy', autoconnect: false, useTotp: false });
});

describe('legacy socket teardown', () => {
    it('closes the tracked socket with its reason and drops the current one', () => {
        const socket = connectLegacy();

        legacy.transportAdapter.teardown();

        expect(socket.closeCalls).toEqual([{ code: 1000, reason: 'user disconnect' }]);
        expect(legacy.getWs()).toBeNull();
    });

    it('drops a stale current socket even when the tracking set is already empty', () => {
        const socket = connectLegacy();

        // Build the precondition the guard used to skip: a close removes its own
        // socket from tracking and leaves `ws` pointing at it.
        socket.onclose?.({ code: 1006, reason: '', wasClean: false } as CloseEvent);
        expect(legacy.getWs(), 'the stale socket is the state under test').toBe(socket);

        legacy.transportAdapter.teardown();

        expect(legacy.getWs(), 'teardown must not leave a closed socket as current').toBeNull();
    });

    it('does nothing when there is no socket, and does not throw', () => {
        expect(legacy.getWs()).toBeNull();

        expect(() => legacy.transportAdapter.teardown()).not.toThrow();
        expect(FakeSocket.instances).toHaveLength(0);
    });

    it('is not undone by a close that arrives after the teardown', () => {
        const socket = connectLegacy();

        legacy.transportAdapter.teardown();
        expect(legacy.getWs()).toBeNull();

        // The close event for a socket we closed arrives late. It must not put the
        // dead socket back as the current one.
        socket.onclose?.({ code: 1000, reason: 'user disconnect', wasClean: true } as CloseEvent);

        expect(legacy.getWs()).toBeNull();
        expect(socket.closeCalls).toEqual([{ code: 1000, reason: 'user disconnect' }]);
    });
});
