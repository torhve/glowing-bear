import { describe, it, expect, vi, afterEach } from 'vitest';
import { ApiSession, ApiSessionError } from '#lib/api/api-session.ts';
import type { ApiEndpoint } from '#lib/api/api-endpoint.ts';
import { resolveApiEndpoint } from '#lib/api/api-endpoint.ts';

const endpoint: ApiEndpoint = resolveApiEndpoint({ host: 'localhost', port: 9010, tls: false });

class FakeSocket {
    static instances: FakeSocket[] = [];
    readyState = 0; // CONNECTING
    sent: string[] = [];
    onopen: (() => void) | null = null;
    onclose: ((ev: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onerror: (() => void) | null = null;
    closeCode: number | null = null;

    constructor(public url: string, public protocols: string[]) {
        FakeSocket.instances.push(this);
    }

    emitOpen(): void {
        this.readyState = 1;
        this.onopen?.();
    }

    emitMessage(obj: unknown): void {
        this.onmessage?.({ data: typeof obj === 'string' ? obj : JSON.stringify(obj) });
    }

    emitClose(code = 1006, reason = '', wasClean = false): void {
        this.readyState = 3;
        this.onclose?.({ code, reason, wasClean });
    }

    send(data: string): void {
        if (this.readyState !== 1) throw new Error('not open');
        this.sent.push(data);
    }

    close(code = 1000): void {
        this.closeCode = code;
        this.readyState = 3;
    }

    lastFrame(): unknown {
        return JSON.parse(this.sent[this.sent.length - 1]!);
    }
}

function makeSession(opts: Partial<ConstructorParameters<typeof ApiSession>[0]> = {}) {
    FakeSocket.instances = [];
    const events: unknown[] = [];
    const diagnostics: unknown[] = [];
    const closes: unknown[] = [];
    const session = new ApiSession({
        endpoint,
        auth: { algo: 'plain', iterations: 100000, totp: false },
        password: 'pw',
        generation: 7,
        webSocketFactory: ((u, p) => new FakeSocket(u, p) as unknown as WebSocket),
        onEvent: (e) => events.push(e),
        onDiagnostic: (d) => diagnostics.push(d),
        onClose: (c) => closes.push(c),
        ...opts,
    });
    return { session, events, diagnostics, closes, socket: () => FakeSocket.instances[0]! };
}

async function waitForSocket(): Promise<FakeSocket> {
    for (let i = 0; i < 50 && FakeSocket.instances.length === 0; i++) {
        await Promise.resolve();
    }
    return FakeSocket.instances[0]!;
}

afterEach(() => { vi.useRealTimers(); });

describe('ApiSession connect', () => {
    it('opens with api.weechat + base64url auth subprotocols', async () => {
        const { session, socket } = makeSession();
        const p = session.connect();
        (await waitForSocket()).emitOpen();
        await expect(p).resolves.toBeUndefined();
        expect(socket().protocols[0]).toBe('api.weechat');
        expect(socket().protocols[1]).toMatch(/^base64url\.bearer\.authorization\.weechat\./);
        const cred = Buffer.from(socket().protocols[1]!.split('.').slice(4).join('.'), 'base64url').toString('utf8');
        expect(cred).toBe('plain:pw');
        expect(socket().url).toBe('ws://localhost:9010/api');
        session.destroy();
    });

    it('rejects connect on auth-rejected upgrade and reports unauthenticated close', async () => {
        const { session, closes, socket } = makeSession();
        const p = session.connect();
        (await waitForSocket()).emitClose(1006, '', false);
        await expect(p).rejects.toThrow(/close code 1006/);
        expect(closes[0]).toMatchObject({ code: 1006, authenticated: false });
    });

    it('marks the session authenticated once a valid frame arrives', async () => {
        const { session, socket, closes } = makeSession();
        const p = session.connect();
        (await waitForSocket()).emitOpen();
        await p;
        socket().emitMessage({ code: 200, request: 'x', request_id: 'nope', body_type: null, body: null });
        // A valid frame proves authentication; the following close reports it.
        socket().emitClose(1005, 'gone', true);
        expect(closes[0]).toMatchObject({ code: 1005, authenticated: true, wasClean: true });
    });
});

describe('ApiSession requests', () => {
    async function open() {
        const m = makeSession();
        const p = m.session.connect();
        (await waitForSocket()).emitOpen();
        await p;
        return m;
    }

    it('correlates responses by request_id, including out-of-order', async () => {
        const { session, socket } = await open();
        const a = session.request({ method: 'GET', path: '/api/buffers?lines=0' });
        const b = session.request({ method: 'GET', path: '/api/hotlist' });
        const fa = JSON.parse(socket().sent[0]!);
        const fb = JSON.parse(socket().sent[1]!);
        expect(fa.request).toBe('GET /api/buffers?lines=0');
        expect(fb.request).toBe('GET /api/hotlist');
        expect(fa.request_id).not.toBe(fb.request_id);
        // Respond out of order.
        socket().emitMessage({ code: 200, request: fb.request, request_id: fb.request_id, body_type: 'array', body: [1] });
        socket().emitMessage({ code: 200, request: fa.request, request_id: fa.request_id, body_type: 'array', body: [2] });
        expect((await a).body).toEqual([2]);
        expect((await b).body).toEqual([1]);
        session.destroy();
    });

    it('sends a batch as one array frame with all ids registered first', async () => {
        const { session, socket } = await open();
        const settledP = session.batch([
            { method: 'GET', path: '/api/buffers?lines=0' },
            { method: 'POST', path: '/api/sync', body: { sync: true } },
        ]);
        const frames = JSON.parse(socket().sent[0]!);
        expect(Array.isArray(frames)).toBe(true);
        expect(frames.length).toBe(2);
        expect(frames[1].request).toBe('POST /api/sync');
        expect(frames[1].body).toEqual({ sync: true });
        // Partial failure: one 204, one 404.
        socket().emitMessage({ code: 204, request: frames[0].request, request_id: frames[0].request_id, body_type: null, body: null });
        socket().emitMessage({ code: 404, request: frames[1].request, request_id: frames[1].request_id, body_type: 'string', body: 'Buffer not found' });
        const settled = await settledP;
        expect(settled[0]).toMatchObject({ status: 'fulfilled', value: { code: 204 } });
        expect(settled[1]).toMatchObject({ status: 'fulfilled', value: { code: 404, body: 'Buffer not found' } });
        session.destroy();
    });

    it('rejects requests with timeout and treats the late response as diagnostic', async () => {
        vi.useFakeTimers();
        const { session, socket, diagnostics } = await open();
        const p = session.request({ method: 'GET', path: '/api/buffers' }, 100);
        // Attach the rejection handler before the fake timer fires, otherwise
        // Node flags the rejection as unhandled during the timer tick.
        const assertion = expect(p).rejects.toMatchObject({ code: 'timeout' });
        await vi.advanceTimersByTimeAsync(150);
        await assertion;
        const frame = JSON.parse(socket().sent[0]!);
        socket().emitMessage({ code: 200, request: frame.request, request_id: frame.request_id, body_type: null, body: [] });
        expect(diagnostics).toContainEqual(expect.objectContaining({ kind: 'unmatched_response' }));
        session.destroy();
    });

    it('rejects pending requests when the socket drops', async () => {
        const { session, socket } = await open();
        const p = session.request({ method: 'GET', path: '/api/buffers' });
        socket().emitClose(1006);
        await expect(p).rejects.toMatchObject({ code: 'closed' });
    });

    it('reports send exceptions as send_failed with a diagnostic', async () => {
        const { session, socket, diagnostics } = await open();
        socket().send = () => { throw new Error('socket write error'); };
        const assertion = session.request({ method: 'POST', path: '/api/input', body: { command: '/say hi' } })
            .catch((e) => e);
        const err = await assertion;
        expect(err).toBeInstanceOf(ApiSessionError);
        expect((err as ApiSessionError).code).toBe('send_failed');
        expect(diagnostics).toContainEqual(expect.objectContaining({ kind: 'send_failed' }));
        // Batch send failure rejects exactly the batch's requests.
        socket().send = () => { throw new Error('socket write error'); };
        const settled = await session.batch([
            { method: 'GET', path: '/api/buffers' },
            { method: 'GET', path: '/api/hotlist' },
        ]);
        expect(settled.map((r) => r.status)).toEqual(['rejected', 'rejected']);
        session.destroy();
    });

    it('rejects requests made while not open', async () => {
        const { session } = makeSession();
        await expect(session.request({ method: 'GET', path: '/api/version' }))
            .rejects.toThrow(/not open/);
    });
});

describe('ApiSession events and framing', () => {
    async function open() {
        const m = makeSession();
        const p = m.session.connect();
        (await waitForSocket()).emitOpen();
        await p;
        return m;
    }

    it('routes flat code-0 event envelopes to onEvent in delivery order', async () => {
        const { session, socket, events } = await open();
        const reqP = session.request({ method: 'GET', path: '/api/buffers?lines=0' });
        socket().emitMessage({ code: 0, message: 'Event', event_name: 'buffer_opened', buffer_id: 42, body_type: 'buffer', body: { id: 42 } });
        const reqFrame = JSON.parse(socket().sent[0]!);
        socket().emitMessage({ code: 0, message: 'Event', event_name: 'buffer_line_added', buffer_id: 42, body_type: 'line', body: { id: 1 } });
        socket().emitMessage({ code: 200, request: reqFrame.request, request_id: reqFrame.request_id, body_type: 'array', body: [] });
        socket().emitMessage({ code: 0, message: 'Event', event_name: 'nicklist_nick_added', buffer_id: 42, body_type: 'nick', body: { nick: 'x' } });
        await reqP;
        expect(events.map((e) => (e as { event_name: string }).event_name)).toEqual([
            'buffer_opened', 'buffer_line_added', 'nicklist_nick_added',
        ]);
        session.destroy();
    });

    it('delivers responses and events through one synchronous ordered stream (onResponse)', async () => {
        const order: string[] = [];
        const m = makeSession({
            onEvent: (e) => order.push(`event:${e.event_name}`),
            onResponse: (r) => order.push(`resp:${r.request_id.slice(-1)}`),
        });
        const p = m.session.connect();
        (await waitForSocket()).emitOpen();
        await p;
        const r1 = m.session.request({ method: 'GET', path: '/api/buffers?lines=0' });
        const f1 = JSON.parse(m.socket().sent[0]!);
        // Response, then event, then a second response — dispatch order is
        // preserved for reducers because both hooks fire synchronously.
        m.socket().emitMessage({ code: 200, request: f1.request, request_id: f1.request_id, body_type: 'array', body: [] });
        m.socket().emitMessage({ code: 0, message: 'Event', event_name: 'buffer_line_added', buffer_id: 5, body_type: 'line', body: { id: 9 } });
        const r2 = m.session.request({ method: 'GET', path: '/api/hotlist' });
        const f2 = JSON.parse(m.socket().sent[1]!);
        m.socket().emitMessage({ code: 200, request: f2.request, request_id: f2.request_id, body_type: 'array', body: [] });
        await Promise.all([r1, r2]);
        expect(order).toEqual([
            `resp:${f1.request_id.slice(-1)}`,
            'event:buffer_line_added',
            `resp:${f2.request_id.slice(-1)}`,
        ]);
        m.session.destroy();
    });

    it('dispatches every sub-frame of an array frame in order', async () => {
        const { session, socket, events } = await open();
        const p = session.request({ method: 'GET', path: '/api/buffers?lines=0' });
        const f = JSON.parse(socket().sent[0]!);
        socket().emitMessage(JSON.stringify([
            { code: 0, message: 'Event', event_name: 'buffer_opened', buffer_id: 3, body_type: 'buffer', body: { id: 3 } },
            { code: 200, request: f.request, request_id: f.request_id, body_type: 'array', body: [] },
            { code: 0, message: 'Event', event_name: 'buffer_opened', buffer_id: 4, body_type: 'buffer', body: { id: 4 } },
        ]));
        await p;
        expect(events.map((e) => (e as { buffer_id: number }).buffer_id)).toEqual([3, 4]);
        session.destroy();
    });

    it('never treats an unmatched response as an event', async () => {
        const { session, socket, events, diagnostics } = await open();
        socket().emitMessage({ code: 200, request: 'GET /api/unknown', request_id: 'stranger', body_type: null, body: {} });
        expect(events).toHaveLength(0);
        expect(diagnostics).toHaveLength(1);
        session.destroy();
    });

    it('survives malformed frames with a diagnostic', async () => {
        const { session, socket, diagnostics } = await open();
        socket().emitMessage('{not json');
        socket().emitMessage(JSON.stringify('just a string'));
        expect(diagnostics).toHaveLength(2);
        expect(session.isOpen).toBe(true);
        session.destroy();
    });
});

describe('ApiSession generation hygiene', () => {
    it('destroy rejects pending, closes socket and silences late frames', async () => {
        const { session, socket, events, diagnostics } = makeSession();
        const cp = session.connect();
        (await waitForSocket()).emitOpen();
        await cp;
        const p = session.request({ method: 'GET', path: '/api/buffers' });
        const frame = JSON.parse(socket().sent[0]!);
        session.destroy();
        await expect(p).rejects.toMatchObject({ code: 'closed' });
        expect(socket().closeCode).toBe(1000);
        // Late frames on the destroyed socket must not reach callbacks.
        socket().emitMessage({ code: 0, message: 'Event', event_name: 'buffer_closed', buffer_id: 1, body_type: null, body: null });
        socket().emitMessage({ code: 200, request: frame.request, request_id: frame.request_id, body_type: null, body: [] });
        expect(events).toHaveLength(0);
        expect(diagnostics).toHaveLength(0);
    });

    it('a superseded session cannot resolve a request or emit events', async () => {
        FakeSocket.instances = [];
        const events: unknown[] = [];
        const old = new ApiSession({
            endpoint, auth: { algo: 'plain', iterations: 1, totp: false }, password: 'pw', generation: 1,
            webSocketFactory: ((u, p2) => new FakeSocket(u, p2) as unknown as WebSocket),
            onEvent: (e) => events.push(e), onClose: () => undefined,
        });
        const cp = old.connect();
        void waitForSocket().then((sock) => sock.emitOpen());
        await cp;
        const pending = old.request({ method: 'GET', path: '/api/buffers' });
        old.destroy();
        await expect(pending).rejects.toBeInstanceOf(ApiSessionError);
        await expect(old.request({ method: 'GET', path: '/api/version' })).rejects.toMatchObject({ code: 'superseded' });
        expect(events).toHaveLength(0);
    });

    it('keepalive pings stop after destroy', async () => {
        vi.useFakeTimers();
        const m = makeSession({ keepAliveMs: 1000 });
        const p = m.session.connect();
        (await waitForSocket()).emitOpen();
        await p;
        await vi.advanceTimersByTimeAsync(2500);
        const pings = m.socket().sent.filter((f) => (f as string).includes('/api/ping'));
        expect(pings.length).toBe(2);
        m.session.destroy();
        await vi.advanceTimersByTimeAsync(3000);
        expect(m.socket().sent.filter((f) => (f as string).includes('/api/ping')).length).toBe(2);
        vi.useRealTimers();
    });
});
