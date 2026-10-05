import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { ApiOrchestrator, type SyncPhaseTokens } from '#lib/api/api-orchestrator.ts';
import { resolveApiEndpoint } from '#lib/api/api-endpoint.ts';
import type { ApiReducers } from '#lib/api/api-contracts.ts';

const endpoint = resolveApiEndpoint({ host: 'localhost', port: 9010, tls: false });

// ---- fake WebSocket ----
class FakeSocket {
    static instances: FakeSocket[] = [];
    readyState = 0;
    sent: string[] = [];
    onopen: (() => void) | null = null;
    onclose: ((ev: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onerror: (() => void) | null = null;

    constructor(public url: string, public protocols: string[]) { FakeSocket.instances.push(this); }
    emitOpen(): void { this.readyState = 1; this.onopen?.(); }
    emitMessage(obj: unknown): void { this.onmessage?.({ data: typeof obj === 'string' ? obj : JSON.stringify(obj) }); }
    emitClose(code = 1006): void { this.readyState = 3; this.onclose?.({ code, reason: '', wasClean: false }); }
    send(data: string): void { if (this.readyState !== 1) throw new Error('not open'); this.sent.push(data); }
    close(): void { this.readyState = 3; }
    frames(): unknown[] { return this.sent.map((s) => JSON.parse(s)); }
}

async function waitForSocket(): Promise<FakeSocket> {
    for (let i = 0; i < 1000 && FakeSocket.instances.length === 0; i++) await Promise.resolve();
    return FakeSocket.instances[FakeSocket.instances.length - 1]!;
}

async function waitForBatch(sock: FakeSocket): Promise<Array<{ request_id: string; request: string }>> {
    for (let i = 0; i < 1000; i++) {
        const f = sock.frames().find((x) => Array.isArray(x));
        if (f) return f as Array<{ request_id: string; request: string }>;
        await Promise.resolve();
    }
    throw new Error('orchestrator never sent the bootstrap batch');
}

// ---- recording reducers / sync phase ----
function testReducers() {
    return {
        buffers: vi.fn(), bufferOpened: vi.fn(), bufferClosing: vi.fn(), bufferClosed: vi.fn(),
        bufferUpdated: vi.fn(), bufferNotifyChanged: vi.fn(), bufferInputChanged: vi.fn(), lineAdded: vi.fn(),
        lineDataChanged: vi.fn(), bufferCleared: vi.fn(), nickGroupChanged: vi.fn(),
        nickGroupRemoved: vi.fn(), nickChanged: vi.fn(), nickRemoved: vi.fn(),
        hotlist: vi.fn(), completion: vi.fn(), inputRejected: vi.fn(), relayLifecycle: vi.fn(), unhandled: vi.fn(),
    } satisfies ApiReducers;
}

function testSync() {
    const begins: number[] = [];
    const ends: (number | undefined)[] = [];
    let token = 0;
    const sync: SyncPhaseTokens = {
        begin: () => { token += 1; begins.push(token); return token; },
        end: (t) => { ends.push(t); },
    };
    return { sync, begins, ends };
}

// ---- fake fetch ----
const VALID_BUFFER = {
    id: 1759000000000001, name: 'irc.server.gbtest', short_name: 'gbtest', number: 1,
    type: 'formatted', hidden: false, title: '', modes: '', input_prompt: '',
    input: '', input_position: 0, input_multiline: false, nicklist: false,
    nicklist_case_sensitive: false, nicklist_display_groups: false,
    time_displayed: true, local_variables: { type: 'server' }, keys: [], last_read_line_id: -1,
};
const VALID_HOTLIST = [{ priority: 2, date: '2026-10-04T12:00:00Z', buffer_id: 1759000000000001, count: [0, 1, 0, 0] }];

function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function stubFetch(handshakeDelay = false) {
    const calls: string[] = [];
    let handshakeDeferred: { resolve: (r: Response) => void } | null = null;
    let handshakeCount = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        const path = new URL(url).pathname;
        calls.push(path);
        if (path === '/api/handshake') {
            handshakeCount += 1;
            const body = { password_hash_algo: 'pbkdf2+sha256', password_hash_iterations: 100000, totp: false };
            if (handshakeDelay && handshakeCount === 1) {
                return await new Promise<Response>((resolve) => { handshakeDeferred = { resolve }; });
            }
            return jsonResponse(body);
        }
        if (path === '/api/version') {
            return jsonResponse({
                weechat_version: '4.10.1', weechat_version_git: '', weechat_version_number: 67764480,
                relay_api_version: '0.6.0', relay_api_version_number: 1536,
            });
        }
        return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
    }));
    return {
        calls,
        releaseHandshake: () => handshakeDeferred?.resolve(jsonResponse({
            password_hash_algo: 'pbkdf2+sha256', password_hash_iterations: 100000, totp: false,
        })),
    };
}

