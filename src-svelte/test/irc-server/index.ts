import { spawn } from 'child_process';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { IRCServer } from './IRCServer';

function parseIntArg(name: string, defaultVal: number): number {
    for (const arg of process.argv) {
        if (arg.startsWith(`--${name}=`)) {
            const val = parseInt(arg.split('=')[1], 10);
            if (!isNaN(val)) return val;
        }
    }
    return defaultVal;
}

function getArg(name: string, defaultVal: string): string {
    const prefix = `--${name}=`;
    for (const arg of process.argv) {
        if (arg.startsWith(prefix)) return arg.slice(prefix.length);
    }
    return defaultVal;
}

/* ─── Daemon mode ─────────────────────────────────────────────────── */

if (process.argv.includes('--daemon')) {
    const pidFile = getArg('pidfile', '/tmp/gbtest-irc.pid');
    const args = process.argv.slice(2).filter(a => a !== '--daemon' && !a.startsWith('--daemon'));
    const child = spawn(
        process.execPath,
        [...process.execArgv, process.argv[1] ?? '', ...args],
        { detached: true, stdio: 'ignore' },
    );
    child.unref();
    writeFileSync(pidFile, String(child.pid));
    console.error(`Daemon PID: ${child.pid}`);
    process.exit(0);
}

/* ─── Foreground server ───────────────────────────────────────────── */

const ircPort = parseIntArg('port', 6667);
const controlPort = parseIntArg('control-port', 16667);
const pidFile = getArg('pidfile', '/tmp/gbtest-irc.pid');

const server = new IRCServer({ ircPort, controlPort });
server.start();

function cleanup(): void {
    process.stdout.write('\nShutting down...\n');
    server.stop();
    if (existsSync(pidFile)) unlinkSync(pidFile);
}

process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);

process.stdout.write(`Test IRC Server ready (PID ${process.pid})\n`);
