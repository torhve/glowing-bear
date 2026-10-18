/**
 * What a failed connection attempt is allowed to leave behind.
 *
 * Issue #12: a user who pinned Settings → Relay protocol and failed could not get
 * back to 'auto', because the connection form has no protocol control and the
 * settings modal belongs to a chat shell this attempt never produced. Two rules
 * make that recoverable, and both are pinned here.
 *
 * 1. `transportByProfile` records only what a session proved. A pinned attempt
 *    used to write its transport into the cache before it had connected, so
 *    putting the setting back on Auto replayed the transport that had just
 *    failed — the address was stuck on it until a page reload.
 * 2. A failure that proves nothing about the address names the pin
 *    (`protocolUnansweredError`), which is what lets the connection form offer the
 *    way back. A failure carrying an answer only the pinned protocol could
 *    produce — a refused credential — names the credential instead.
 *
 * The cache is module-private, so it is read through the only thing it changes:
 * whether the next 'auto' attempt probes (a `fetch` to /api/handshake) or reuses
 * the cached transport without touching the network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { activeTransport, connectionState } from '#lib/stores/connectionStore.ts';
import { updateSettings } from '#lib/stores/settings.ts';
import { connect as facadeConnect, disconnect as facadeDisconnect } from '#lib/stores/connectionManager.ts';
import { pendingRetryState } from '#lib/stores/connectionLifecycle.ts';
import * as api from '#lib/stores/apiConnection.ts';
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
 * A legacy socket that stays CONNECTING until the test says how it ended. A down
 * relay and a refused credential reach the app as close events with different
 * codes, and the code is the only thing that distinguishes them.
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

/** Every network call the facade or the API transport made, probes included. */
let networkCalls: string[] = [];
/** When true, `fetch` never settles: only the app's own abort ends that attempt. */
let hangFetch = false;

function lastSocket(): FakeSocket {
    const socket = FakeSocket.instances[FakeSocket.instances.length - 1];
    if (!socket) throw new Error('connect() did not open a socket');
    return socket;
}

/**
 * Run one attempt to its failure.
 *
 * `endWith` is only meaningful for the legacy transport; an API attempt dies on
 * its first request. The timer queue is flushed first so the API transport has
 * reached that request, and last so the rejection the app settled on is visible.
 */
async function runFailingAttempt(endWith?: number) {
    const attempt = settle(facadeConnect(PROFILE));
    await vi.advanceTimersByTimeAsync(0);
    if (endWith !== undefined && FakeSocket.instances.length) lastSocket().endWith(endWith);
    expect(await attempt, 'the attempt must settle as a failure').toBeInstanceOf(Error);
}

/**
 * Start an attempt with its outcome already reachable.
 *
 * The handlers attach in the same tick the promise is created. An attempt can
 * reject inside a later `advanceTimersByTimeAsync`, and a rejection that lands
 * before any handler exists is an unhandled rejection even when the test awaits
 * that promise one line later — which is how a passing test still reported errors.
 */
function settle(attempt: Promise<void>): Promise<unknown> {
    return attempt.then(
        () => undefined,
        (error: unknown) => error,
    );
}
beforeEach(() => {
    FakeSocket.instances = [];
    networkCalls = [];
    hangFetch = false;
    onDisconnect.mockClear();
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeSocket);
    // One stub for both shapes of network call: the API handshake request and the
    // auto-detection probe. Neither ever answers here, which is the point — these
    // tests are about what the app remembers afterwards.
    vi.stubGlobal('fetch', vi.fn((input: unknown) => {
        networkCalls.push(String(input));
        if (hangFetch) return new Promise<Response>(() => {});
        return Promise.reject(new TypeError('Failed to fetch'));
    }));
    // The facade's cache, the selected transport and the failure flags are module
    // state, and every test starts by clearing all three.
    facadeDisconnect();
    updateSettings({ protocol: 'auto', autoconnect: false, useTotp: false, savepassword: false });
});