/** Completes the bootstrap batch for the newest socket. */
async function completeBootstrap(sock: FakeSocket): Promise<Record<string, string>> {
    const batch = await waitForBatch(sock);
    const ids: Record<string, string> = {};
    for (const frame of batch) {
        const kind = frame.request.includes('/api/buffers') ? 'buffers'
            : frame.request.includes('/api/sync') ? 'sync' : 'hotlist';
        ids[kind] = frame.request_id;
        const body = kind === 'buffers' ? [VALID_BUFFER]
            : kind === 'hotlist' ? VALID_HOTLIST : null;
        const code = kind === 'sync' ? 204 : 200;
        sock.emitMessage({ code, request: frame.request, request_id: frame.request_id, body_type: kind === 'sync' ? null : 'array', body });
    }
    return ids;
}

beforeEach(() => { FakeSocket.instances = []; });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

function makeOrchestrator(overrides: Partial<ConstructorParameters<typeof ApiOrchestrator>[0]> = {}) {
    const reducers = testReducers();
    const { sync, begins, ends } = testSync();
    const statuses: Array<{ state: string; error?: string }> = [];
    const orch = new ApiOrchestrator({
        endpoint,
        getPassword: () => 'pw',
        reducers,
        sync,
        webSocketFactory: (u, p) => new FakeSocket(u, p) as unknown as WebSocket,
        onStatus: (s) => statuses.push({ state: s.state, error: s.error }),
        ...overrides,
    });
    return { orch, reducers, begins, ends, statuses };
}

