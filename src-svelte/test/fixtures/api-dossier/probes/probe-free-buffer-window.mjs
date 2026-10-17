#!/usr/bin/env node
// Live probe: what a FREE buffer looks like to the API transport, and whether a
// lines request answers it at all. Read-only — it never writes to a buffer.
//
// This exists because "free buffer" was read as "no history to fetch" and the
// rule was applied as a ban on every line request, which left `relay.list`
// rendering empty (issue #11). The claims it backs:
//   1. WeeChat's own status buffers are free buffers: `relay.relay.list` reports
//      `type:"free"`, `short_name:"relay.list"`.
//   2. A free buffer answers a newest-N window request like any other buffer —
//      `lines=-100` returns its whole current window, oldest-first, with line
//      ids starting at 0.
//   3. Those rows predate the request: they are what a client that connects and
//      never sends still has to fetch to show the buffer at all.
//
// Run: node src-svelte/test/fixtures/api-dossier/probes/probe-free-buffer-window.mjs
import crypto from 'node:crypto';

const ts = Math.floor(Date.now() / 1000);
const hash = crypto.pbkdf2Sync('testpassword123', String(ts), 100000, 32, 'sha256').toString('hex');
const cred = `hash:pbkdf2+sha256:${ts}:100000:${hash}`;
const b64url = (s) => Buffer.from(s).toString('base64url');

const ws = new WebSocket('ws://127.0.0.1:9010/api', [
    'api.weechat',
    'base64url.bearer.authorization.weechat.' + b64url(cred),
]);
const pending = new Map();
let requestId = 0;

function request(requestLine, body) {
    const request_id = `probe-${++requestId}`;
    return new Promise((resolve, reject) => {
        pending.set(request_id, { resolve, reject });
        // One request per frame; `body` only when there is one (see the other probes).
        ws.send(JSON.stringify(body === undefined
            ? { request: requestLine, request_id }
            : { request: requestLine, request_id, body }));
        setTimeout(() => {
            if (pending.has(request_id)) { pending.delete(request_id); reject(new Error('timeout ' + requestLine)); }
        }, 15000);
    });
}

ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.request_id && pending.has(msg.request_id)) {
        pending.get(msg.request_id).resolve(msg);
        pending.delete(msg.request_id);
    }
};
ws.onclose = (e) => console.log('ws close:', e.code, e.reason);

await new Promise((r) => { ws.onopen = r; });
await request('POST /api/sync', { sync: true, nicks: false, input: true, colors: 'weechat' });

const buffers = await request('GET /api/buffers?lines=0');
const list = Array.isArray(buffers.body) ? buffers.body : [];
const free = list.filter((b) => b.type === 'free');
console.log(`free buffers on this relay: ${free.length}`);

for (const b of free) {
    console.log(JSON.stringify({
        name: b.name, short_name: b.short_name, type: b.type,
        lines_total: b.lines_total ?? null, first_line_id: b.first_line_id ?? null,
        last_line_id: b.last_line_id ?? null,
    }));
    const lines = await request(`GET /api/buffers/${b.id}/lines?lines=-100&colors=weechat`);
    const rows = Array.isArray(lines.body) ? lines.body : [];
    console.log(`   lines=-100 -> ${rows.length} rows`);
    if (rows.length) console.log('   line keys:', JSON.stringify(Object.keys(rows[0])));
    for (const l of rows.slice(0, 6)) {
        console.log(`   id=${l.id} prefix=${JSON.stringify(l.prefix ?? null)} text=${JSON.stringify(String(l.text ?? l.message ?? '').slice(0, 80))}`);
    }
}

ws.close();
