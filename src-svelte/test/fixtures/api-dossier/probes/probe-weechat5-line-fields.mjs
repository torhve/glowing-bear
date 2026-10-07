#!/usr/bin/env node
/**
 * Live probe against a WeeChat 5.0 relay API (0.7.0).
 *
 * Why this exists: every other probe in this dossier was captured against
 * WeeChat 4.10.1, and the app's line validator was written from that shape.
 * WeeChat 5.0 removed `date_printed` / `date_usec_printed` from the line
 * object the API relay serialises, and the validator treated the field as
 * required — which made it reject EVERY line a 5.0 relay sent, history and
 * live events alike.
 *
 * Start a 5.0 relay first (this probe does not start WeeChat itself):
 *
 *   weechat-headless -d /tmp/gb-wc5 --daemon \
 *     -r "/set relay.network.password_hash_algo pbkdf2+sha256" \
 *     -r "/set relay.network.password testpassword123" \
 *     -r "/relay add api 9011" \
 *     -r "/buffer add wc5probe" \
 *     -r "/print -buffer=wc5probe hello-from-weechat-5"
 *
 * Run: node probes/probe-weechat5-line-fields.mjs [port]
 */
import fs from 'node:fs';
import crypto from 'node:crypto';

const API_PORT = Number(process.argv[2] ?? 9011);
const PASSWORD = 'testpassword123';
const HOME = '/tmp/gb-wc5';
const OUT = '/tmp/gb-wc5-probe.jsonl';
const out = fs.createWriteStream(OUT);

const log = (step, data) => {
    out.write(JSON.stringify({ t: new Date().toISOString(), step, data }) + '\n');
    const s = typeof data === 'string' ? data : JSON.stringify(data ?? null);
    console.log(`[${step}]`, s.slice(0, 400));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64url = (s) => Buffer.from(s).toString('base64url');
// The fixture sets relay.network.password_hash_algo to pbkdf2+sha256, which
// makes `plain:` rejected outright (the socket closes 1006 with no message),
// so the WS credential must be the same PBKDF2 hash the REST probe uses.
const hashCredential = () => {
    const ts = Math.floor(Date.now() / 1000);
    const iterations = 100000;
    const hash = crypto.pbkdf2Sync(PASSWORD, String(ts), iterations, 32, 'sha256').toString('hex');
    return `hash:pbkdf2+sha256:${ts}:${iterations}:${hash}`;
};

const fifoPath = fs.readdirSync(HOME).find((f) => f.startsWith('weechat_fifo_'));
const fifo = (cmd) => fs.writeFileSync(`${HOME}/${fifoPath}`, `core.weechat */${cmd}\n`);

const ws = new WebSocket(`ws://127.0.0.1:${API_PORT}/api`, [
    'api.weechat',
    'base64url.bearer.authorization.weechat.' + b64url(hashCredential()),
]);

let reqId = 0;
const pending = new Map();
const events = [];
ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    out.write(JSON.stringify({ t: new Date().toISOString(), step: 'frame', data: msg }) + '\n');
    if (msg.message === 'Event') { events.push(msg); return; }
    const p = pending.get(msg.request_id);
    if (p) { pending.delete(msg.request_id); p.resolve(msg); }
};
ws.onerror = (e) => log('ws-error', String(e.message || e));
ws.onclose = (e) => log('close', `code=${e.code} reason=${e.reason}`);

const send = (request, body) => new Promise((resolve) => {
    const id = 'p' + (++reqId);
    pending.set(id, { resolve });
    const payload = { request, request_id: id };
    if (body !== undefined) payload.body = body;
    ws.send(JSON.stringify(payload));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ timeout: true, id }); } }, 8000);
});

await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
});

log('version', await send('GET /api/version'));
log('open', 'connected');

const buffers = await send('GET /api/buffers');
const probe = (buffers.body ?? []).find((b) => b.name.includes('wc5probe'));
if (!probe) { log('error', 'wc5probe buffer not found — start WeeChat with /buffer add wc5probe'); process.exit(1); }
log('buffer', probe);

// History shape.
const lines = await send(`GET /api/buffers/${probe.id}/lines`);
log('history', lines.body);

// Live event shape: subscribe first, then ask the relay itself to print a
// line — the FIFO is not needed and keeps the probe self-contained.
// The API relay pushes freshness events once the client opens a sync window —
// there is no `sub` request in this protocol version.
await send('POST /api/sync', { sync: true, nicks: true, input: true, colors: 'weechat' });
const core = (buffers.body ?? []).find((b) => b.name === 'core.weechat');
// 5.0's input endpoint is POST /api/input with a buffer_id — the per-buffer
// /api/buffers/<id>/input path answers 405, which is itself a contract change.
await send('POST /api/input', {
    buffer_id: core?.id ?? probe.id,
    command: `print -buffer=${probe.name} live-line-from-api`,
});
await sleep(1500);
// buffer_id sits on the frame, not inside body, in this protocol version.
const lineEvent = events.find((e) => e.event_name === 'buffer_line_added');
log('event', lineEvent);

// The whole point of the probe: which keys does a 5.0 line object carry?
const sample = lineEvent?.body ?? (Array.isArray(lines.body) ? lines.body[0] : null);
if (sample) {
    log('line-keys', {
        keys: Object.keys(sample).sort(),
        hasDatePrinted: 'date_printed' in sample,
        hasDate: 'date' in sample,
    });
}

ws.close();
await sleep(200);
out.end();
console.log(`\nwrote ${OUT}`);
