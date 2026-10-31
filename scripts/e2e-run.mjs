/**
 * Run the full E2E suite against one dev server.
 *
 * `npm run test:e2e` used to invoke Playwright twice, and Playwright starts and stops the
 * dev server it launches itself — so every run paid two cold `vite dev` starts, each one
 * behind `predev` (dependency guard + icon generation). Starting the server here and
 * leaving it up means the second pass reuses it through `webServer.reuseExistingServer`.
 *
 * The two passes stay separate invocations on purpose. The serial `chromium` project owns
 * the shared gbtest channel and must run alone; `chromium-ui` never touches it and can run
 * several files at once.
 *
 * Usage: `node scripts/e2e-run.mjs [--serial-only] [--ui-only] [--workers=N]`
 */
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = 'src-svelte/e2e/playwright.config.ts';
const APP_URL = process.env.GB_APP_URL ?? 'http://localhost:8001/';

/** Specs that never touch the shared channel, and therefore run concurrently. */
// 4 is the measured ceiling for this lane: every connected page pays its own connect
// round-trip, so 6 workers gave the same wall. Repeating the lane (--repeat-each) checks the
// isolation rule in playwright.config.ts, not machine load.
const UI_WORKERS = Number(process.env.GB_E2E_UI_WORKERS ?? 4);

function arg(name) {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : undefined;
}

const serialOnly = process.argv.includes('--serial-only');
const uiOnly = process.argv.includes('--ui-only');
const workersArg = arg('workers');
const uiWorkers = workersArg ? Number(workersArg) : UI_WORKERS;

/** Start `npm run dev` in its own process group so the whole tree can be stopped at once. */
function startDevServer() {
    const child = spawn('npm', ['run', 'dev'], {
        cwd: ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
        env: { ...process.env },
    });
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
    // `subprocess.exited` is not present here (verified on this Node), so the exit
    // event is turned into the promise the cleanup waits on.
    child.exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
    return child;
}

/** True when something already answers at the app URL — a developer's own dev server. */
async function serverIsUp() {
    try {
        const res = await fetch(APP_URL, { signal: AbortSignal.timeout(2000) });
        return res.ok || res.status === 304;
    } catch {
        return false;
    }
}

/** Wait for the server we started to answer, so Playwright reuses it instead of starting its own. */
async function waitForDevServer(maxMs = 120_000) {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
        if (await serverIsUp()) return;
        await delay(250);
    }
    throw new Error(`dev server did not answer at ${APP_URL} within ${maxMs / 1000}s`);
}

/**
 * Stop only the server this script started, and wait for it to actually go.
 *
 * A detached child is its own process group, so `vite` and whatever `predev` left behind are
 * both reached by the group signal. SIGKILL follows if SIGTERM is ignored — a dev server that
 * outlives the run would hold port 8001 and be reused by the next run.
 */
async function stopDevServer(child) {
    if (!child || child.exitCode !== null) return;
    const kill = (signal) => {
        try {
            process.kill(-child.pid, signal);
        } catch {
            child.kill(signal);
        }
    };
    kill('SIGTERM');
    const gone = await Promise.race([
        child.exited.then(() => true),
        delay(5000).then(() => false),
    ]);
    if (!gone) kill('SIGKILL');
}

/** One Playwright pass; returns its exit code and keeps its output on the terminal. */
function runPass(project, extraArgs, env) {
    return new Promise((resolve) => {
        const child = spawn('npx', ['playwright', 'test', '--config', CONFIG, '--project', project, ...extraArgs], {
            cwd: ROOT,
            stdio: 'inherit',
            env: { ...process.env, ...env },
        });
        child.on('close', (code) => resolve(code ?? 1));
    });
}

// A developer's own `npm run dev` is reused rather than competed with: this script only
// starts a server when nothing answers at the app URL, and only stops the one it started.
const alreadyRunning = await serverIsUp();
const devServer = alreadyRunning ? null : startDevServer();
let failure = 0;
try {
    if (!alreadyRunning) await waitForDevServer();
    if (!uiOnly) {
        failure = await runPass('chromium', [], {});
    }
    if (!serialOnly && failure === 0) {
        failure = await runPass('chromium-ui', ['--workers', String(uiWorkers)], {
            E2E_HTML_REPORT: '../../playwright-report-ui',
        });
    }
} finally {
    if (!alreadyRunning) await stopDevServer(devServer);
}

process.exit(failure);