afterEach(() => {
    // Both adapters, unconditionally. An armed retry or an in-flight attempt that
    // outlives its test opens a socket on the next test's clock and runs
    // `clearErrors()` on the flags that test is reading — which is how one test's
    // retry loop made three later tests look wrong.
    api.transportAdapter.quiesce();
    legacy.transportAdapter.quiesce();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('a failed attempt does not decide what this address speaks', () => {
    it('lets Auto probe again after a pinned API attempt never connected', async () => {
        updateSettings({ protocol: 'api' });
        await runFailingAttempt();

        expect(get(activeTransport)).toBe('api');
        expect(get(connectionState).errors.protocolUnansweredError).toBe(true);

        // The recovery the reporter could not reach: put the setting back on Auto.
        updateSettings({ protocol: 'auto' });
        const callsBefore = networkCalls.length;
        const attempt = settle(facadeConnect(PROFILE));
        await vi.advanceTimersByTimeAsync(0);

        expect(networkCalls.length, 'Auto had no proof to reuse, so it asked the relay again').toBeGreaterThan(callsBefore);
        expect(get(activeTransport), 'the probe got no HTTP answer, so this attempt runs on legacy').toBe('legacy');
        expect(FakeSocket.instances.length, 'and it really opened the legacy socket').toBeGreaterThan(0);
        expect(get(connectionState).errors.protocolUnansweredError, 'the claim belongs to one attempt, not to the address').toBe(false);

        legacy.transportAdapter.quiesce();
        await attempt;
    });

    it('clears a stale entry a successful earlier attempt left behind', async () => {
        // First: a legacy session that connected, so the address has a proven
        // transport cached.
        updateSettings({ protocol: 'legacy', autoconnect: true });
        const session = settle(facadeConnect(PROFILE));
        const socket = lastSocket();
        connectionState.update((current) => ({ ...current, status: 'connected', wasEverConnected: true }));
        socket.endWith(1006);
        expect(await session, 'the dropped session must settle as a failure').toBeInstanceOf(Error);

        expect(networkCalls.length, 'a proven transport is reused, not re-probed').toBe(0);
        expect(get(activeTransport)).toBe('legacy');

        // Then: the relay is not what it was, and the user pins API against it.
        // The attempt fails without ever reaching a session. Autoconnect is off for
        // this phase so its failure does not arm a retry that outlives the test.
        updateSettings({ protocol: 'api', autoconnect: false });
        await runFailingAttempt();

        // Auto is no longer inheriting the old proof: the failed attempt cleared
        // it, so this address is classified from scratch.
        updateSettings({ protocol: 'auto' });
        const callsBefore = networkCalls.length;
        const probe = settle(facadeConnect(PROFILE));
        await vi.advanceTimersByTimeAsync(0);

        expect(networkCalls.length, 'the stale entry was cleared, so Auto had to probe again').toBeGreaterThan(callsBefore);
        expect(get(activeTransport)).toBe('legacy');

        legacy.transportAdapter.quiesce();
        await probe;
    });

    it('keeps the proof of an attempt that did reach a session', async () => {
        updateSettings({ protocol: 'legacy', autoconnect: true });
        const attempt = settle(facadeConnect(PROFILE));
        const socket = lastSocket();
        // A session, as the status store reports it — the facade's only evidence,
        // and the reason a dropped session must not read as a wrong protocol.
        connectionState.update((current) => ({ ...current, status: 'connected', wasEverConnected: true }));
        socket.endWith(1006);
        expect(await attempt, 'the dropped session must settle as a failure').toBeInstanceOf(Error);

        expect(get(connectionState).errors.protocolUnansweredError, 'the session already proved this transport').toBe(false);

        updateSettings({ protocol: 'auto' });
        const second = settle(facadeConnect(PROFILE));
        await vi.advanceTimersByTimeAsync(0);

        expect(networkCalls.length, 'a proven transport is reused without a probe').toBe(0);
        expect(get(activeTransport)).toBe('legacy');

        legacy.transportAdapter.quiesce();
        await second;
    });

    it('stops a superseded attempt describing the address it was replaced on', async () => {
        // A pinned API attempt still in flight when the user starts another one.
        // The old attempt does settle — aborted by the connect that replaced it —
        // and on its own it would have named a protocol problem. It may not say
        // that about an address a newer attempt already owns.
        hangFetch = true;
        updateSettings({ protocol: 'api' });
        const stale = settle(facadeConnect(PROFILE));
        await vi.advanceTimersByTimeAsync(0);

        hangFetch = false;
        updateSettings({ protocol: 'legacy' });
        const live = settle(facadeConnect(PROFILE));
        await vi.advanceTimersByTimeAsync(0);
        // A superseded attempt settles without error on purpose: the app has
        // already moved on, and the caller that started it is not the one that
        // should report a failure. What must not happen is what comes next.
        await stale;

        expect(
            get(connectionState).errors.protocolUnansweredError,
            'a discarded attempt must not complain about an address a newer attempt is connecting to',
        ).toBe(false);

        const socket = lastSocket();
        connectionState.update((current) => ({ ...current, status: 'connected', wasEverConnected: true }));
        socket.endWith(1006);
        expect(await live, 'the newer attempt must settle as a failure').toBeInstanceOf(Error);

        expect(get(activeTransport), 'the newer attempt still owns the address').toBe('legacy');

        // And the proof the newer attempt earned survives the discarded one: an Auto
        // attempt on this address reuses it instead of probing again.
        updateSettings({ protocol: 'auto' });
        const callsBefore = networkCalls.length;
        const probe = settle(facadeConnect(PROFILE));
        await vi.advanceTimersByTimeAsync(0);
        expect(networkCalls.length, 'a superseded attempt may not erase what the newer one proved').toBe(callsBefore);
        legacy.transportAdapter.quiesce();
        await probe;
    });
});

describe('what a pinned failure is allowed to blame', () => {
    it('names the pin when nothing on the port answered as the pinned protocol', async () => {
        updateSettings({ protocol: 'legacy' });
        await runFailingAttempt(1006);

        expect(get(connectionState).errors.serverUnreachable).toBe(true);
        expect(get(connectionState).errors.protocolUnansweredError, 'the pin is the one variable the user can change').toBe(true);
    });

    it('names the credential, not the pin, when the relay answered in that protocol', async () => {
        updateSettings({ protocol: 'legacy' });
        await runFailingAttempt(401);

        expect(get(connectionState).errors.passwordError).toBe(true);
        expect(get(connectionState).errors.protocolUnansweredError, 'only a relay speaking this protocol can refuse a password').toBe(false);
    });

    it('says nothing about the protocol when the user did not pin one', async () => {
        updateSettings({ protocol: 'auto' });
        await runFailingAttempt(1006);

        expect(get(connectionState).errors.serverUnreachable).toBe(true);
        expect(get(connectionState).errors.protocolUnansweredError, 'auto chose; blaming it would be blaming the probe').toBe(false);
    });

    it('still names the credential when the attempt follows an explicit Leave', async () => {
        // The user left, edited the password, and connected again. `userDisconnect`
        // is what a Leave records, and only reaching a session clears it. If it
        // survives into the next attempt, the classifier reads that attempt's
        // failure as the user having left — and the form is left with nothing to
        // say about a relay that refused the password in front of it.
        facadeDisconnect();
        updateSettings({ protocol: 'legacy' });
        await runFailingAttempt(401);

        expect(get(connectionState).errors.passwordError, 'a refused credential is a fact even after a Leave').toBe(true);
        expect(get(connectionState).errors.protocolUnansweredError, 'the relay answered in the pinned protocol').toBe(false);
    });
});

describe('a replaced transport cannot act any more', () => {
    it('does not let the API transport fire the ladder it armed before being replaced', async () => {
        // The API attempt fails and the ladder is armed. The user then puts the
        // protocol on legacy and connects again, which quiesces the API transport.
        // The ladder's timer is the shared one in `connectionLifecycle`, not a
        // handle the orchestrator owns, so quiescing without cancelling it leaves a
        // reconnect that fires on the new transport's clock — for a relay the user
        // has already moved on from.
        updateSettings({ protocol: 'api', autoconnect: true });
        const replaced = settle(facadeConnect(PROFILE));
        await vi.advanceTimersByTimeAsync(0);
        expect(pendingRetryState().active, 'the failed API attempt armed its ladder').toBe(true);

        updateSettings({ protocol: 'legacy' });
        const replacement = settle(facadeConnect(PROFILE));
        expect(pendingRetryState().active, 'quiescing the replaced transport cancelled its ladder').toBe(false);

        // The replacement's own socket is out of the way, so anything that fires
        // below can only have come from the ladder.
        legacy.transportAdapter.quiesce();
        const calls = networkCalls.length;
        await vi.advanceTimersByTimeAsync(120_000);

        expect(networkCalls.length, 'no reconnect from the transport the user replaced').toBe(calls);

        api.transportAdapter.quiesce();
        await replaced;
        await replacement;
    });

    it('does not let the legacy transport fire the ladder it armed before being replaced', async () => {
        // The mirror of the API case, because the two transports arm their ladder
        // differently: legacy arms one when a session it held drops.
        updateSettings({ protocol: 'legacy', autoconnect: true });
        const replaced = settle(facadeConnect(PROFILE));
        const socket = lastSocket();
        connectionState.update((current) => ({ ...current, status: 'connected', wasEverConnected: true }));
        socket.endWith(1006);
        await vi.advanceTimersByTimeAsync(0);
        expect(pendingRetryState().active, 'the dropped session armed its ladder').toBe(true);

        updateSettings({ protocol: 'api' });
        const replacement = settle(facadeConnect(PROFILE));
        expect(pendingRetryState().active, 'quiescing the legacy transport cancelled its ladder').toBe(false);

        // A legacy reconnect opens a socket; the replacement's own API failure does
        // not, so anything new on the socket list came from the old ladder.
        const sockets = FakeSocket.instances.length;
        await vi.advanceTimersByTimeAsync(120_000);
        expect(FakeSocket.instances.length, 'no reconnect from the transport the user replaced').toBe(sockets);

        api.transportAdapter.quiesce();
        await replaced;
        await replacement;
    });
});
