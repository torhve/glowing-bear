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
 * The probe certifies the SAME line on the two paths the app uses: fetched
 * history (`GET /api/buffers/<id>/lines`) and a live `buffer_line_added`
 * event. It opens the sync window before producing the line, stamps the line
 * with a unique token, and only accepts samples carrying that token — so a
 * stale line already sitting in the buffer cannot stand in for the one it was
 * asked to produce. It starts nothing, so it can run in CI against a bare
 * fixture relay.
 *
 * Run: node probes/probe-weechat5-line-fields.mjs [port] [buffer-name-substring]
 * Auth mirrors the gbtest fixture: relay.network.password testpassword123 with
 * password_hash_algo pbkdf2+sha256.
 *
 * The line has to be produced by a command, and commands go through a buffer's
 * input line — which WeeChat refuses on core buffers ("You cannot write text in
 * this buffer", measured). So the probe targets a channel buffer and says so
 * plainly rather than reporting a buffer it never tried to reach.
 *
 * Exits non-zero when the contract it exists to check is not met: no writable
 * buffer, no stamped line captured on either path, `date` missing, or
 * `date_printed` back on the wire. A reappearance is not automatically a bug —
 * it means the validator's optionality and the dossier entry need re-reading.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';

const API_PORT = Number(process.argv[2] ?? 9011);
const NAME_MATCH = process.argv[3] ?? '#glowing-bear';
const PASSWORD = 'testpassword123';
const OUT = process.env.GB_PROBE_OUT ?? '/tmp/gb-wc5-probe.jsonl';
const out = fs.createWriteStream(OUT);
const failures = [];

// A probe that can hang is a probe that gets deleted from CI. Everything is
// bounded: each request has its own timeout and the whole run has a deadline.
const RUN_DEADLINE_MS = 45_000;
const watchdog = setTimeout(() => finish('probe exceeded its 45s deadline'), RUN_DEADLINE_MS);

const log = (step, data) => {
    out.write(JSON.stringify({ t: new Date().toISOString(), step, data }) + '\n');
    const s = typeof data === 'string' ? data : JSON.stringify(data ?? null);
    console.log(`[${step}]`, s.slice(0, 400));
};
const fail = (message) => {
    failures.push(message);
    console.error(`FAIL ${message}`);
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
    const timer = setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); resolve({ timeout: true, id }); }
    }, 8000);
    pending.set(id, { resolve, timer });
    const payload = { request, request_id: id };
    if (body !== undefined) payload.body = body;
    ws.send(JSON.stringify(payload));
});

// Poll for a condition rather than sleeping a fixed amount: the verdict should
// arrive as soon as the relay answers, and give up loudly when it never does.
const waitFor = async (find, timeoutMs) => {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
        const found = find();
        if (found) return found;
        await sleep(200);
    }
    return null;
};

const finish = (reason) => {
    clearTimeout(watchdog);
    for (const p of pending.values()) clearTimeout(p.timer);
    pending.clear();
    try { ws.close(); } catch { /* already closed */ }
    out.end();
    if (reason) {
        console.error(`\n${reason}`);
        process.exit(1);
    }
    if (failures.length > 0) {
        console.error(`\n${failures.length} contract failure(s)`);
        process.exit(1);
    }
    console.log('line schema matches the WeeChat 5 contract: `date` present, `date_printed` absent');
    // The relay does not always answer the close frame, and a still-open socket
    // would keep this process alive long after the verdict has been printed.
    process.exit(0);
};

try {
    await new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = reject;
    });
} catch (e) {
    log('error', `could not open the API websocket: ${String(e.message || e)}`);
    finish('cannot certify the line schema without a relay connection');
}

log('version', await send('GET /api/version'));
log('open', 'connected');

const buffers = (await send('GET /api/buffers')).body ?? [];
// A channel buffer is the only kind that accepts an input line, and `name` is
// the field 5.0 serialises (`full_name` is not in the buffers response).
const target =
    buffers.find((b) => (b.name ?? '').includes(NAME_MATCH) && !(b.name ?? '').startsWith('irc.server.'))
    ?? buffers.find((b) => (b.name ?? '').startsWith('irc.') && !(b.name ?? '').startsWith('irc.server.'));
if (!target) {
    log('error', `no channel buffer matching "${NAME_MATCH}" — buffers: ${buffers.map((b) => b.name).join(', ')}`);
    finish('no writable buffer to produce a line in');
}
log('buffer', { id: target.id, name: target.name });

// Subscribe before producing the line: the API relay pushes freshness events
// once a client has opened a sync window, and there is no `sub` request in this
// protocol version.
await send('POST /api/sync', { sync: true, nicks: true, input: true, colors: 'weechat' });
await waitFor(() => events.length > 0, 3000);

// 5.0's input endpoint is POST /api/input with a buffer_id — the per-buffer
// /api/buffers/<id>/input path answers 405, which is itself a contract change.
const stamp = `wc5-probe-${Date.now()}`;
const inputResponse = await send('POST /api/input', {
    buffer_id: target.id,
    command: `print -buffer=${target.name} ${stamp}`,
});
log('input', { code: inputResponse.code, message: inputResponse.message, stamp });

const lineEvent = await waitFor(
    () => events.find((e) => e.event_name === 'buffer_line_added'
        && e.buffer_id === target.id
        && String(e.body?.message ?? '').includes(stamp)),
    10_000,
);
log('event', lineEvent);

const history = await send(`GET /api/buffers/${target.id}/lines?lines=-50`);
const historySample = Array.isArray(history.body)
    ? history.body.find((l) => String(l.message ?? '').includes(stamp))
    : null;
log('history', { total: Array.isArray(history.body) ? history.body.length : history.body, sample: historySample });

// The whole point of the probe: which keys does a 5.0 line object carry?
for (const [label, sample] of [['live', lineEvent?.body], ['history', historySample]]) {
    if (!sample) {
        fail(`${label} path never returned the stamped line — the probe cannot certify the line schema`);
        continue;
    }
    const keys = Object.keys(sample).sort();
    log(`line-keys:${label}`, { keys, hasDatePrinted: 'date_printed' in sample, hasDate: 'date' in sample });
    if (!('date' in sample)) fail(`${label} line object has no \`date\` field`);
    if ('date_printed' in sample) {
        fail(`${label} line object carries \`date_printed\` again — re-read the validator's optionality and the dossier entry`);
    }
}

console.log(`\nwrote ${OUT}`);
finish(null);
