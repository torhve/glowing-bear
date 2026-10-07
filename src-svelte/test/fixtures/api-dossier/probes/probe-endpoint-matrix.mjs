#!/usr/bin/env node
/**
 * Endpoint matrix probe: hit every endpoint the app's API transport uses and
 * print each sampled response's key set, so relay-version drift is found by
 * measurement instead of by a user hitting it first.
 *
 * Run it against two relays and diff the output. Sampled 2026-10-07 against
 * WeeChat 4.10.1 / API 0.6.0 (gbtest) and WeeChat 5.0.0-dev / API 0.7.0
 * (built from upstream main): version, hotlist, scripts, completion, nicks and
 * ping answered with the same status and the same top-level keys on both; the
 * one divergence in the sampled responses was the line object — 4.10.1 included
 * `date_printed`, 5.0.0-dev omitted it.
 *
 * This compares top-level key sets of sampled payloads. It does NOT verify
 * field types, nested structures, or behaviour on empty/edge data, and a 5.0.0-dev
 * build with the script plugin disabled returns an empty scripts array, which
 * proves nothing about script item shape. Treat a matching line here as "worth a
 * closer look if something breaks", not as proof of compatibility.
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

const hardFail = (why) => {
    console.error(`PROBE FAILED: ${why}`);
    process.exit(1);
};
const overall = setTimeout(() => hardFail(`no result within 30s (port ${PORT})`), 30000);

ws.onopen = async () => {
    const buffers = await send('GET /api/buffers?lines=0');
    if (buffers.timedOut || buffers.code !== 200) {
        hardFail(`GET /api/buffers failed (code ${buffers.code ?? 'timeout'}) — is the relay up and the password right?`);
    }
    const list = buffers.body ?? [];
    const nicked = list.find((b) => b.nicklist) ?? list[0];
    const core = list.find((b) => b.name === 'core.weechat');
    await send('POST /api/sync', { sync: true, nicks: true, input: true, colors: 'weechat' });

    // A real completion request, same shape the app sends: a partial command
    // plus a cursor offset. A bad body answers 400 on BOTH versions, which
    // only proves both reject it — so the probe asks a valid one.
    const command = '/set relay.network.pass';
    const probes = [
        ['GET /api/version', undefined, 200],
        ['GET /api/hotlist', undefined, 200],
        ['GET /api/scripts', undefined, 200],
        ['POST /api/completion', { command, position: command.length, buffer_id: core?.id }, 200],
        [`GET /api/buffers/${core?.id}/lines?lines=-3&colors=weechat`, undefined, 200],
        [`GET /api/buffers/${nicked?.id}/nicks?colors=weechat`, undefined, 200],
        ['POST /api/ping', {}, 204],
    ];
    let failures = 0;
    for (const [request, body, expected] of probes) {
        const r = await send(request, body);
        const code = r.timedOut ? 'TIMEOUT' : r.code;
        const shape = Array.isArray(r.body)
            ? `array(${r.body.length}) keys=[${Object.keys(r.body[0] ?? {}).sort().join(',')}]`
            : r.body && typeof r.body === 'object'
                ? `object keys=[${Object.keys(r.body).sort().join(',')}]`
                : JSON.stringify(r.body ?? null)?.slice(0, 80);
        const ok = code === expected;
        if (!ok) failures++;
        console.log(`${ok ? 'ok  ' : 'FAIL'} ${String(code).padEnd(8)} ${request.padEnd(52)} ${shape}`);
    }
    clearTimeout(overall);
    if (failures > 0) hardFail(`${failures} endpoint(s) did not answer as expected`);
    process.exit(0);
};
ws.onerror = () => {};
ws.onclose = (e) => hardFail(`socket closed code=${e.code} before the matrix completed`);
