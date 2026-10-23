#!/usr/bin/env node
/**
 * What does the legacy `weechat` relay report for a buffer's name fields?
 *
 * The app's resume rules compare against buffer names, and the legacy path builds
 * `BufferData.shortName` / `.plugin` straight from the hdata row it requests at
 * `legacyConnection.ts` (`local_variables,notify,number,full_name,short_name,title,
 * hidden,type`). This probe asks for exactly those keys and prints what WeeChat
 * actually sends, so a rule written as `shortName === "core"` can be checked
 * against the wire instead of against the name it looks like it should have.
 *
 * Needs gbtest running (`npm run wc5:start` is not required; the legacy relay is
 * the one on 9001):  node src-svelte/test/fixtures/api-dossier/probes/probe-legacy-buffer-fields.mjs
 *
 * The reply is a binary hdata frame, so it is decoded by the app's own parser
 * rather than a second implementation that could disagree with the client.
 */
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Protocol } from '#lib/weechat.ts';

const URL_LEGACY = process.env.GB_LEGACY_URL ?? 'ws://localhost:9001/weechat';
const PASSWORD = process.env.GB_PASSWORD ?? 'testpassword123';
const KEYS = ['local_variables,notify,number,full_name,short_name,title,hidden,type'];

const toHex = (bytes) => Buffer.from(bytes).toString('hex');
const fromHex = (hex) => new Uint8Array(Buffer.from(hex, 'hex'));

const ws = new WebSocket(URL_LEGACY);
ws.binaryType = 'arraybuffer';
const parser = new Protocol();
const capture = { url: URL_LEGACY, capturedAt: new Date().toISOString(), handshake: null, buffers: [] };

await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error(`cannot reach ${URL_LEGACY}; is gbtest running?`));
});

ws.send(Protocol.formatHandshake({
    password_hash_algo: 'pbkdf2+sha512:pbkdf2+sha256:sha512:sha256:plain',
    compression: 'off',
}));

const handshake = await new Promise((resolve) => {
    ws.onmessage = async (event) => {
        const message = await parser.parse(event.data);
        resolve(message.objects?.[0]?.content ?? {});
    };
});

const algo = String(handshake.password_hash_algo ?? '');
const iterations = Number(handshake.password_hash_iterations ?? 0);
const serverNonce = fromHex(String(handshake.nonce ?? ''));
capture.handshake = { password_hash_algo: algo, password_hash_iterations: iterations, nonceBytes: serverNonce.length };
if (!algo.startsWith('pbkdf2+') || serverNonce.length === 0) {
    throw new Error(`unexpected auth negotiation: ${JSON.stringify(capture.handshake)}`);
}

// Same construction as `initializePBKDF2`: salt = server nonce + ':' + client nonce.
const clientNonce = new Uint8Array(randomBytes(16));
const salt = new Uint8Array([...serverNonce, 0x3a, ...clientNonce]);
const label = algo.split('+')[1];
const hash = pbkdf2Sync(PASSWORD, Buffer.from(salt), iterations, 32, label);
ws.send(Protocol.formatInit(`${algo}:${toHex(salt)}:${iterations}:${toHex(hash)}`, null));

await new Promise((resolve) => setTimeout(resolve, 400));
ws.send(Protocol.formatHdata({ id: 1, path: 'buffer:gui_buffers(*)', keys: KEYS }));

const done = new Promise((resolve) => {
    ws.onmessage = async (event) => {
        const message = await parser.parse(event.data);
        for (const object of message.objects ?? []) {
            const rows = Array.isArray(object.content) ? object.content : [];
            for (const row of rows) {
                if (typeof row?.full_name === 'string') {
                    capture.buffers.push({
                        full_name: row.full_name,
                        short_name: row.short_name,
                        plugin: row.local_variables?.plugin ?? null,
                        number: row.number,
                    });
                }
            }
        }
        if (capture.buffers.length > 0) resolve();
    };
    setTimeout(resolve, 6000);
});
await done;
ws.close();

if (capture.buffers.length === 0) throw new Error('no buffers in the reply — auth or hdata failed');

const out = fileURLToPath(new URL('../raw/legacy-buffer-fields.json', import.meta.url));
writeFileSync(out, JSON.stringify(capture, null, 2) + '\n');

for (const buffer of capture.buffers) {
    console.log(
        `${buffer.full_name.padEnd(28)} short_name=${JSON.stringify(buffer.short_name)}` +
        ` plugin=${JSON.stringify(buffer.plugin)} number=${buffer.number}` +
        ` | shortName==="core" && plugin==="weechat" ? ${buffer.short_name === 'core' && buffer.plugin === 'weechat'}` +
        ` | fullName==="core.weechat" ? ${buffer.full_name === 'core.weechat'}`
    );
}
console.log(`\ncaptured -> ${out}`);
process.exit(0);
