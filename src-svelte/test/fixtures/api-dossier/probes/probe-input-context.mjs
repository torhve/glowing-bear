#!/usr/bin/env node
// Live probe: which buffer a command actually runs on.
//
// POST /api/input answers 204 for a command the target buffer cannot run, so the
// status code alone says nothing about execution. This probe separates the two:
//
//   1. A core command on core.weechat executes (verified by asking for its completion).
//   2. An IRC command on core.weechat is 204 and does nothing — WeeChat writes an
//      error line into core.weechat and no buffer is created.
//   3. The same IRC command aimed at a channel buffer works.
//
// It creates a throwaway channel and parts it again.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'raw', 'input-core-context.json');
const CHANNEL = 'irc.gbtest.#glowing-bear';
const PROBE_CHANNEL = '#dossier-join-probe';
const ALIAS = 'zzzctxprobe';

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

const bufferNames = async () => {
    const res = await request('GET /api/buffers');
    const list = Array.isArray(res.body) ? res.body : [];
    return list.map((b) => b.name);
};

const coreLines = async () => {
    const res = await request('GET /api/buffers/core.weechat/lines?lines=-8');
    const lines = Array.isArray(res.body) ? res.body : [];
    return lines.map((l) => l.message);
};

const out = { probed_at: new Date().toISOString(), weechat: '4.10.1', relay_api: '0.6.0' };

// 1. A core command on core.weechat.
const aliasAdd = await request('POST /api/input', {
    buffer_name: 'core.weechat', command: `/alias add ${ALIAS} echo ctx-probe`,
});
await new Promise((r) => setTimeout(r, 800));
const completion = await request('POST /api/completion', {
    buffer_name: 'core.weechat', command: `/${ALIAS.slice(0, 5)}`, position: ALIAS.length,
});
out.core_command = {
    add_status: aliasAdd.code,
    // The alias existing is the only observable proof it executed.
    completion_context: completion.body?.context ?? null,
    completion_list: completion.body?.list ?? [],
};
await request('POST /api/input', { buffer_name: 'core.weechat', command: `/alias del ${ALIAS}` });

// 2. An IRC command on core.weechat.
const namesBefore = await bufferNames();
const joinOnCore = await request('POST /api/input', {
    buffer_name: 'core.weechat', command: `/join ${PROBE_CHANNEL}`,
});
await new Promise((r) => setTimeout(r, 1500));
const namesAfterCore = await bufferNames();
out.irc_command_on_core = {
    join_status: joinOnCore.code,
    buffer_created: namesAfterCore.includes(`irc.gbtest.${PROBE_CHANNEL}`),
    buffer_existed_before: namesBefore.includes(`irc.gbtest.${PROBE_CHANNEL}`),
    core_lines_after: (await coreLines()).filter((m) => /join|irc:/i.test(m)),
};

// 3. The same command aimed at a channel buffer.
const joinOnChannel = await request('POST /api/input', {
    buffer_name: CHANNEL, command: `/join ${PROBE_CHANNEL}`,
});
await new Promise((r) => setTimeout(r, 1500));
const namesAfterChannel = await bufferNames();
out.irc_command_on_channel = {
    join_status: joinOnChannel.code,
    buffer_created: namesAfterChannel.includes(`irc.gbtest.${PROBE_CHANNEL}`),
};

// Leave the fixture as we found it.
if (out.irc_command_on_channel.buffer_created) {
    await request('POST /api/input', { buffer_name: CHANNEL, command: `/part ${PROBE_CHANNEL}` });
}

fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out, null, 2));
ws.close();
