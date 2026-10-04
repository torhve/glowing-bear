#!/usr/bin/env node
// Live WeeChat relay API probe (v2 — corrected wire contract from 4.10.1 source).
import fs from 'node:fs';
import net from 'node:net';

const API_PORT = 9010;
const CONTROL_PORT = 16667;
const FIFO_PATH = '/tmp/gb-api-probe/' + fs.readdirSync('/tmp/gb-api-probe').find(f => f.startsWith('weechat_fifo_'));
const PASSWORD = 'testpassword123';
const OUT = '/tmp/api-probe-out.jsonl';
const out = fs.createWriteStream(OUT);

const log = (step, data) => {
    out.write(JSON.stringify({ t: new Date().toISOString(), step, data }) + '\n');
    const s = typeof data === 'string' ? data : JSON.stringify(data);
    console.log(`[${step}]`, s.slice(0, 300));
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fifo = (buf, cmd) => { fs.writeFileSync(FIFO_PATH, `${buf} *${cmd}\n`); };
const ctrl = (obj) => new Promise((resolve, reject) => {
    const s = net.connect(CONTROL_PORT, '127.0.0.1', () => s.write(JSON.stringify(obj) + '\n'));
    let d = '';
    s.on('data', c => { d += c; });
    s.on('end', () => resolve(d.trim()));
    s.on('error', reject);
});
const b64url = s => Buffer.from(s).toString('base64url');

const ws = new WebSocket(`ws://127.0.0.1:${API_PORT}/api`, [
    'api.weechat',
    'base64url.bearer.authorization.weechat.' + b64url('plain:' + PASSWORD),
]);

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
ws.onclose = (e) => log('close', `code=${e.code} reason=${e.reason}`);

const send = (request, body) => new Promise((resolve) => {
    const id = 'p' + (++reqId);
    pending.set(id, { resolve });
    const payload = { request, request_id: id };
    if (body !== undefined) payload.body = body;
    ws.send(JSON.stringify(payload));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ timeout: true, id }); } }, 8000);
});
const batch = (items) => new Promise((resolve) => {
    const got = [];
    let n = 0;
    const ids = items.map(it => 'b' + (++reqId) + '.' + n++);
    items.forEach((it, i) => pending.set(ids[i], { resolve: (msg) => {
        got.push(msg);
        if (got.length === items.length) resolve(got);
    } }));
    ws.send(JSON.stringify(items.map((it, i) => ({ ...it, request_id: ids[i] }))));
    setTimeout(() => resolve(got), 8000);
});

await new Promise(r => { ws.onopen = r; });
log('open', 'subprotocol=' + ws.protocol);

// 1. batch bootstrap: buffers -> sync -> hotlist
const boot = await batch([
    { request: 'GET /api/buffers?lines=0&nicks=false' },
    { request: 'POST /api/sync', body: { sync: true } },
    { request: 'GET /api/hotlist' },
]);
log('STEP batch-bootstrap', boot.map(b => ({ code: b.code, body_type: b.body_type })));

const buffers = boot[0].body;
const chan = Array.isArray(buffers) ? buffers.find(b => b.name === 'irc.gbtest.#apiprobe') : null;
log('STEP chan', chan ? { id: chan.id, keys: Object.keys(chan) } : 'MISSING');
if (!chan) { out.end(); process.exit(1); }
const chanId = chan.id;

log('STEP ctrl-join', await ctrl({ cmd: 'join', channel: '#apiprobe' }));
await sleep(1500);

// 2. completion (command field, position required by schema)
log('STEP completion-nick', await send('POST /api/completion', { buffer_id: chanId, command: 'test', position: 4 }));
log('STEP completion-cmd', await send('POST /api/completion', { buffer_id: chanId, command: '/me he', position: 6 }));

// 3. input + pushed line
log('STEP input-say', await send('POST /api/input', { buffer_id: chanId, command: '/say api-line-1' }));
log('STEP ctrl-msg', await ctrl({ cmd: 'send_message', channel: '#apiprobe', text: 'bot-line-1' }));
await sleep(1500);

