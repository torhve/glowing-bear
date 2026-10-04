#!/usr/bin/env node
// Probe v3 — remaining contract steps.
import fs from 'node:fs';
import net from 'node:net';

const FIFO_PATH = '/tmp/gb-api-probe/' + fs.readdirSync('/tmp/gb-api-probe').find(f => f.startsWith('weechat_fifo_'));
const PASSWORD = 'testpassword123';
const OUT = '/tmp/api-probe-out3.jsonl';
const out = fs.createWriteStream(OUT);
const log = (step, data) => {
    out.write(JSON.stringify({ t: new Date().toISOString(), step, data }) + '\n');
    console.log(`[${step}]`, JSON.stringify(data ?? null).slice(0, 280));
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fifo = (buf, cmd) => { fs.writeFileSync(FIFO_PATH, `${buf} *${cmd}\n`); };
const ctrl = (obj) => new Promise((resolve, reject) => {
    const s = net.connect(16667, '127.0.0.1', () => s.write(JSON.stringify(obj) + '\n'));
    let d = ''; s.on('data', c => d += c); s.on('end', () => resolve(d.trim())); s.on('error', reject);
});
const b64url = s => Buffer.from(s).toString('base64url');

const ws = new WebSocket('ws://127.0.0.1:9010/api', ['api.weechat', 'base64url.bearer.authorization.weechat.' + b64url('plain:' + PASSWORD)]);
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
const send = (request, body) => new Promise((resolve) => {
    const id = 'p' + (++reqId);
    pending.set(id, { resolve });
    const payload = { request, request_id: id };
    if (body !== undefined) payload.body = body;
    ws.send(JSON.stringify(payload));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ timeout: true, id }); } }, 8000);
});

await new Promise(r => { ws.onopen = r; });
await send('POST /api/sync', { sync: true });

const buffers = (await send('GET /api/buffers?lines=0')).body;
const chan = buffers.find(b => b.name === 'irc.gbtest.#apiprobe');
const coreBuf = buffers.find(b => b.name === 'core.weechat');
log('setup', { chanId: chan?.id, coreId: coreBuf?.id });

// completion with real nicks (gbbot2, probebot)
log('completion-gbb', (await send('POST /api/completion', { buffer_id: chan.id, command: 'gbb', position: 3 })).body);
log('completion-prob', (await send('POST /api/completion', { buffer_id: chan.id, command: '/msg prob', position: 9 })).body);
log('completion-cmd', (await send('POST /api/completion', { buffer_id: coreBuf.id, command: '/ver', position: 4 })).body);

// main-buffer trap: input WITHOUT buffer_name/buffer_id
log('input-no-buffer', await send('POST /api/input', { command: '/say trap-line' }));
await sleep(800);
const coreLines = await send('GET /api/buffers/' + coreBuf.id + '/lines?lines=-4');
log('trap-core-lines', coreLines.body?.map(l => (l.message || '').slice(0, 60)));

// free buffer via /exec -nf
fifo('core.weechat', '/exec -nf -name freeprobe2 echo free-line-1 && echo free-line-2');
await sleep(1500);
const freeBuf = (await send('GET /api/buffers?lines=0')).body?.find(b => b.name?.includes('freeprobe2'));
log('free-buffer', freeBuf ? { id: freeBuf.id, type: freeBuf.type, name: freeBuf.name } : 'MISSING');
if (freeBuf) {
    const fl = await send('GET /api/buffers/' + freeBuf.id + '/lines');
    log('free-lines-default', { n: fl.body?.length, msgs: fl.body?.map(l => l.message) });
    const fb0 = await send('GET /api/buffers/' + freeBuf.id + '?lines=0');
    log('free-single-lines0', { lines: fb0.body?.lines?.length });
    const fb1 = await send('GET /api/buffers/' + freeBuf.id + '?lines=5');
    log('free-single-lines5', { lines: fb1.body?.lines?.length, msgs: fb1.body?.lines?.map(l => l.message) });
    const fb2 = await send('GET /api/buffers/' + freeBuf.id + '?lines=5&lines_free=1');
    log('free-single-lines_free1', { lines: fb2.body?.lines?.length, msgs: fb2.body?.lines?.map(l => l.message) });
}

// errors + ping
log('err-bad-buffer', await send('GET /api/buffers/999999999999'));
log('err-unknown-request', await send('GET /api/nonexistent'));
log('err-bad-params', await send('GET /api/buffers?lines=abc'));
log('err-input-no-command', await send('POST /api/input', { buffer_id: chan.id }));
log('ping', await send('POST /api/ping'));

// buffer lifecycle events: open (exec), title, localvar, closing, closed
fifo('core.weechat', '/exec -nf -name lifecycle echo hello');
await sleep(1200);
const lcBuf = (await send('GET /api/buffers?lines=0')).body?.find(b => b.name?.includes('lifecycle'));
if (lcBuf) {
    fifo('core.weechat', '/buffer set localvar_test abc ' + lcBuf.name);
    await sleep(800);
    fifo('core.weechat', '/close ' + lcBuf.name);
    await sleep(1200);
}
// channel close
if (chan) { fifo('core.weechat', '/close ' + chan.name); await sleep(1500); }
log('get-closed-chan', await send('GET /api/buffers/' + chan.id));

// event inventory + samples
const names = {};
for (const e of events) names[e.event_name] = (names[e.event_name] || 0) + 1;
log('event-inventory', names);
for (const want of ['buffer_line_added', 'buffer_opened', 'buffer_localvar_added', 'buffer_closing', 'buffer_closed', 'nicklist_nick_added']) {
    const e = events.find(x => x.event_name === want);
    if (e) log('sample-' + want, e);
}
out.end();
console.log('DONE');
process.exit(0);
