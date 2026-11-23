#!/usr/bin/env node
// Live probe: one nick completion, two answer shapes, depending on word position.
//
// POST /api/completion answers a nick question differently at the start of the
// composer than anywhere else in it, and a client that adds "a space after the
// candidate" on its own reads one of those two shapes wrongly and inserts two
// spaces. This probe captures both shapes from the same buffer in the same
// session, so the difference cannot be blamed on the nick list or the config.
//
// Read the captured `add_space` next to `list`: the start-of-line answer carries
// the completer suffix AND the trailing space inside the candidate with
// `add_space:false`; a later word comes back bare with `add_space:true`. Exactly
// one of the two says "the client appends the space".
//
// It sends nothing and changes no state. Run with gbtest up:
//   node src-svelte/test/fixtures/api-dossier/probes/probe-completion-shapes.mjs [port]
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.argv[2] || 9010);
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'raw', 'completion-shapes.json');
const CHANNEL = 'irc.gbtest.#glowing-bear';

const ts = Math.floor(Date.now() / 1000);
const hash = crypto.pbkdf2Sync('testpassword123', String(ts), 100000, 32, 'sha256').toString('hex');
const cred = `hash:pbkdf2+sha256:${ts}:100000:${hash}`;
const b64url = (s) => Buffer.from(s).toString('base64url');

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api`, [
    'api.weechat',
    'base64url.bearer.authorization.weechat.' + b64url(cred),
]);
const pending = new Map();
let requestId = 0;

function request(requestLine, body) {
    const request_id = `probe-${++requestId}`;
    return new Promise((resolve, reject) => {
        pending.set(request_id, { resolve });
        // One request per frame: the 4.10.1 relay answers a batched array frame
        // with 400 Bad Request.
        const frame = body === undefined || body === null ? { request: requestLine, request_id } : { request: requestLine, request_id, body };
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
await request('POST /api/sync', { sync: true, nicks: true, input: true, colors: 'weechat' });

const bufs = await request('GET /api/buffers');
const chan = (Array.isArray(bufs.body) ? bufs.body : []).find((b) => b.name === CHANNEL);
if (!chan) {
    console.error(`no ${CHANNEL} buffer — join it in gbtest first`);
    ws.close();
    process.exit(1);
}
const nicks = await request(`GET /api/buffers/${chan.id}/nicks`);
// GET /api/buffers/{id}/nicks answers the root group, with nicks inside `nicks` and
// inside nested `groups`; mapping the response as an array reads an empty nicklist.
const collectNicks = (node, into) => {
    if (!node || typeof node !== 'object') return into;
    for (const nick of node.nicks ?? []) into.push(nick.name);
    for (const group of node.groups ?? []) collectNicks(group, into);
    return into;
};
const nickNames = collectNicks(nicks.body, []);

// The caret sits at `position`, at the end of the word being completed.
const cases = [
    { ask: 'a nick as the only word', command: 'te', position: 2 },
    { ask: 'a nick as the first word, fully typed', command: 'testuser', position: 8 },
    { ask: 'a nick after a word, caret at the end', command: 'hello te', position: 8 },
    { ask: 'a first word with a word after the caret', command: 'te hello', position: 2 },
    { ask: 'a nick between words', command: 'say hi to gb now', position: 12 },
    { ask: 'a command argument', command: '/msg te', position: 7 },
    { ask: 'a command name', command: '/ver', position: 4 },
];

const answers = [];
for (const c of cases) {
    const res = await request('POST /api/completion', { buffer_id: chan.id, command: c.command, position: c.position });
    answers.push({
        ask: c.ask,
        request: { command: c.command, position: c.position },
        // What already sits after the caret: a space here is a space the client
        // must not append again.
        text_after_caret: c.command.slice(c.position),
        code: res.code,
        body: res.body,
    });
    console.log(`${c.ask.padEnd(38)} ${JSON.stringify(c.command)}@${c.position} after=${JSON.stringify(c.command.slice(c.position))} -> ${JSON.stringify(res.body)}`);
}

const out = {
    probed_at: new Date().toISOString(),
    transport: `ws://127.0.0.1:${PORT}/api`,
    buffer: chan.name,
    buffer_id: chan.id,
    nicklist: nickNames,
    answers,
};
fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
console.log(`wrote ${OUT}`);
ws.close();
process.exit(0);
