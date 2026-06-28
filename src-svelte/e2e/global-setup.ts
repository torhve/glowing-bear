import net from 'net';
import { execFile } from 'child_process';
import { fileURLToPath } from 'node:url';
import path from 'path';
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

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- required by Playwright's globalSetup signature
export default async function globalSetup(_config: FullConfig) {
  // Check if gbtest environment is already running
  if (await verifyGbtest()) {
    console.log('[global-setup] gbtest environment already running — skipping start');
    return;
  }

  console.log('[global-setup] gbtest environment not detected, starting...');
  const startScript = path.join(__dirname, '..', '..', '..', 'test', 'fixtures', 'gbtest', 'start.sh');

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

  console.log('[global-setup] gbtest environment ready');
}
