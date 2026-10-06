import net from 'net';

const CONTROL_PORT = 16667;
const CONTROL_HOST = 'localhost';

interface ControlResponse {
  success?: boolean;
  error?: string;
  [key: string]: unknown;
}

function sendCommand(data: Record<string, unknown>): Promise<ControlResponse> {
    return new Promise((resolve, reject) => {
        const client = new net.Socket();
        const timeout = setTimeout(() => {
            client.destroy();
            reject(new Error('Control API timeout'));
        }, 5000);
        client.connect(CONTROL_PORT, CONTROL_HOST, () => {
            client.end(JSON.stringify(data) + '\n');
        });
        let buf = '';
        client.on('data', (chunk) => { buf += chunk.toString(); });
        client.on('end', () => {
            clearTimeout(timeout);
            try { resolve(JSON.parse(buf)); }
            catch { reject(new Error('Invalid response: ' + buf)); }
        });
        client.on('error', (err) => { clearTimeout(timeout); reject(err); });
    });
}

export const irc = {
    sendMessage: (channel: string, text: string) =>
        sendCommand({ cmd: 'send_message', channel, text }),

    sendNotice: (channel: string, text: string) =>
        sendCommand({ cmd: 'send_notice', channel, text }),

    sendColored: (channel: string, text: string, fg?: string, bg?: string) =>
        sendCommand({ cmd: 'colored_message', channel, text, fg, bg }),

    botJoin: (channel: string) =>
        sendCommand({ cmd: 'join', channel }),

    botPart: (channel: string) =>
        sendCommand({ cmd: 'part', channel }),

    botQuit: () =>
        sendCommand({ cmd: 'quit' }),

    botNick: (nickname: string) =>
        sendCommand({ cmd: 'nick', nickname }),

    setTopic: (channel: string, text: string) =>
        sendCommand({ cmd: 'topic', channel, text }),

    raw: (raw: string) =>
        sendCommand({ cmd: 'raw', raw }),

    waitForChannel: (channel: string) =>
        sendCommand({ cmd: 'wait_for_channel', channel }),

    sendPm: (nick: string, text: string) =>
        sendCommand({ cmd: 'send_pm', nick, text }),
};

/**
 * Send a sequence of channel messages over ONE control connection.
 *
 * Each command is still sent and acknowledged one at a time, so the pacing the
 * app sees is unchanged; only the socket churn goes away. A 2000-message flood
 * sent as 2000 separate connections ran the host out of ephemeral ports partway
 * through a benchmark batch (ECONNREFUSED / EADDRNOTAVAIL on the control port),
 * which read as a failed experiment rather than as a harness defect.
 */
export function sendSequence(channel: string, texts: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
        const client = new net.Socket();
        const timeout = setTimeout(() => {
            client.destroy();
            reject(new Error('Control sequence timeout'));
        }, 120000);
        let sent = 0;
        let buf = '';

        const queueNext = () => {
            if (sent >= texts.length) {
                clearTimeout(timeout);
                client.end();
                resolve();
                return;
            }
            client.write(JSON.stringify({
                cmd: 'send_message', channel, text: texts[sent], more: true,
            }) + '\n');
        };

        client.connect(CONTROL_PORT, CONTROL_HOST, queueNext);
        client.on('data', (chunk) => {
            buf += chunk.toString();
            let nl: number;
            while ((nl = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, nl).trim();
                buf = buf.slice(nl + 1);
                if (!line) continue;
                let parsed: ControlResponse;
                try { parsed = JSON.parse(line); }
                catch {
                    clearTimeout(timeout); client.destroy();
                    reject(new Error('Invalid response: ' + line)); return;
                }
                if (parsed.success === false || parsed.error) {
                    clearTimeout(timeout); client.destroy();
                    reject(new Error(String(parsed.error ?? 'control command failed'))); return;
                }
                sent++;
                queueNext();
            }
        });
        client.on('error', (err) => { clearTimeout(timeout); reject(err); });
    });
}
