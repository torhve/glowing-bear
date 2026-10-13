/**
 * What the stats popover counts.
 *
 * The popover pairs Sent / Recv / messages with Uptime. Uptime belongs to a live
 * connection — `setConnectionStatus` clears it for every non-connected status,
 * with a written reason. The traffic counters did not follow that rule: they
 * accumulated across reconnects, so after a reconnect the popover attributed the
 * previous session's traffic to the session now on screen (measured in a browser:
 * 737 B / 6.9 KB / 24 messages before a drop, 1.3 KB / 9.8 KB / 42 messages
 * after the auto-reconnect, next to an uptime that had restarted).
 *
 * The rule is now single: the counters describe the most recent attempt, and only
 * the start of an attempt clears them. A loss leaves the numbers of the session
 * that just ended, because that is the session the retained view is still
 * showing; clearing them at the wipe would zero the popover beside messages that
 * belong to a dead session.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import {
    beginSessionStats,
    connectionStats,
    recordBytesReceived,
    recordBytesSent,
} from '#lib/stores/connectionStore.ts';
import { updateSettings } from '#lib/stores/settings.ts';
import { connect as facadeConnect, disconnect as facadeDisconnect } from '#lib/stores/connectionManager.ts';

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
    static instances: FakeSocket[] = [];
    readyState = 1; // OPEN: this file is about the counters, not the handshake
    onopen: ((ev: Event) => void) | null = null;
    onclose: ((ev: CloseEvent) => void) | null = null;
    onerror: ((ev: Event) => void) | null = null;
    onmessage: ((ev: MessageEvent) => void) | null = null;
    constructor(public url: string) {
        FakeSocket.instances.push(this);
    }
    send() {}
    close() {
        this.readyState = 3;
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

function lastSocket(): FakeSocket {
    const socket = FakeSocket.instances[FakeSocket.instances.length - 1];
    if (!socket) throw new Error('connect() did not open a socket');
    return socket;
}

/** Traffic as the popover would render it. */
function traffic() {
    const s = get(connectionStats);
    return { sent: s.bytesSent, received: s.bytesReceived, messages: s.messagesSent + s.messagesReceived };
}

beforeEach(() => {
    FakeSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('this test must not probe'))));
    updateSettings({ protocol: 'legacy', autoconnect: false, useTotp: false });
    beginSessionStats();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('the stats popover counts one attempt', () => {
    it('starts the counters when an attempt starts', () => {
        recordBytesSent(500);
        recordBytesReceived(1_000);
        expect(traffic().received).toBe(1_000);

        beginSessionStats();

        expect(traffic(), 'a new attempt may not inherit the previous one').toEqual({ sent: 0, received: 0, messages: 0 });
        expect(get(connectionStats).connectedSince, 'and it has no uptime yet').toBe(0);
    });

    it('is started by the transport, not left to the caller to remember', async () => {
        void facadeConnect(PROFILE).catch(() => undefined);
        recordBytesSent(120);
        recordBytesReceived(4_000);
        expect(traffic().received, 'the session recorded its own traffic').toBe(4_000);

        // A scheduled retry, a manual takeover and a first connect all open a
        // socket through the same function, so one call site covers all three.
        void facadeConnect(PROFILE).catch(() => undefined);
        expect(traffic(), 'the newer attempt starts its own counters').toEqual({ sent: 0, received: 0, messages: 0 });
    });

    it('keeps the numbers of a session that was lost, until a newer attempt replaces them', async () => {
        void facadeConnect(PROFILE).catch(() => undefined);
        const socket = lastSocket();
        recordBytesReceived(2_000);

        socket.onclose?.({ code: 3000, reason: '', wasClean: false } as CloseEvent);

        // The wipe is real — the buffers are gone — but the retained view is still
        // showing this session's messages, and the popover must describe the same
        // session the user is looking at.
        expect(traffic().received, 'a loss does not erase what the session moved').toBe(2_000);

        void facadeConnect(PROFILE).catch(() => undefined);
        expect(traffic().received, 'a newer attempt replaces them').toBe(0);
    });

    it('does not clear them on a Leave, because a Leave is not the start of an attempt', async () => {
        void facadeConnect(PROFILE).catch(() => undefined);
        recordBytesReceived(3_000);

        facadeDisconnect();

        expect(traffic().received, 'the last attempt is still what the popover describes').toBe(3_000);
        expect(get(connectionStats).connectedSince, 'but a Leave has no uptime').toBe(0);
    });
});
