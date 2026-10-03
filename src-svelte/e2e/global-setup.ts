import net from 'net';
import { execFile } from 'child_process';
import { fileURLToPath } from 'node:url';
import path from 'path';
import fs from 'fs';
import type { FullConfig } from '@playwright/test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RELAY_PORT = 9001;
const IRC_PORT = 6667;
const CONTROL_PORT = 16667;

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

/* Verify all gbtest ports are live. Returns true if all healthy. */
async function verifyGbtest(): Promise<boolean> {
    const [relay, irc, control] = await Promise.all([
        checkPort(RELAY_PORT),
        checkPort(IRC_PORT),
        checkPort(CONTROL_PORT),
    ]);
    return relay && irc && control;
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
        await waitForPort(RELAY_PORT, 'WeeChat relay');
    }

    // Start every run from a small, deterministic channel history
    pruneTestChannelHistory();

    console.log('[global-setup] gbtest environment ready');
}
