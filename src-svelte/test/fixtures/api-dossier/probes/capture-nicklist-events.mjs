// Capture raw nicklist events from the API relay while the bot parts/joins.
import crypto from 'node:crypto';
import net from 'node:net';

const ts = Math.floor(Date.now() / 1000);
const hash = crypto.pbkdf2Sync('testpassword123', String(ts), 100000, 32, 'sha256').toString('hex');
const cred = `hash:pbkdf2+sha256:${ts}:100000:${hash}`;
const b64url = (s) => Buffer.from(s).toString('base64url');

const ws = new WebSocket('ws://127.0.0.1:9010/api', [
    'api.weechat',
    'base64url.bearer.authorization.weechat.' + b64url(cred),
]);
const events = [];
ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.message === 'Event') events.push(msg);
};
ws.onclose = (e) => console.log('ws close:', e.code, e.reason);
await new Promise((r) => { ws.onopen = r; });
console.log('connected');
ws.send(JSON.stringify([
    { request: 'POST /api/sync', request_id: 'cap-1', body: { sync: true, nicks: true, input: false, colors: 'weechat' } },
]));
await new Promise((r) => setTimeout(r, 1000));

const ctrl = net.connect(16667, 'localhost', () => {
    ctrl.write('{"cmd":"part","channel":"#glowing-bear"}\n');
    setTimeout(() => ctrl.write('{"cmd":"join","channel":"#glowing-bear"}\n'), 1000);
    setTimeout(() => ctrl.end(), 2000);
});
await new Promise((r) => setTimeout(r, 4000));
ws.close();

const nickEvents = events.filter((e) => /nicklist/i.test(JSON.stringify(e).slice(0, 250)));
console.log('total events:', events.length, '| nicklist:', nickEvents.length);
for (const e of nickEvents) console.log(JSON.stringify(e).slice(0, 500));

process.exit(0);
