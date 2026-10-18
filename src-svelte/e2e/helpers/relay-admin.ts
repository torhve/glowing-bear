import { pbkdf2Sync } from 'node:crypto';
import { readdirSync, writeFileSync } from 'node:fs';

// Shared access to the gbtest relay's own state, for specs that have to assert or
// repair the *server* rather than the app.
//
// Two measured facts shape this helper (WeeChat 4.10.1 / relay API 0.6.0 on the
// gbtest fixture, 2026-10-07):
//
//   - `POST /api/input` answers 204 and the command runs in that buffer's context.
//     Sent to a core buffer it is refused — the buffer then shows "You cannot write
//     text in this buffer". Sent to a channel or a script buffer, `hotlist clear`
//     removed a `relay.relay.list` entry but left the channel's own entry behind
//     across repeated attempts.
//   - The same `hotlist clear` written to WeeChat's FIFO (the channel gbtest's own
//     start script uses) empties the hotlist and it stays empty.
//
// So commands that must take effect globally go through the FIFO; the API is used
// for reading, and for a command that is only valid on one kind of buffer it is used
// with that buffer named explicitly (`relayInputOnBuffer`).

const API_PORT = 9010;
const WEECHAT_HOME = '/tmp/gbtest-weechat';
const PASSWORD = 'testpassword123';
const ITERATIONS = 100000;

function authHeader(): string {
    const timestamp = Math.floor(Date.now() / 1000);
    const hash = pbkdf2Sync(PASSWORD, String(timestamp), ITERATIONS, 32, 'sha256').toString('hex');
    return 'Basic ' + Buffer.from(`hash:pbkdf2+sha256:${timestamp}:${ITERATIONS}:${hash}`).toString('base64');
}

async function relayJson(path: string): Promise<unknown> {
    const response = await fetch(`http://127.0.0.1:${API_PORT}${path}`, {
        headers: { Authorization: authHeader() },
    });
    if (!response.ok) throw new Error(`relay ${path} → ${response.status}`);
    return response.json();
}

/**
 * Run one command in one buffer's context through `POST /api/input`.
 *
 * Why a spec needs this: WeeChat refuses commands outside a matching buffer, and
 * both other routes to the fixture execute in the core buffer — the FIFO always,
 * and the app's own `sendWeeChatCommand` deliberately when no buffer is given. So
 * `/join`, which is only valid on an irc buffer, can only be issued here, with a
 * channel the fixture already has named as its target. 204 means accepted, not
 * executed; the spec proves the effect by waiting for the buffer to appear.
 */
export async function relayInputOnBuffer(bufferName: string, command: string): Promise<void> {
    const response = await fetch(`http://127.0.0.1:${API_PORT}/api/input`, {
        method: 'POST',
        headers: { Authorization: authHeader(), 'content-type': 'application/json' },
        body: JSON.stringify({ buffer_name: bufferName, command }),
    });
    if (response.status !== 204 && response.status !== 200) {
        throw new Error(
            `relay input on ${bufferName} (${command}) → ${response.status}: ${await response.text()}`,
        );
    }
}

/** The fixture WeeChat's FIFO, or null when no instance is running. */
function fixtureFifo(): string | null {
    let entries: string[];
    try {
        entries = readdirSync(WEECHAT_HOME);
    } catch {
        return null;
    }
    return entries.find((entry) => entry.startsWith('weechat_fifo_')) ?? null;
}

/** Run a command on the fixture WeeChat through its FIFO (global context). */
export function fixtureCommand(command: string): void {
    const fifo = fixtureFifo();
    if (!fifo) {
        throw new Error(`no gbtest WeeChat FIFO under ${WEECHAT_HOME} — is the fixture running?`);
    }
    writeFileSync(`${WEECHAT_HOME}/${fifo}`, `core.weechat */${command}\n`);
}

export async function relayHotlist(): Promise<Array<Record<string, unknown>>> {
    const hotlist = await relayJson('/api/hotlist?columns=buffer_id,count,priority') as unknown;
    return Array.isArray(hotlist) ? hotlist as Array<Record<string, unknown>> : [];
}

/**
 * Drop every server-side hotlist entry and prove it worked.
 *
 * Why a spec would call this: the favicon badge counts *global* notifications, and a
 * hotlist entry the app cannot absorb — a buffer that is no longer in its buffer list,
 * or a channel left unread by an earlier spec — keeps that count above zero for the
 * whole session. A spec that then asserts "no badge" is asserting against another
 * run's leftovers. Clearing server-side first, and failing loudly when the clear did
 * not take, makes the baseline something the spec created rather than inherited.
 *
 * It re-clears rather than clearing once: a line still in flight from the mock IRC
 * server can land after the clear and legitimately re-open an entry, and one unlucky
 * poll would report that as "the hotlist would not clear".
 */
export async function clearServerHotlist(): Promise<void> {
    const attempts = 4;
    let remaining: Array<Record<string, unknown>> = [];
    for (let attempt = 0; attempt < attempts; attempt++) {
        fixtureCommand('hotlist clear');
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline) {
            remaining = await relayHotlist();
            if (remaining.length === 0) return;
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
    }
    throw new Error(
        `hotlist did not clear on the fixture relay after ${attempts} attempts; leftovers: ${JSON.stringify(remaining)}`,
    );
}
