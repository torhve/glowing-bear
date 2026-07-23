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
