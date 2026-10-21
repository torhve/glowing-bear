/**
 * The disconnect toast's Reconnect button — the only way back from a refused
 * credential, and pressed by nothing until now.
 *
 * A 401/403 is terminal on either transport: no retry loop runs, so the banner offers
 * nothing and the toast is the whole interface. E2E checks that the toast appears and
 * clears; no test invoked the callback it carries. That callback is the transport's
 * manual reconnect, and both transports used to reach it through identical local
 * wrappers, so what is pinned here is the binding: pressing Reconnect starts a fresh
 * attempt on the transport that was refused, rather than dismissing a message.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { updateSettings } from '#lib/stores/settings.ts';
import { connectionState } from '#lib/stores/connectionStore.ts';
import { connect as facadeConnect } from '#lib/stores/connectionManager.ts';
import * as legacy from '#lib/stores/legacyConnection.ts';

// A toast list that actually remembers what was added: `showDisconnectToast()` reads
// it to avoid stacking a second message for the same failure, so a mock that always
// answers "nothing up" would make that rule untestable and this file would prove less
// than it claims.
const toastWorld = vi.hoisted(() => {
    const toasts: Array<{ message?: string; type?: string }> = [];
    const addToast = vi.fn((message: string, options: { type?: string } = { type: 'info' }) => {
        toasts.push({ message, type: options?.type });
    });
    return { toasts, addToast };
});

vi.mock('#lib/toast.ts', () => ({
    addToast: toastWorld.addToast,
    removeToast: vi.fn(),
    updateToast: vi.fn(),
    toastStore: {
        subscribe: (run: (value: Array<{ message?: string; type?: string }>) => void) => {
            run(toastWorld.toasts);
            return () => {};
        },
    },
}));

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

/** A relay that answers the TCP handshake and then refuses the credential. */
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

async function refuseCredential(code: number) {
    void facadeConnect(PROFILE).catch(() => undefined);
    lastSocket().endWith(code);
    await vi.advanceTimersByTimeAsync(0);
}

interface ToastOptions {
    duration: number;
    buttons?: Array<{ text: string; action: () => void }>;
}

beforeEach(() => {
    FakeSocket.instances = [];
    toastWorld.addToast.mockClear();
    toastWorld.toasts.length = 0;
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('this test must not probe'))));
    updateSettings({ protocol: 'legacy', autoconnect: true, useTotp: false, savepassword: false });
});

afterEach(() => {
    legacy.transportAdapter.quiesce();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('the disconnect toast', () => {
    it('offers a Reconnect and starts a fresh attempt when it is pressed', async () => {
        await refuseCredential(403);

        expect(get(connectionState).status, 'a refusal is a named failure').toBe('error');
        expect(get(connectionState).errors.passwordError).toBe(true);

        const call = toastWorld.addToast.mock.calls.at(-1);
        expect(call, 'a terminal refusal must leave the user something to press').toBeDefined();

        const options = call![1] as ToastOptions;
        expect(options.duration, 'a failure the app will not retry must not disappear on a timer').toBe(0);

        const reconnect = options.buttons?.find((button) => button.text === 'Reconnect');
        expect(reconnect, 'the toast carries a Reconnect button').toBeDefined();

        const attemptsBefore = FakeSocket.instances.length;
        reconnect!.action();
        await vi.advanceTimersByTimeAsync(0);

        expect(FakeSocket.instances.length, 'pressing it opens a new attempt').toBeGreaterThan(attemptsBefore);
        expect(get(connectionState).status, 'and the app says so').toBe('connecting');
    });

    it('does not stack a second toast for the same refusal', async () => {
        // Two attempts at the same wrong password are one message, not two. The
        // guard lives in the shared toast helper and reads the live toast list, so
        // and the mock keeps what was added, so the guard is exercised for real.
        await refuseCredential(403);
        const first = toastWorld.addToast.mock.calls.length;

        await refuseCredential(403);

        expect(FakeSocket.instances.length, 'the second refusal was a real attempt').toBe(2);
        expect(toastWorld.addToast.mock.calls.length, 'a repeated refusal is still one message').toBe(first);
    });
});