// 4. lines variants
log('STEP lines-default', await send('GET /api/buffers/' + chanId + '/lines'));
log('STEP lines-0', await send('GET /api/buffers/' + chanId + '/lines?lines=0'));
log('STEP lines-neg3', await send('GET /api/buffers/' + chanId + '/lines?lines=-3'));
log('STEP lines-pos3', await send('GET /api/buffers/' + chanId + '/lines?lines=3'));
log('STEP line-single', await send('GET /api/buffers/' + chanId + '/lines/1'));

// 5. nicks
log('STEP nicks', await send('GET /api/buffers/' + chanId + '/nicks'));

// 6. hotlist after messages
log('STEP hotlist-after', await send('GET /api/hotlist'));

// 7. G1 experiment
fifo('irc.gbtest.#apiprobe', '/buffer set notify 0');
await sleep(400);
await ctrl({ cmd: 'send_message', channel: '#apiprobe', text: 'muted-msg' });
await sleep(800);
log('STEP G1-notify0-hotlist', (await send('GET /api/hotlist')).body);
fifo('irc.gbtest.#apiprobe', '/buffer set notify 1');
await sleep(400);
await ctrl({ cmd: 'send_pm', nick: 'probebot', text: 'pm-msg' });
await sleep(800);
log('STEP G1-notify1-hotlist', (await send('GET /api/hotlist')).body);
fifo('irc.gbtest.#apiprobe', '/buffer set notify 2');
await sleep(400);
await ctrl({ cmd: 'send_message', channel: '#apiprobe', text: 'msg-lvl2' });
await sleep(800);
log('STEP G1-notify2-hotlist', (await send('GET /api/hotlist')).body);
fifo('irc.gbtest.#apiprobe', '/buffer set notify 3');
await sleep(400);
await ctrl({ cmd: 'send_message', channel: '#apiprobe', text: 'msg-lvl3' });
await sleep(800);
log('STEP G1-notify3-hotlist', (await send('GET /api/hotlist')).body);
log('STEP G1-buffer-keys', Object.keys((await send('GET /api/buffers/' + chanId)).body[0] ?? {}));

// 8. free buffer + lines_free
fifo('core.weechat', '/exec -buffer freeprobe echo free-line-1 && echo free-line-2');
await sleep(1500);
const freeBuf = (await send('GET /api/buffers?lines=0')).body?.find(b => b.name?.includes('freeprobe'));
log('STEP free-buffer', freeBuf ? { id: freeBuf.id, type: freeBuf.type } : 'MISSING');
if (freeBuf) {
    const fl = await send('GET /api/buffers/' + freeBuf.id + '/lines');
    log('STEP free-lines-default', { count: fl.body?.lines?.length ?? fl.body?.length, sample: JSON.stringify(fl.body).slice(0, 200) });
    const fb = await send('GET /api/buffers/' + freeBuf.id + '?lines=5&lines_free=2');
    log('STEP free-buffer-lines_free', JSON.stringify(fb.body).slice(0, 300));
}

// 9. main-buffer trap
log('STEP input-badbuffer', await send('POST /api/input', { buffer_name: 'does.not.exist', command: '/say trap-line' }));
await sleep(800);
const coreBuf = (await send('GET /api/buffers?lines=0')).body?.find(b => b.name === 'core.weechat');
const coreLines = await send('GET /api/buffers/' + coreBuf.id + '/lines?lines=-6');
log('STEP trap-core-lines', coreLines.body?.lines?.map(l => (l.text || '').slice(0, 70)));

// 10. errors + ping
log('STEP err-bad-buffer', await send('GET /api/buffers/999999999999'));
log('STEP err-unknown-request', await send('GET /api/nonexistent'));
log('STEP err-bad-params', await send('GET /api/buffers?lines=abc'));
log('STEP ping', await send('POST /api/ping'));

// 11. close events
fifo('irc.gbtest.#apiprobe', '/close');
await sleep(2000);
log('STEP close-events', events.filter(e => e.event_name === 'buffer_closing' || e.event_name === 'buffer_closed')
    .map(e => ({ name: e.event_name, buffer_id: e.buffer_id, body_type: e.body_type })));
log('STEP get-closed-buffer', await send('GET /api/buffers/' + chanId));

// 12. event inventory
const names = {};
for (const e of events) names[e.event_name] = (names[e.event_name] || 0) + 1;
log('STEP event-inventory', names);
log('STEP sample-event-frame', events.find(e => e.event_name === 'buffer_line_added'));

out.end();
console.log('DONE — ' + OUT);
process.exit(0);
