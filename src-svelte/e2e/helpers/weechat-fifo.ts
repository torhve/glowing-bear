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
            fs.writeFileSync(fifoPath, `core.weechat */${command}\n`);
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
