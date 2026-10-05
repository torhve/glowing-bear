#!/usr/bin/env node
// Live probe: the 'quit' relay lifecycle event (manual event table row).
// The API command whitelist (relay.network.commands = "*,!quit") blocks /quit
// over the API, so quit is triggered out-of-band via the WeeChat fifo:
//   echo /quit > /tmp/gbtest-weechat/weechat_fifo_<pid>
// Destructive to the fixture — restart with: npm run irc:start
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'raw', 'quit-event.json');

const ts = Math.floor(Date.now() / 1000);
const hash = crypto.pbkdf2Sync('testpassword123', String(ts), 100000, 32, 'sha256').toString('hex');
const cred = `hash:pbkdf2+sha256:${ts}:100000:${hash}`;
const b64url = (s) => Buffer.from(s).toString('base64url');

const ws = new WebSocket('ws://127.0.0.1:9010/api', [
    'api.weechat',
    'base64url.bearer.authorization.weechat.' + b64url(cred),
]);
const captured = [];
ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.message === 'Event') {
        captured.push(msg);
        console.log('event', JSON.stringify(msg));
    }
};
ws.onerror = (e) => console.log('error:', e.message ?? 'unknown');
ws.onclose = (e) => {
    console.log('ws close:', e.code, e.reason);
    fs.writeFileSync(OUT, JSON.stringify({ capturedAt: new Date().toISOString(), events: captured }, null, 2));
    console.log(`captured ${captured.length} events -> ${OUT}`);
    process.exit(0);
};
await new Promise((r) => { ws.onopen = r; });
console.log('connected');
ws.send(JSON.stringify([{ request: 'POST /api/sync', request_id: 'q-1', body: { sync: true } }]));
setTimeout(() => { console.log('hard timeout'); process.exit(1); }, 15000);
