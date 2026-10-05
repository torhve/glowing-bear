#!/usr/bin/env node
// Live probe: buffer metadata + input event wire shapes (WeeChat 4.10.1, API 0.6.0).
// Mutations are confined to the core buffer so the shared fixture is untouched.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'raw', 'metadata-events.json');

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
        ws.send(JSON.stringify([{ request: requestLine, request_id, body: body ?? null }]));
        setTimeout(() => { if (pending.has(request_id)) { pending.delete(request_id); reject(new Error(`timeout ${requestLine}`)); } }, 8000);
    });
}

ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.request_id && pending.has(msg.request_id)) {
        const { resolve } = pending.get(msg.request_id);
        pending.delete(msg.request_id);
        resolve(msg);
        return;
    }
    if (msg.message === 'Event' || msg.event_name) {
        captured.push(msg);
        const body = msg.body;
        const summary = body && typeof body === 'object'
            ? `keys=[${Object.keys(body).slice(0, 8).join(',')}${Object.keys(body).length > 8 ? ',…' : ''}]`
            : JSON.stringify(body);
        console.log(`event ${msg.event_name ?? msg.body_type} buffer_id=${msg.buffer_id} ${summary}`);
    }
};
ws.onclose = (e) => console.log('ws close:', e.code, e.reason);

await new Promise((r) => { ws.onopen = r; });
console.log('connected');
await request('POST /api/sync', { sync: true, nicks: false, input: true, colors: 'weechat' });
await request('GET /api/buffers');

const commands = [
    '/buffer set localvar_set_probe hello',
    '/buffer set localvar_set_probe bye',
    '/buffer set localvar_del_probe',
    '/input insert probe-text',
    '/input delete_all',
    '/buffer clear',
];
for (const command of commands) {
    const res = await request('POST /api/input', { command, buffer_name: 'core.weechat' });
    console.log(`input ${JSON.stringify(command)} -> ${res.code}`);
    await new Promise((r) => setTimeout(r, 400));
}
await new Promise((r) => setTimeout(r, 1200));
ws.close();

fs.writeFileSync(OUT, JSON.stringify({ capturedAt: new Date().toISOString(), events: captured }, null, 2));
console.log(`captured ${captured.length} events -> ${OUT}`);
process.exit(0);