describe('ApiOrchestrator bootstrap', () => {
    it('runs handshake → version → session → buffers/sync/hotlist in order and ends the sync phase on baseline', async () => {
        stubFetch();
        const { orch, reducers, begins, ends, statuses } = makeOrchestrator();
        orch.start();
        const sock = await waitForSocket();
        sock.emitOpen();
        await completeBootstrap(sock);

        expect(begins).toEqual([1]);
        // Batch order is buffers → sync → hotlist.
        const batch = await waitForBatch(sock) as Array<{ request: string }>;
        expect(batch.map((f) => f.request)).toEqual([
            'GET /api/buffers?lines=0',
            'POST /api/sync',
            'GET /api/hotlist',
        ]);
        expect(reducers.buffers).toHaveBeenCalledTimes(1);
        expect(reducers.buffers.mock.calls[0]![0]).toHaveLength(1);
        expect(reducers.hotlist).toHaveBeenCalledTimes(1);
        const hotlistMap = reducers.hotlist.mock.calls[0]![0] as Map<number, unknown>;
        expect(hotlistMap.get(1759000000000001)).toMatchObject({ priority: 2, counts: { message: 1 } });
        // Sync phase closed exactly once, with this attempt's token.
        expect(ends).toEqual([1]);
        expect(statuses[statuses.length - 1]!.state).toBe('connected');
        orch.dispose();
    });

    it('dispatches live events that arrive mid-bootstrap without reordering', async () => {
        stubFetch();
        const { orch, reducers } = makeOrchestrator();
        orch.start();
        const sock = await waitForSocket();
        sock.emitOpen();
        const batch = await waitForBatch(sock);
        const [buffersFrame, syncFrame, hotlistFrame] = batch;
        sock.emitMessage({ code: 200, request: buffersFrame!.request, request_id: buffersFrame!.request_id, body_type: 'array', body: [VALID_BUFFER] });
        sock.emitMessage({ code: 204, request: syncFrame!.request, request_id: syncFrame!.request_id, body_type: null, body: null });
        // A live line arrives between the sync ack and the hotlist baseline.
        sock.emitMessage({
            code: 0, message: 'Event', event_name: 'buffer_line_added', buffer_id: 1759000000000001,
            body_type: 'line', body: {
                id: 7, y: 3, date: '2026-10-04T12:00:01Z', date_printed: '2026-10-04T12:00:01Z',
                displayed: true, highlight: false, notify_level: 2, prefix: '', message: 'hi', tags: [],
            },
        });
        sock.emitMessage({ code: 200, request: hotlistFrame!.request, request_id: hotlistFrame!.request_id, body_type: 'array', body: VALID_HOTLIST });
        // Events dispatch synchronously; the batch continuation lands after a
        // microtask — wait for it explicitly.
        expect(reducers.lineAdded).toHaveBeenCalledTimes(1);
        await vi.waitFor(() => expect(reducers.buffers).toHaveBeenCalledTimes(1));
        orch.dispose();
    });

    it('rejects servers with an older Relay API and does not retry', async () => {
        vi.stubGlobal('fetch', vi.fn(async (url: string) => {
            const path = new URL(url).pathname;
            if (path === '/api/handshake') {
                return jsonResponse({ password_hash_algo: 'pbkdf2+sha256', password_hash_iterations: 100000, totp: false });
            }
            return jsonResponse({
                weechat_version: '4.5.0', weechat_version_git: '', weechat_version_number: 42598400,
                relay_api_version: '0.2.0', relay_api_version_number: 512,
            });
        }));
        const { orch, statuses, ends } = makeOrchestrator();
        orch.start();
        await vi.waitFor(() => expect(statuses.some((s) => s.state === 'failed')).toBe(true));
        expect(statuses[statuses.length - 1]!.error).toContain('too old');
        expect(ends).toEqual([1]); // failure exit closed the phase
        expect(FakeSocket.instances).toHaveLength(0); // never opened a session
        orch.dispose();
    });

    it('detects TOTP-required relays and fails with an explicit message', async () => {
        vi.stubGlobal('fetch', vi.fn(async (url: string) => {
            const path = new URL(url).pathname;
            if (path === '/api/handshake') {
                return jsonResponse({ password_hash_algo: 'pbkdf2+sha256', password_hash_iterations: 100000, totp: true });
            }
            return new Response(JSON.stringify({ error: 'nope' }), { status: 404 });
        }));
        const { orch, statuses, ends } = makeOrchestrator({ autoReconnect: false });
        orch.start();
        await vi.waitFor(() => expect(statuses.some((s) => s.state === 'failed')).toBe(true));
        expect(statuses[statuses.length - 1]!.error).toContain('TOTP');
        expect(ends).toEqual([1]);
    });
});

