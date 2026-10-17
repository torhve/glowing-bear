#!/usr/bin/env node
// Live probe: can a FREE buffer reach more content by widening the newest-N
// window, or is its window all it has? Read-only apart from the /exec buffer it
// creates and closes again.
//
// The claim under test is the one `hasNoOlderHistory` rests on: that a reader
// page on a bufferType 1 buffer is a guaranteed no-op. If `lines=-1000` answers
// deeper than `lines=-40` on a free buffer holding more than a page, that claim
// is false and the refusal needs a narrower rule.
//
// Run: node src-svelte/test/fixtures/api-dossier/probes/probe-free-buffer-depth.mjs
import crypto from 'node:crypto';

const NAME = 'gbprobe-deep';

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await new Promise((r) => { ws.onopen = r; });
await request('POST /api/sync', { sync: true, nicks: false, input: true, colors: 'weechat' });

const buffers = async () => (await request('GET /api/buffers?lines=0')).body ?? [];
const core = (await buffers()).find((b) => b.name === 'core.weechat');
if (!core) { console.log('core buffer not found'); process.exit(1); }

await request('POST /api/input', { buffer_id: core.id, command: `/exec -stop ${NAME}` });
await request('POST /api/input', { buffer_id: core.id, command: `/buffer close exec.${NAME}` });
await sleep(300);

console.log('planting 500 rows into a free buffer');
await request('POST /api/input', { buffer_id: core.id, command: `/exec -nf -name ${NAME} seq 1 500` });
await sleep(1500);

const row = (await buffers()).find((b) => String(b.name).includes(NAME));
if (!row) { console.log('free buffer not found'); process.exit(1); }
console.log(JSON.stringify({ name: row.name, short_name: row.short_name, type: row.type }));

const count = async (query) => {
    const res = await request(`GET /api/buffers/${row.id}/lines${query}`);
    const rows = Array.isArray(res.body) ? res.body : [];
    return { n: rows.length, first: rows[0]?.id ?? null, last: rows[rows.length - 1]?.id ?? null };
};

console.log('no param (all)  ->', JSON.stringify(await count('')));
console.log('lines=-40       ->', JSON.stringify(await count('?lines=-40')));
console.log('lines=-1000     ->', JSON.stringify(await count('?lines=-1000')));
console.log('lines=-100000   ->', JSON.stringify(await count('?lines=-100000')));

await request('POST /api/input', { buffer_id: core.id, command: `/exec -stop ${NAME}` });
await request('POST /api/input', { buffer_id: core.id, command: `/buffer close exec.${NAME}` });
ws.close();
