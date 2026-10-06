import fs from 'node:fs';
import path from 'node:path';

/**
 * FIFO command channel to the gbtest WeeChat instance — the same channel
 * test/fixtures/gbtest/start.sh uses (the core.weechat target prefix
 * followed by the command). WeeChat keeps its FIFO open for reading, so a
 * synchronous write is delivered immediately.
 */
const WEECHAT_HOME = '/tmp/gbtest-weechat';

/**
 * Send a raw WeeChat command (without the leading /) to the gbtest instance.
 * Returns false when no live FIFO is found (gbtest not running under the
 * expected home directory).
 */
export function weechatFifoCommand(command: string): boolean {
    return writeFifo(`core.weechat */${command}\n`);
}

/**
 * Send a FIFO command and, in the same write, a `print -buffer core.weechat <token>`
 * that lands in the core buffer the client renders. WeeChat drains the FIFO in order,
 * so the token appearing on screen is proof the command itself has already been
 * processed — the honest replacement for a "give WeeChat time" sleep. (`/echo` is not
 * usable here: its output never reaches the core buffer over the FIFO.) Returns the
 * token, or null when no live FIFO was found.
 */
export function weechatFifoCommandAcked(command: string): string | null {
    const token = `GBFIFO-ACK-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return writeFifo(`core.weechat */${command}\ncore.weechat */print -buffer core.weechat ${token}\n`) ? token : null;
}

function writeFifo(payload: string): boolean {
    let entries: string[];
    try {
        entries = fs.readdirSync(WEECHAT_HOME);
    } catch {
        return false;
    }
    for (const entry of entries) {
        if (!entry.startsWith('weechat_fifo_')) continue;
        const fifoPath = path.join(WEECHAT_HOME, entry);
        try {
            // Only real FIFOs are command channels; stale regular files
            // (leftovers of dead instances) silently swallow writes.
            if (!fs.statSync(fifoPath).isFIFO()) continue;
            fs.writeFileSync(fifoPath, payload);
            return true;
        } catch {
            // Unreadable/unwritable FIFO entry — try the next one.
        }
    }
    return false;
}

/**
 * Add/remove a smart filter scoped to the gbtest channel. The tags column is a
 * match condition ("*" = any line); matched lines stay in the buffer with
 * displayed:false, which the client gates via isServerHiddenLine.
 */
export const weechatFilter = {
    add: (name: string, condition: string) =>
        weechatFifoCommand(`filter add ${name} irc.gbtest.#glowing-bear * ${condition}`),
    remove: (name: string) => weechatFifoCommand(`filter del ${name}`),
};