describe('ApiOrchestrator reconnect lifecycle', () => {
    it('retries with backoff after a failed attempt and succeeds on the second try', async () => {
        vi.useFakeTimers();
        let handshakeFails = 1;
        vi.stubGlobal('fetch', vi.fn(async (url: string) => {
            const path = new URL(url).pathname;
            if (path === '/api/handshake') {
                if (handshakeFails-- > 0) return new Response(JSON.stringify({ error: 'boom' }), { status: 500 });
                return jsonResponse({ password_hash_algo: 'pbkdf2+sha256', password_hash_iterations: 100000, totp: false });
            }
            return jsonResponse({
                weechat_version: '4.10.1', weechat_version_git: '', weechat_version_number: 67764480,
                relay_api_version: '0.6.0', relay_api_version_number: 1536,
            });
        }));
        const { orch, reducers, begins, ends, statuses } = makeOrchestrator({ backoff: { baseMs: 1000, maxMs: 5000, factor: 2 } });
        orch.start();
        await vi.advanceTimersByTimeAsync(10);
        expect(statuses.some((s) => s.state === 'reconnecting')).toBe(true);
        await vi.advanceTimersByTimeAsync(1000); // first backoff step
        const sock = await waitForSocket();
        sock.emitOpen();
        await completeBootstrap(sock);
        await vi.waitFor(() => expect(reducers.buffers).toHaveBeenCalledTimes(1));
        expect(begins.length).toBe(2);   // one sync phase per attempt
        expect(ends.length).toBe(2);     // each closed by failure exit or baseline
        expect(statuses[statuses.length - 1]!.state).toBe('connected');
        orch.dispose();
        vi.useRealTimers();
    });

    it('schedules a reconnect when a connected session drops', async () => {
        stubFetch();
        const { orch, statuses } = makeOrchestrator();
        orch.start();
        const sock = await waitForSocket();
        sock.emitOpen();
        await completeBootstrap(sock);
        sock.emitClose(1006);
        expect(statuses[statuses.length - 1]!.state).toBe('reconnecting');
        orch.dispose();
    });

    // Manual event table: upgrade/upgrade_ended kill the session; legacy
    // parity reconnects ~2 s later instead of climbing the backoff ladder.
    it('upgrade event reconnects in ~2 s, not via the slow backoff', async () => {
        vi.useFakeTimers();
        stubFetch();
        const { orch, reducers } = makeOrchestrator({ backoff: { baseMs: 30_000, maxMs: 300_000, factor: 1.5 } });
        orch.start();
        await vi.advanceTimersByTimeAsync(10);
        const sock = await waitForSocket();
        sock.emitOpen();
        await completeBootstrap(sock);
        await vi.waitFor(() => expect(reducers.buffers).toHaveBeenCalledTimes(1));

        sock.emitMessage({ code: 0, message: 'Event', event_name: 'upgrade', buffer_id: -1, body_type: null, body: null });
        expect(reducers.relayLifecycle).toHaveBeenCalledWith('upgrade');
        sock.emitClose(1006); // WeeChat kills the socket as it re-execs

        FakeSocket.instances = [];
        await vi.advanceTimersByTimeAsync(1999);
        expect(FakeSocket.instances).toHaveLength(0); // 30 s backoff has NOT fired
        await vi.advanceTimersByTimeAsync(2);
        expect(FakeSocket.instances).toHaveLength(1); // upgrade timer won
        orch.dispose();
        vi.useRealTimers();
    });

    it('quit event logs via relayLifecycle and leaves reconnect to the close path', async () => {
        vi.useFakeTimers();
        stubFetch();
        const { orch, reducers } = makeOrchestrator({ backoff: { baseMs: 5000, maxMs: 5000, factor: 2 } });
        orch.start();
        await vi.advanceTimersByTimeAsync(10);
        const sock = await waitForSocket();
        sock.emitOpen();
        await completeBootstrap(sock);
        sock.emitMessage({ code: 0, message: 'Event', event_name: 'quit', buffer_id: -1, body_type: null, body: null });
        expect(reducers.relayLifecycle).toHaveBeenCalledWith('quit');
        sock.emitClose(1006);
        FakeSocket.instances = [];
        await vi.advanceTimersByTimeAsync(2500);
        expect(FakeSocket.instances).toHaveLength(0); // no fast upgrade reconnect
        await vi.advanceTimersByTimeAsync(2600);
        expect(FakeSocket.instances).toHaveLength(1); // normal 5 s backoff
        orch.dispose();
        vi.useRealTimers();
    });

    it('stop() disconnects without reconnecting and never sends /quit', async () => {
        stubFetch();
        const { orch, statuses } = makeOrchestrator();
        orch.start();
        const sock = await waitForSocket();
        sock.emitOpen();
        await completeBootstrap(sock);
        orch.stop();
        expect(statuses[statuses.length - 1]!.state).toBe('disconnected');
        const allSends = sock.sent.join('');
        expect(allSends).not.toContain('quit');
        // No further sockets after stop.
        FakeSocket.instances = [];
        await new Promise((r) => setTimeout(r, 50));
        expect(FakeSocket.instances).toHaveLength(0);
    });

    it('reconnectNow takes over and a superseded slow attempt cannot publish state', async () => {
        const fetchCtl = stubFetch(true); // first handshake hangs
        const { orch, reducers, begins, ends } = makeOrchestrator();
        orch.start(); // attempt 1: handshake pending
        await new Promise((r) => setTimeout(r, 10));
        orch.reconnectNow(); // attempt 2 takes over
        const sock2 = await waitForSocket();
        sock2.emitOpen();
        await completeBootstrap(sock2);
        await vi.waitFor(() => expect(reducers.buffers).toHaveBeenCalledTimes(1));

        // Attempt 1's handshake finally resolves; it must not open a session
        // or publish buffers into the newer generation.
        fetchCtl.releaseHandshake();
        await new Promise((r) => setTimeout(r, 30));
        expect(reducers.buffers).toHaveBeenCalledTimes(1);
        expect(begins.length).toBe(2);
        expect(ends.length).toBeGreaterThanOrEqual(2); // stale attempt closed its own token
        expect(orch.currentGeneration).toBe(2);
        orch.dispose();
    });
});
