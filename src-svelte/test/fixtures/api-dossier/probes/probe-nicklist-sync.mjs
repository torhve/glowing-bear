// Probe: does POST /api/sync {nicks:true} stream the CURRENT nicklist state,
// or only subsequent deltas?
//
// Method: connect, enable sync with nicks, then sit idle for 4 s and record
// every event. No channel activity is triggered. Afterwards compare the
// event stream against GET /api/buffers/{id}/nicks for a known channel.
//
// Live result (WeeChat 4.10.1, 2026-07-20): zero nicklist events for the
// channel's existing nicks (2 known nicks, 0 events for them) while
// buffer_line_added events flowed — sync is active, nick state is NOT
// included. Deltas (joins/parts/mode changes) DO stream, see
// capture-nicklist-events.mjs.
//
// Consequence for the client: a buffer's nicklist is empty until an
// authoritative snapshot is applied (GET /api/buffers/{id}/nicks on first
// open, or a buffer_opened event carrying nicklist_root). Deltas arriving
// before the snapshot only build a partial list and must not satisfy the
// fetch gate. Tracked as BufferData.nicklistFetched in the app.
import crypto from 'node:crypto';
const ts = Math.floor(Date.now() / 1000);
const hash = crypto.pbkdf2Sync('testpassword123', String(ts), 100000, 32, 'sha256').toString('hex');
const cred = `hash:pbkdf2+sha256:${ts}:100000:${hash}`;
const b64url = (s) => Buffer.from(s).toString('base64url');
const basic = () => 'Basic ' + Buffer.from(cred).toString('base64');

const ws = new WebSocket('ws://127.0.0.1:9010/api', [
    'api.weechat',
    'base64url.bearer.authorization.weechat.' + b64url(cred),
]);
const events = [];
const t0 = Date.now();
ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.message === 'Event') {
        events.push({ t: Date.now() - t0, event_name: msg.event_name, buffer_id: msg.buffer_id });
    }
};
ws.onclose = (e) => console.log('ws close:', e.code);
await new Promise((r) => { ws.onopen = r; });
console.log('connected, enabling sync nicks');
ws.send(JSON.stringify([{ request: 'POST /api/sync', request_id: 'p1', body: { sync: true, nicks: true, input: false, colors: 'weechat' } }]));
// No activity at all — just observe the initial burst.
await new Promise((r) => setTimeout(r, 4000));

const res = await fetch('http://127.0.0.1:9010/api/buffers', {
    headers: { authorization: basic(), accept: 'application/json', connection: 'close' },
});
const buffers = await res.json();
const chan = buffers.find((b) => b.name?.includes('#glowing-bear'));
console.log('channel:', chan?.name, 'id:', chan?.id);
if (chan) {
    const nres = await fetch(`http://127.0.0.1:9010/api/buffers/${chan.id}/nicks`, {
        headers: { authorization: basic(), accept: 'application/json', connection: 'close' },
    });
    const tree = await nres.json();
    const names = [];
    const walk = (g) => { for (const n of g.nicks ?? []) names.push(n.prefix + n.name); for (const c of g.groups ?? []) walk(c); };
    walk(tree);
    console.log('GET /nicks total:', names.length, '->', names.join(' '));
    console.log('nicklist events in idle burst:', events.filter((e) => /nick/i.test(e.event_name)).length);
}
console.log('--- all events (t, name, buffer):');
for (const e of events) console.log(e.t + 'ms', e.event_name, 'buf=' + e.buffer_id);
ws.close();
process.exit(0);
