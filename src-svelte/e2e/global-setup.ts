import net from 'net';
import { execFile } from 'child_process';
import { pbkdf2Sync } from 'crypto';
import { fileURLToPath } from 'node:url';
import path from 'path';
import fs from 'fs';
import type { FullConfig } from '@playwright/test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_RELAY_PORT = 9010;
// Second, version-pinned relay (WeeChat 5). Optional — see startWeechat5Fixture.
const WEECHAT5_PORT = 9011;
const IRC_PORT = 6667;
const CONTROL_PORT = 16667;
const GBTEST_PASSWORD = 'testpassword123';

/* Check if a TCP port is accepting connections. */
function checkPort(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const sock = new net.Socket();
        sock.setTimeout(2000);
        sock.once('error', () => resolve(false));
        sock.once('connect', () => { sock.destroy(); resolve(true); });
        sock.connect(port, '127.0.0.1');
    });
}

/* Wait for port to become available, polling up to maxAttempts times. */
async function waitForPort(port: number, label: string, maxAttempts = 30): Promise<void> {
    for (let i = 0; i < maxAttempts; i++) {
        if (await checkPort(port)) return;
        await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`${label} on port ${port} did not become available after ${maxAttempts}s`);
}

/* Authenticated probe: proves the JSON API relay is live AND that this is our
 * fixture (the password matches). A bare open port is not enough. Uses the
 * API hash scheme: hash:pbkdf2+sha256:<timestamp>:<iterations>:<hex>, where
 * the PBKDF2 salt is the decimal timestamp string (must be within
 * relay.network.time_window seconds of server time) and key length is 32. */
async function probeApiRelay(): Promise<boolean> {
    try {
        const ts = Math.floor(Date.now() / 1000);
        const iterations = 100000;
        const hash = pbkdf2Sync(GBTEST_PASSWORD, String(ts), iterations, 32, 'sha256').toString('hex');
        const cred = Buffer.from(`hash:pbkdf2+sha256:${ts}:${iterations}:${hash}`).toString('base64');
        const res = await fetch(`http://127.0.0.1:${API_RELAY_PORT}/api/version`, {
            headers: { Authorization: 'Basic ' + cred },
            signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) return false;
        const body = await res.json() as { relay_api_version?: string };
        return typeof body.relay_api_version === 'string';
    } catch {
        return false;
    }
}

/* Verify all gbtest ports are live and the API relay authenticates. Returns true if all healthy. */
async function verifyGbtest(): Promise<boolean> {
    const [api, irc, control] = await Promise.all([
        probeApiRelay(),
        checkPort(IRC_PORT),
        checkPort(CONTROL_PORT),
    ]);
    return api && irc && control;
}


/** WeeChat home used by the gbtest environment. */
const WEECHAT_HOME = '/tmp/gbtest-weechat';

/** Best-effort prune of accumulated line history in the gbtest test channels.
 * The persistent WeeChat instance retains up to 4096 lines per buffer and scroll
 * tests render the whole buffer, so unpruned history makes every subsequent run
 * slower. Writes /prune commands to WeeChat's fifo; no-ops if it is unavailable.
 */
function pruneTestChannelHistory(): void {
    let fifo: string | null = null;
    try {
        const name = fs.readdirSync(WEECHAT_HOME).find((n) => n.startsWith('weechat_fifo_'));
        if (name) fifo = path.join(WEECHAT_HOME, name);
    } catch {
        return; // WEECHAT_HOME not readable — nothing to prune
    }
    if (!fifo) return;
    try {
        fs.writeFileSync(fifo, 'prune irc.gbtest.#glowing-bear\nprune irc.gbtest.#other-channel\n');
    } catch {
        // non-fatal: tests run fine without pruning, just slower
    }
}

/**
 * Optionally start the second, version-pinned relay (WeeChat 5 / newer relay API).
 *
 * gbtest alone only ever exercises the contract the app was written against, so a
 * relay-side change stays invisible to the suite until a user reports it.
 *
 * Three outcomes, deliberately different:
 *   no 5.x binary on this machine -> exit 2, log it, the specs skip;
 *   a 5.x binary exists but the relay will not start -> hard failure, because a
 *     broken fixture must not quietly become permanently missing coverage;
 *   GB_WEECHAT5=off -> skip on purpose, with no binary search at all.
 */
async function startWeechat5Fixture(): Promise<void> {
    if (process.env.GB_WEECHAT5 === 'off') {
        console.log('[global-setup] WeeChat 5 relay disabled by GB_WEECHAT5=off — newer-contract specs will skip');
        return;
    }
    const startScript = path.join(__dirname, '..', '..', 'test', 'fixtures', 'gbtest5', 'start.sh');
    const code = await new Promise<number>((resolve) => {
        execFile('bash', [startScript], { timeout: 120000 }, (error, _stdout, stderr) => {
            if (!error) { resolve(0); return; }
            // Exit 2 is how the script reports having no 5.x binary; anything
            // else is a real failure and its stderr is worth seeing.
            const status = (error as Error & { code?: number | string }).code;
            const numeric = typeof status === 'number' ? status : 1;
            if (numeric !== 2) {
                console.error('[global-setup] weechat5 fixture failed:', String(stderr || error.message).trim());
            }
            resolve(numeric);
        });
    });
    if (code === 0) {
        console.log('[global-setup] WeeChat 5 relay ready on ' + WEECHAT5_PORT + ' (newer-contract specs enabled)');
    } else if (code === 2) {
        console.log('[global-setup] no WeeChat 5 binary found — newer-contract specs will skip');
    } else {
        throw new Error(
            `[global-setup] a WeeChat 5 binary was found but the relay did not start (exit ${code}). `
            + 'Fix the fixture, or set GB_WEECHAT5=off to skip the newer-contract specs deliberately.',
        );
    }
}


export default async function globalSetup(_config: FullConfig) {
    // Check if gbtest environment is already running
    if (await verifyGbtest()) {
        console.log('[global-setup] gbtest environment already running — skipping start');
    } else {
        console.log('[global-setup] gbtest environment not detected, starting...');
        const startScript = path.join(__dirname, '..', '..', 'test', 'fixtures', 'gbtest', 'start.sh');

        await new Promise<void>((resolve, reject) => {
            execFile('bash', [startScript], { timeout: 120000 }, (error) => {
                if (error) {
                    reject(new Error(`gbtest start failed: ${error.message}`));
                } else {
                    resolve();
                }
            });
        });

        // Verify all ports came up after start script completed
        await waitForPort(IRC_PORT, 'IRC server');
        await waitForPort(CONTROL_PORT, 'Control API');
        await waitForPort(API_RELAY_PORT, 'API relay');
    }

    // Start every run from a small, deterministic channel history
    await startWeechat5Fixture();

    pruneTestChannelHistory();

    console.log('[global-setup] gbtest environment ready');
}
