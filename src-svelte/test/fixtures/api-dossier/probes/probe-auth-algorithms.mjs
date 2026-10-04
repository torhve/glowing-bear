#!/usr/bin/env node
// Live verification of every API auth algorithm against a real WeeChat.
// Runs against a DEDICATED probe instance (port 9011, password_hash_algo=*)
// so the shared gbtest fixture is never mutated.
//
// Start the probe instance with:
//   weechat-headless -d /tmp/gb-auth-probe --daemon \
//     -r '/set relay.network.password_hash_algo *' \
//     -r '/set relay.network.password probepassword' \
//     -r '/relay add api 9011'
// (IRC not needed; auth checks happen before any buffer access.)
//
// Verifies: handshake negotiation, HTTP auth per algorithm, wrong-password
// rejection, stale-timestamp rejection (time_window), and the WS subprotocol
// path for each algorithm.

import crypto from 'node:crypto';
import fs from 'node:fs';

const PORT = 9011;
const PASSWORD = 'probepassword';
const OUT = process.argv[2] ?? new URL('../frames/probe-auth.jsonl', import.meta.url).pathname;
const out = fs.createWriteStream(OUT);
const log = (step, data) => {
    out.write(JSON.stringify({ t: new Date().toISOString(), step, data }) + '\n');
    console.log(`[${step}]`, typeof data === 'string' ? data : JSON.stringify(data).slice(0, 200));
};
const b64url = (s) => Buffer.from(s, 'utf8').toString('base64url');

function credential(algo, ts, iterations) {
    if (algo === 'plain') return `plain:${PASSWORD}`;
    if (algo === 'sha256' || algo === 'sha512') {
        const h = crypto.createHash(algo).update(`${ts}${PASSWORD}`).digest('hex');
        return `hash:${algo}:${ts}:${h}`;
    }
    const sub = algo === 'pbkdf2+sha256' ? 'sha256' : 'sha512';
    const dkLen = sub === 'sha256' ? 32 : 64;
    const h = crypto.pbkdf2Sync(PASSWORD, String(ts), iterations, dkLen, sub).toString('hex');
    return `hash:${algo}:${ts}:${iterations}:${h}`;
}

async function httpAuth(cred, label) {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/version`, {
        headers: { authorization: 'Basic ' + Buffer.from(cred, 'utf8').toString('base64'), connection: 'close' },
        signal: AbortSignal.timeout(8000),
    });
    const body = await res.text();
    log(`http:${label}`, `status=${res.status} ${body.slice(0, 120)}`);
    return res.status;
}

function wsAuth(cred, label) {
    return new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api`, [
            'api.weechat',
            'base64url.bearer.authorization.weechat.' + b64url(cred),
        ]);
        const done = (result) => { try { ws.close(); } catch { /* already closed */ } resolve(result); };
        const timer = setTimeout(() => done('timeout'), 5000);
        ws.onopen = () => {
            ws.send(JSON.stringify({ request: 'GET /api/version', request_id: label }));
        };
        ws.onmessage = (e) => {
            const msg = JSON.parse(e.data);
            if (msg.request_id === label) {
                clearTimeout(timer);
                log(`ws:${label}`, `code=${msg.code} ${JSON.stringify(msg.body ?? msg.message).slice(0, 120)}`);
                done(msg.code);
            }
        };
        ws.onerror = () => { clearTimeout(timer); done('error'); };
        ws.onclose = (e) => { clearTimeout(timer); if (e.code !== 1000) done(`close:${e.code}`); };
    });
}

const ALGOS = ['plain', 'sha256', 'sha512', 'pbkdf2+sha256', 'pbkdf2+sha512'];

// 1. Handshake: advertise all, see what the server picks.
const hs = await fetch(`http://127.0.0.1:${PORT}/api/handshake`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password_hash_algo: ALGOS }),
});
const negotiation = await hs.json();
log('handshake', negotiation);
const iterations = negotiation.password_hash_iterations;

// 2. Each algorithm over HTTP and WS with a fresh timestamp.
for (const algo of ALGOS) {
    const ts = Math.floor(Date.now() / 1000);
    const httpStatus = await httpAuth(credential(algo, ts, iterations), algo);
    await new Promise((r) => setTimeout(r, 250));
    const wsCode = await wsAuth(credential(algo, Math.floor(Date.now() / 1000), iterations), algo);
    log('result', `${algo}: http=${httpStatus} ws=${wsCode}`);
}

// 3. Wrong password must be rejected for every algorithm.
for (const algo of ALGOS) {
    const ts = Math.floor(Date.now() / 1000);
    const wrong = algo === 'plain'
        ? 'plain:wrong'
        : (algo === 'sha256' || algo === 'sha512')
            ? `hash:${algo}:${ts}:${crypto.createHash(algo).update(`${ts}wrong`).digest('hex')}`
            : `hash:${algo}:${ts}:${iterations}:${crypto.pbkdf2Sync('wrong', String(ts), iterations, algo.includes('512') ? 64 : 32, algo.includes('512') ? 'sha512' : 'sha256').toString('hex')}`;
    const status = await httpAuth(wrong, `${algo}-wrongpw`);
    log('result', `${algo} wrong password: http=${status} (expect 401)`);
}

// 4. Stale timestamp (outside time_window, default 5 s) must be rejected.
const stale = Math.floor(Date.now() / 1000) - 60;
const staleStatus = await httpAuth(credential('pbkdf2+sha256', stale, iterations), 'pbkdf2+sha256-stale-ts');
log('result', `stale timestamp: http=${staleStatus} (expect 401)`);

log('done', 'auth probe complete');
out.end();
