#!/usr/bin/env node
// Live probe: how deep a buffer's history actually goes on the relay side.
//
// Two claims this exists to back:
//   1. The relay has no page ceiling of its own — a wide `lines` request is
//      answered with everything the buffer holds (see probe-history-window.mjs).
//   2. What DOES cap depth is WeeChat itself: `weechat.history.max_buffer_lines_number`
//      defaults to 4096, so a buffer keeps at most that many lines in memory no
//      matter how much traffic it has seen. Planting more than that into a
//      channel therefore yields a response shorter than the plant.
//
// This probe writes to a dedicated channel it creates and then leaves, so it
// does not disturb the shared fixture beyond adding one buffer.
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'raw', 'buffer-history-cap.json');
const PLANT = Number(process.env.GB_PLANT ?? '6000');
const CHANNEL = `gbcap${Math.floor(Date.now() / 1000)}`;
const HOME = 'irc.gbtest.#glowing-bear';

const ts = Math.floor(Date.now() / 1000);
const hash = crypto.pbkdf2Sync('testpassword123', String(ts), 100000, 32, 'sha256').toString('hex');
const cred = `hash:pbkdf2+sha256:${ts}:100000:${hash}`;
const b64url = (s) => Buffer.from(s).toString('base64url');

/** One control socket, many commands, counted by newline-terminated replies. */
function control(command) {
    return new Promise((resolve, reject) => {
        const sock = new net.Socket();
        const timeout = setTimeout(() => { sock.destroy(); reject(new Error('control timeout')); }, 30000);
        let buf = '';
        let done = 0;
        sock.connect(16667, 'localhost', () => sock.write(JSON.stringify(command) + '\n'));
        sock.on('data', (chunk) => {
            buf += chunk.toString();
            let nl;
            while ((nl = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, nl).trim();
                buf = buf.slice(nl + 1);
                if (!line) continue;
                const parsed = JSON.parse(line);
                if (parsed.success === false || parsed.error) {
                    clearTimeout(timeout); sock.destroy(); reject(new Error(String(parsed.error ?? 'control failed'))); return;
                }
                done++;
                if (done >= (command.count ?? 1)) { clearTimeout(timeout); sock.end(); resolve(done); return; }
            }
        });
        sock.on('error', (err) => { clearTimeout(timeout); reject(err); });
    });
}

const ws = new WebSocket('ws://127.0.0.1:9010/api', [
    'api.weechat',
    'base64url.bearer.authorization.weechat.' + b64url(cred),
]);
const pending = new Map();
let requestId = 0;

function request(requestLine, body) {
    const request_id = `probe-${++requestId}`;
    return new Promise((resolve, reject) => {
        pending.set(request_id, { resolve });
        const frame = body === undefined || body === null
            ? { request: requestLine, request_id }
            : { request: requestLine, request_id, body };
        ws.send(JSON.stringify(frame));
        setTimeout(() => { if (pending.has(request_id)) { pending.delete(request_id); reject(new Error(`timeout ${requestLine}`)); } }, 30000);
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

await new Promise((r) => { ws.onopen = r; });
await request('POST /api/sync', { sync: true, nicks: false, input: true, colors: 'weechat' });

// The bot must be in the channel before WeeChat joins it, or the channel is
// created empty on the IRC side only.
await control({ cmd: 'join', channel: `#${CHANNEL}` });
// IRC commands must run on an IRC buffer — aimed at core.weechat they are
// accepted and silently do nothing (see probe-input-context.mjs).
await request('POST /api/input', { buffer_name: HOME, command: `/join #${CHANNEL}` });
await new Promise((r) => setTimeout(r, 1500));

const bufs = await request('GET /api/buffers?lines=0');
const list = Array.isArray(bufs.body) ? bufs.body.flat() : bufs.body;
const hit = list.find((b) => b.name === `irc.gbtest.#${CHANNEL}`);
if (!hit) {
    console.error('channel buffer not found; is gbtest running and no E2E in flight?');
    process.exit(1);
}


// A single command only sends one line; pipeline them over one socket.
// One socket, one command at a time. `more: true` is what keeps the control
// server answering on the same connection instead of closing after the first reply.
await new Promise((resolve, reject) => {
    const sock = new net.Socket();
    const timeout = setTimeout(() => { sock.destroy(); reject(new Error('plant timeout')); }, 180000);
    const texts = Array.from({ length: PLANT }, (_, i) => `cap ${i} ${'x'.repeat(20)}`);
    let sent = 0;
    let buf = '';
    const queueNext = () => {
        if (sent >= texts.length) { clearTimeout(timeout); sock.end(); resolve(); return; }
        sock.write(JSON.stringify({ cmd: 'send_message', channel: `#${CHANNEL}`, text: texts[sent], more: true }) + '\n');
    };
    sock.connect(16667, 'localhost', queueNext);
    sock.on('data', (chunk) => {
        buf += chunk.toString();
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            const parsed = JSON.parse(line);
            if (parsed.success === false || parsed.error) { clearTimeout(timeout); sock.destroy(); reject(new Error(String(parsed.error))); return; }
            sent++;
            queueNext();
        }
    });
    sock.on('error', (err) => { clearTimeout(timeout); reject(err); });
});

// Give WeeChat time to receive the tail of the plant before measuring.
await new Promise((r) => setTimeout(r, 4000));

const wide = await request(`GET /api/buffers/${hit.id}/lines?lines=-100000`);
const arr = Array.isArray(wide.body) ? wide.body.flat() : wide.body;

await request('POST /api/input', { buffer_name: HOME, command: `/part #${CHANNEL}` });

const result = {
    channel: hit.name,
    planted: PLANT,
    relay_lines_returned: arr.length,
    weechat_history_option: 'weechat.history.max_buffer_lines_number (default 4096)',
    note: 'The relay answers a wide lines request with everything the buffer holds. '
        + 'The buffer itself is bounded by WeeChat, not by the relay, so a client ceiling '
        + 'above this number can never be reached while WeeChat keeps its default.',
};
fs.writeFileSync(OUT, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
process.exit(0);
