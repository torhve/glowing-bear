#!/usr/bin/env node
/**
 * Dump the real 5.0 wire schema, field by field.
 *
 * The changelog says what changed; this says what the relay actually sends, which
 * is the only thing a client can react to. Two things are easy to get wrong from
 * the changelog alone:
 *   - line identifiers become "current date/time with microseconds", which is a
 *     20-digit number and therefore NOT a safe JS number;
 *   - buffer fields are added (day_change, notify, prefix_displayed,
 *     first_line_not_read) and one is renamed (next_line_id ->
 *     lines_last_id_assigned).
 *
 * Auth mirrors the gbtest fixtures: relay.network.password testpassword123 with
 * password_hash_algo pbkdf2+sha256, so the WS credential must be the PBKDF2 hash.
 *
 * Usage: node probe-weechat5-schema.mjs [port]
 */
import crypto from 'node:crypto';

const PORT = Number(process.argv[2] ?? 9011);
const PASSWORD = process.argv[3] ?? 'testpassword123';
const b64 = (s) => Buffer.from(s).toString('base64url');
const ts = Math.floor(Date.now() / 1000);
const iters = 100000;
const hash = crypto.pbkdf2Sync(PASSWORD, String(ts), iters, 32, 'sha256').toString('hex');

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api`, [
    'api.weechat',
    'base64url.bearer.authorization.weechat.' + b64(`hash:pbkdf2+sha256:${ts}:${iters}:${hash}`),
]);

const pend = new Map();
const events = [];
let n = 0;
let failure = null;

const send = (request, body) => new Promise((res) => {
    const id = 'q' + (++n);
    pend.set(id, res);
    ws.send(JSON.stringify({ request, request_id: id, ...(body !== undefined ? { body } : {}) }));
    setTimeout(() => { if (pend.has(id)) { pend.delete(id); res({ request, timedOut: true }); } }, 8000);
});

ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.request_id) {
        const p = pend.get(m.request_id);
        if (p) { pend.delete(m.request_id); p(m); }
    } else if (m.event_name) {
        events.push(m);
    }
};
ws.onerror = (e) => { failure = `websocket error: ${e.message ?? 'unknown'}`; };
ws.onclose = (e) => { if (e.code !== 1000) failure = failure ?? `websocket closed with code ${e.code}`; };

await new Promise((res, rej) => { ws.onopen = res; ws.onerror = (e) => rej(new Error(`websocket error: ${e.message}`)); });

const version = await send('GET /api/version');
console.log('=== version ===');
console.log(JSON.stringify(version.body));

// Ask for every column so nothing is hidden behind a default column list.
const buffers = await send('GET /api/buffers', { columns: ['*'] });
const list = Array.isArray(buffers.body) ? buffers.body : [];
console.log(`\n=== buffers: ${list.length} returned (${buffers.code}) ===`);
const channel = list.find((b) => String(b.full_name || '').includes('#glowing-bear')) || list[0];
console.log('buffer keys:', JSON.stringify(Object.keys(channel ?? {}).sort()));
console.log('buffer sample:', JSON.stringify(channel));

const bufferId = channel?.id;

const lines = await send(`GET /api/buffers/${bufferId}/lines`, { columns: ['*'], max_lines: 5 });
const lineList = Array.isArray(lines.body) ? lines.body : [];
console.log(`\n=== lines: ${lineList.length} returned (${lines.code}) ===`);
if (lineList.length > 0) {
    console.log('line keys:', JSON.stringify(Object.keys(lineList[0]).sort()));
    console.log('line sample:', JSON.stringify(lineList[0]));
    const ids = lineList.map((l) => l.id);
    console.log('line ids:', JSON.stringify(ids));
    console.log('id typeof:', typeof ids[0],
        'Number.isSafeInteger:', ids.map((i) => Number.isSafeInteger(i)),
        'MAX_SAFE_INTEGER:', Number.MAX_SAFE_INTEGER);
}

await send('EVENTS', {
    event_names: ['buffer_line_added', 'buffer_notify_changed', 'buffer_day_change_changed', 'day_changed'],
    subscribed: true,
    event_options: { buffer_line_added: { body_format: 'full' } },
});
const inputRes = await send('POST /api/input', {
    buffer_id: bufferId,
    body: { input: '/me auditing the 5.0 wire schema' },
});
console.log(`\n=== POST /api/input === ${inputRes.code ?? 'timed out'} ${inputRes.message ?? ''}`);

const deadline = Date.now() + 6000;
while (Date.now() < deadline) {
    const hit = events.find((e) => e.event_name === 'buffer_line_added');
    if (hit) {
        console.log('\n=== buffer_line_added ===');
        console.log('event keys:', JSON.stringify(Object.keys(hit).sort()));
        console.log('line keys:', JSON.stringify(Object.keys(hit.event_body ?? {}).sort()));
        console.log('line body:', JSON.stringify(hit.event_body));
        const id = hit.event_body?.id;
        console.log('live id typeof:', typeof id, 'value:', String(id),
            'Number.isSafeInteger:', Number.isSafeInteger(id));
        break;
    }
    await new Promise((r) => setTimeout(r, 50));
}
console.log('\n=== events observed ===', JSON.stringify(events.map((e) => e.event_name)));

ws.close(1000);
if (failure) {
    console.error(`\nprobe failure: ${failure}`);
    process.exit(1);
}
