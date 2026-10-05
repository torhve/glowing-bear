#!/usr/bin/env node
// Live probe: GET /api/scripts shape + how a /grep run changes observable
// buffer state (the content-search wait needs that to tell fresh results from
// stale ones). Run against an isolated probe instance, never the gbtest
// profile — see README.md "Reproducing the probes".
//
//   mkdir -p /tmp/gb-api-probe2/python/autoload
//   cp test/fixtures/gbtest/weechat/*.py /tmp/gb-api-probe2/python/autoload/
//   weechat-headless -d /tmp/gb-api-probe2 --stdout \
//     -r "/set relay.network.password testpassword123" -r "/relay add api 9012" &
//   node probes/probe-scripts-grep.mjs
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const HERE = fileURLToPath(new URL('.', import.meta.url)); // .../api-dossier/probes/
const FRAMES = `${HERE}../frames/probe-scripts-grep.jsonl`;
const SUMMARY = `${HERE}../raw/scripts-grep-freshness.json`;

const API_PORT = 9012;
const PASSWORD = 'testpassword123';

const frameFile = fs.createWriteStream(FRAMES);
const summary = { capturedAt: new Date().toISOString(), steps: [] };
const frames = [];

const log = (step, data) => {
    summary.steps.push({ step, data });
    const s = typeof data === 'string' ? data : JSON.stringify(data);
    console.log(`[${step}]`, s.slice(0, 400));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64url = (s) => Buffer.from(s).toString('base64url');

const ws = new WebSocket(`ws://127.0.0.1:${API_PORT}/api`, [
    'api.weechat',
    'base64url.bearer.authorization.weechat.' + b64url('plain:' + PASSWORD),
]);

let reqId = 0;
const pending = new Map();
const events = [];
ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    frameFile.write(JSON.stringify(msg) + '\n');
    frames.push(msg);
    if (msg.message === 'Event') {
        events.push(msg);
        return;
    }
    const p = pending.get(msg.request_id);
    if (p) {
        pending.delete(msg.request_id);
        p.resolve(msg);
    }
};
ws.onerror = (e) => log('ws-error', String(e.message || e));
ws.onclose = (e) => log('close', `code=${e.code} reason=${e.reason}`);

const send = (request, body) => new Promise((resolve) => {
    const id = 'p' + ++reqId;
    pending.set(id, { resolve });
    const payload = { request, request_id: id };
    if (body !== undefined) payload.body = body;
    ws.send(JSON.stringify(payload));
    setTimeout(() => {
        if (pending.has(id)) {
            pending.delete(id);
            resolve({ timeout: true, id });
        }
    }, 8000);
});

await new Promise((r) => {
    ws.onopen = r;
});
log('open', 'subprotocol=' + ws.protocol);

// 1. /api/scripts — the dossier only proves the response is an array; the
// element shape is what the content-search diagnostics need.
const scripts = await send('GET /api/scripts');
log('STEP scripts', scripts);

// 2. find a buffer to search (isolated probe instance has no IRC; core works)
const listBuffers = () => send('GET /api/buffers?lines=0&nicks=false');
const initial = await listBuffers();
// Events only arrive once POST /api/sync has enabled them (README.md:71).
log('STEP sync', await send('POST /api/sync', { body: { sync: true, nicks: true, input: true, colors: true } }));
const core = Array.isArray(initial.body)
    ? initial.body.find((b) => b.name === 'core.weechat')
    : null;
log('STEP core-buffer', core ? { id: core.id, keys: Object.keys(core) } : 'MISSING');
if (!core) {
    process.exit(1);
}

const grepShortName = 'grep';
const findGrep = (list) => (Array.isArray(list?.body) ? list.body : []).find((b) => b.short_name === grepShortName);

log('STEP grep-before', (() => {
    const g = findGrep(initial);
    return g ? { id: g.id, name: g.name } : null;
})());

// 3. put a searchable line into core, then search for it
log('STEP input-say', await send('POST /api/input', { buffer_id: core.id, command: '/say probe-needle-42' }));
await sleep(400);

const mark = events.length;
log('STEP input-grep-hit', await send('POST /api/input', { buffer_id: core.id, command: '/grep probe-needle-42' }));
await sleep(1500);
log('STEP events-after-hit', events.slice(mark).map((e) => `${e.event_name} ${e.body_type} ${e.buffer_id}`).slice(0, 40));

const afterHit = await listBuffers();
const grepBuf = findGrep(afterHit);
log('STEP grep-buffer-opened', grepBuf ? { id: grepBuf.id, name: grepBuf.name, fields: Object.keys(grepBuf) } : null);
if (!grepBuf) {
    process.exit(1);
}

const linesOf = (id, count = 50) => send(`GET /api/buffers/${id}/lines?count=${count}`);
const hitLines = await linesOf(grepBuf.id);
log('STEP hit-lines', hitLines);

// 4. search for something absent: does the shared buffer change, and what does
// it contain when there are no matches?
const beforeState = await send(`GET /api/buffers/${grepBuf.id}/infolist`);
const beforeLines = (await linesOf(grepBuf.id)).body;
const mark2 = events.length;
log('STEP input-grep-miss', await send('POST /api/input', { buffer_id: core.id, command: '/grep nomatch-xyzzy' }));
await sleep(1500);
log('STEP events-after-miss', events.slice(mark2).map((e) => `${e.event_name} ${e.body_type} ${e.buffer_id}`).slice(0, 40));
const afterLines = (await linesOf(grepBuf.id)).body;
const afterState = await send(`GET /api/buffers/${grepBuf.id}/infolist`);

log('STEP miss-lines', afterLines);
log('STEP infolist-before-after', {
    before: beforeState.body,
    after: afterState.body,
    beforeCount: Array.isArray(beforeLines) ? beforeLines.length : beforeLines,
    afterCount: Array.isArray(afterLines) ? afterLines.length : afterLines,
});

fs.writeFileSync(SUMMARY, JSON.stringify(summary, null, 2) + '\n');
log('wrote', `${SUMMARY} (${frames.length} frames in ${FRAMES})`);
ws.close();
await sleep(200);
process.exit(0);
