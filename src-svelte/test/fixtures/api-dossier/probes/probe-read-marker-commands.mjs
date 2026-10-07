#!/usr/bin/env node
/**
 * Read-marker command probe: what each `/buffer set unread` form leaves behind on
 * the relay, because `last_read_line_id = -1` means two different things and only
 * one of them is visible without `first_line_not_read`.
 *
 * Measured 2026-10-07 against WeeChat 4.10.1 / API 0.6.0 (gbtest, port 9010) and
 * WeeChat 5.0.0-dev / API 0.7.0 (built from upstream main, port 9011):
 *
 *   command                        4.10.1 last_read_line_id   5.0 last_read_line_id   first_line_not_read
 *   /buffer set unread -100000     -1                         -1                      true
 *   /buffer set unread             a real id                  a real id               false
 *   /buffer set unread 0           -1                         -1                      false
 *
 * So on 5.0 the same -1 is reported for "marker sits before the first line" and for
 * "marker removed because everything is read", and `first_line_not_read` is the only
 * thing that tells them apart. On 4.10.1 the field is absent from the buffers
 * response entirely, so -1 there is permanently ambiguous.
 *
 * `-100000` is used rather than a small N so the marker is pushed past the first line
 * whatever the buffer holds: a small N lands on a real line id in a long buffer and
 * reports -1/true in a short one, which reads as the probe changing its mind.
 *
 * This mutates the fixture's read marker on the channel buffer. It does not check
 * the hotlist, per-buffer notify levels, or what any client renders from these
 * values — only what the relay reports for the buffer afterwards.
 *
 * Usage: node probe-read-marker-commands.mjs [port] [buffer-name-substring]
 * Auth mirrors the gbtest fixture: relay.network.password testpassword123 with
 * password_hash_algo pbkdf2+sha256.
 */
import crypto from 'node:crypto';

const PORT = Number(process.argv[2] ?? 9010);
const NAME_MATCH = process.argv[3] ?? '#glowing-bear';
const PASSWORD = 'testpassword123';

function authHeader() {
    const ts = Math.floor(Date.now() / 1000);
    const iters = 100000;
    const hash = crypto.pbkdf2Sync(PASSWORD, String(ts), iters, 32, 'sha256').toString('hex');
    return 'Basic ' + Buffer.from(`hash:pbkdf2+sha256:${ts}:${iters}:${hash}`).toString('base64');
}

const headers = { Authorization: authHeader() };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function json(path) {
    const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { headers });
    if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
    return res.json();
}

async function sendCommand(bufferId, command) {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/input`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ command, buffer_id: bufferId }),
    });
    return res.status;
}

async function bufferState(bufferId) {
    const buffers = await json('/api/buffers?columns=id,name,last_read_line_id,first_line_not_read');
    return (Array.isArray(buffers) ? buffers : []).find((entry) => entry.id === bufferId);
}

function fail(why) {
    console.error(`PROBE FAILED: ${why}`);
    process.exit(1);
}

const buffers = await json('/api/buffers?columns=id,name');
const buffer = (Array.isArray(buffers) ? buffers : []).find((entry) => String(entry.name).includes(NAME_MATCH));
if (!buffer) fail(`no buffer matching ${NAME_MATCH} on port ${PORT}`);

console.log(`port ${PORT} · buffer ${buffer.id} ${buffer.name}`);
for (const command of ['/buffer set unread -100000', '/buffer set unread', '/buffer set unread 0']) {
    const status = await sendCommand(buffer.id, command);
    if (status !== 204) fail(`${command} → ${status}, expected 204`);
    // Commands are accepted for later execution; give the command loop time to run.
    await wait(700);
    const state = await bufferState(buffer.id);
    if (!state) fail(`buffer ${buffer.id} disappeared`);
    console.log(
        `  ${command.padEnd(24)} last_read_line_id=${String(state.last_read_line_id).padEnd(18)}` +
        ` first_line_not_read=${JSON.stringify(state.first_line_not_read)}`,
    );
}
