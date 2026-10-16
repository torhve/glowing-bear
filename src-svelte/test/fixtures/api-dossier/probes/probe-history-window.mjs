#!/usr/bin/env node
// Live probe: how far a lines request reaches, and what `after` actually means.
// Read-only — it asks for history and never writes to a buffer.
//
// Two claims this exists to back:
//   1. There is no server-side page ceiling: a large negative `lines` returns
//      the buffer's whole history in one response.
//   2. `after=<lineId>` is an INCLUSIVE LOWER bound on the *newer* side — it
//      answers with lines at or after that id, never older ones — so paging
//      older content is only possible by asking for a wider newest-N window.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'raw', 'history-window.json');
const CHANNEL = 'irc.gbtest.#glowing-bear';

const ts = Math.floor(Date.now() / 1000);
const hash = crypto.pbkdf2Sync('testpassword123', String(ts), 100000, 32, 'sha256').toString('hex');
const cred = `hash:pbkdf2+sha256:${ts}:100000:${hash}`;
const b64url = (s) => Buffer.from(s).toString('base64url');

const ws = new WebSocket('ws://127.0.0.1:9010/api', [
    'api.weechat',
    'base64url.bearer.authorization.weechat.' + b64url(cred),
]);
const captured = [];
const pending = new Map();
let requestId = 0;

function request(requestLine, body) {
    const request_id = `probe-${++requestId}`;
    return new Promise((resolve, reject) => {
        pending.set(request_id, { resolve });
        // One request per frame, and `body` only when there is one: the 4.10.1
        // relay answers a batched array frame, or a GET carrying `body: null`,
        // with 400 Bad Request.
        const frame = body === undefined || body === null
            ? { request: requestLine, request_id }
            : { request: requestLine, request_id, body };
        ws.send(JSON.stringify(frame));
        setTimeout(() => { if (pending.has(request_id)) { pending.delete(request_id); reject(new Error(`timeout ${requestLine}`)); } }, 15000);
    });
}

ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.message === 'Event') return;
    if (msg.request_id && pending.has(msg.request_id)) {
        const { resolve } = pending.get(msg.request_id);
        pending.delete(msg.request_id);
        resolve(msg);
    }
};
ws.onclose = (e) => console.log('ws close:', e.code, e.reason);

await new Promise((r) => { ws.onopen = r; });
console.log('connected');
await request('POST /api/sync', { sync: true, nicks: false, input: true, colors: 'weechat' });

const buffers = await request('GET /api/buffers?lines=0');
const list = Array.isArray(buffers.body) ? buffers.body : [];
const channel = list.find((b) => b.name === CHANNEL);
if (!channel) { console.log('channel not found'); process.exit(1); }
console.log('buffer id', channel.id);

const ids = (body) => (Array.isArray(body) ? body : []).map((l) => l.id);

// 1. How deep does one request go?
const newest5 = ids((await request(`GET /api/buffers/${channel.id}/lines?lines=-5`)).body);
const deep5000 = ids((await request(`GET /api/buffers/${channel.id}/lines?lines=-5000`)).body);
const deeper = ids((await request(`GET /api/buffers/${channel.id}/lines?lines=-100000`)).body);
console.log(`lines=-5        -> ${newest5.length} lines`);
console.log(`lines=-5000     -> ${deep5000.length} lines`);
console.log(`lines=-100000   -> ${deeper.length} lines`);
console.log(`same set at -5000 and -100000: ${JSON.stringify(deep5000) === JSON.stringify(deeper)}`);

// 2. Is there any cursor into older content? `after` and `before` are accepted
//    without error, so ask each of them in both directions and compare against
//    what `lines` alone answers.
const oldestId = deeper[0];
const middleId = deeper[Math.floor(deeper.length / 2)];
const newestAgain = ids((await request(`GET /api/buffers/${channel.id}/lines?lines=-5`)).body);
const queries = {
    'lines=-5': newestAgain,
    [`after=${middleId}&lines=-5`]: ids((await request(`GET /api/buffers/${channel.id}/lines?after=${middleId}&lines=-5`)).body),
    [`before=${middleId}&lines=-5`]: ids((await request(`GET /api/buffers/${channel.id}/lines?before=${middleId}&lines=-5`)).body),
    'lines=5': ids((await request(`GET /api/buffers/${channel.id}/lines?lines=5`)).body),
    [`after=${middleId}&lines=5`]: ids((await request(`GET /api/buffers/${channel.id}/lines?after=${middleId}&lines=5`)).body),
    [`before=${middleId}&lines=5`]: ids((await request(`GET /api/buffers/${channel.id}/lines?before=${middleId}&lines=5`)).body),
    [`after=${oldestId}&lines=-100000`]: ids((await request(`GET /api/buffers/${channel.id}/lines?after=${oldestId}&lines=-100000`)).body),
};
for (const [q, got] of Object.entries(queries)) {
    console.log(`${q.padEnd(34)} -> n=${got.length} first=${got[0]} last=${got[got.length - 1]}`);
}
const unchanged = (a, b) => JSON.stringify(a) === JSON.stringify(b);
console.log(`after and before are ignored: ${
    unchanged(queries[`after=${middleId}&lines=-5`], newestAgain)
    && unchanged(queries[`before=${middleId}&lines=-5`], newestAgain)
    && unchanged(queries[`after=${oldestId}&lines=-100000`], deeper)}`);

captured.push({
    probed_at: new Date().toISOString(),
    buffer: CHANNEL,
    id: channel.id,
    counts: { 'lines=-5': newest5.length, 'lines=-5000': deep5000.length, 'lines=-100000': deeper.length },
    identical_at_5000_and_100000: JSON.stringify(deep5000) === JSON.stringify(deeper),
    total_lines: deeper.length,
    oldest_line_id: oldestId,
    middle_line_id: middleId,
    line_queries: Object.fromEntries(Object.entries(queries).map(([q, got]) => [q, { count: got.length, first: got[0], last: got[got.length - 1] }])),
    cursor_params_ignored: unchanged(queries[`after=${middleId}&lines=-5`], newestAgain)
        && unchanged(queries[`before=${middleId}&lines=-5`], newestAgain)
        && unchanged(queries[`after=${oldestId}&lines=-100000`], deeper),
});
fs.writeFileSync(OUT, captured.map((c) => JSON.stringify(c)).join('\n') + '\n');
console.log('wrote', OUT);
process.exit(0);
