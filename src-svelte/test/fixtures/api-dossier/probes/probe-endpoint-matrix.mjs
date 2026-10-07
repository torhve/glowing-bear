#!/usr/bin/env node
/**
 * Endpoint matrix probe: hit every endpoint the app's API transport uses and
 * print the response shape, so relay-version drift is found by measurement.
 *
 * Run it against two relays and diff the output. Recorded results (2026-10-07):
 *
 *   WeeChat 4.10.1 / API 0.6.0   vs   WeeChat 5.0.0-dev / API 0.7.0
 *   version   200  same keys            version   200  same keys
 *   hotlist   200  same keys            hotlist   200  same keys
 *   scripts   200  same keys            scripts   200  same keys
 *   nicks     200  same keys            nicks     200  same keys
 *   ping      204                        ping      204
 *   completion 400 GET / 400 POST (bad body, identical on both)
 *   lines     200  keys include date_printed
 *                                   lines     200  date_printed ABSENT  <-- the drift
 *
 * Usage: node probe-endpoint-matrix.mjs [port]
 * Auth mirrors the gbtest fixture: relay.network.password testpassword123 with
 * password_hash_algo pbkdf2+sha256, so the WS credential must be the PBKDF2
 * hash — a `plain:` credential closes the socket (1006) when the algo is pinned.
 */
import crypto from 'node:crypto';

const PORT = Number(process.argv[2] ?? 9010);
const PASSWORD = 'testpassword123';
const b64 = (s) => Buffer.from(s).toString('base64url');
const ts = Math.floor(Date.now() / 1000);
const iters = 100000;
const hash = crypto.pbkdf2Sync(PASSWORD, String(ts), iters, 32, 'sha256').toString('hex');

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api`, [
    'api.weechat',
    'base64url.bearer.authorization.weechat.' + b64(`hash:pbkdf2+sha256:${ts}:${iters}:${hash}`),
]);
const pend = new Map();
let n = 0;
const send = (request, body) => new Promise((res) => {
    const id = 'q' + (++n);
    pend.set(id, res);
    ws.send(JSON.stringify({ request, request_id: id, ...(body !== undefined ? { body } : {}) }));
    setTimeout(() => { if (pend.has(id)) { pend.delete(id); res({ request, timedOut: true }); } }, 6000);
});
ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    const p = pend.get(m.request_id);
    if (p) { pend.delete(m.request_id); p(m); }
};
ws.onopen = async () => {
    const buffers = await send('GET /api/buffers?lines=0');
    const list = buffers.body ?? [];
    const nicked = list.find((b) => b.nicklist) ?? list[0];
    const core = list.find((b) => b.name === 'core.weechat');
    await send('POST /api/sync', { sync: true, nicks: true, input: true, colors: 'weechat' });

    const probes = [
        ['GET /api/version', undefined],
        ['GET /api/hotlist', undefined],
        ['GET /api/scripts', undefined],
        ['POST /api/completion', { buffer_id: core?.id, words: 10 }],
        [`GET /api/buffers/${core?.id}/lines?lines=-3&colors=weechat`, undefined],
        [`GET /api/buffers/${nicked?.id}/nicks?colors=weechat`, undefined],
        ['POST /api/ping', {}],
    ];
    for (const [request, body] of probes) {
        const r = await send(request, body);
        const shape = Array.isArray(r.body)
            ? `array(${r.body.length}) keys=[${Object.keys(r.body[0] ?? {}).sort().join(',')}]`
            : r.body && typeof r.body === 'object'
                ? `object keys=[${Object.keys(r.body).sort().join(',')}]`
                : JSON.stringify(r.body ?? null)?.slice(0, 60);
        console.log(`${String(r.code ?? 'TIMEOUT').padEnd(8)} ${request.padEnd(52)} ${shape}`);
    }
    process.exit(0);
};
ws.onerror = () => {};
ws.onclose = (e) => { console.log('CLOSE', e.code); process.exit(1); };
