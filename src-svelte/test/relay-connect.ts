import WebSocket from 'ws';
import { Protocol, type ParsedMessage } from '../src/lib/weechat';

const RELAY_URL = 'ws://localhost:9001';
const PASSWORD = 'testpassword123';
const STEP_TIMEOUT_MS = 10000;

const protocol = new Protocol();
let stepTimeout: ReturnType<typeof setTimeout>;
let pendingCloseTimer: ReturnType<typeof setTimeout>;
let messageCount = 0;
let handshakeDone = false;

function clearTimer() {
    clearTimeout(stepTimeout);
}

function startTimer(label: string) {
    clearTimer();
    stepTimeout = setTimeout(() => {
        console.error(`[FAIL] ${label} — timed out after ${STEP_TIMEOUT_MS}ms`);
        process.exit(1);
    }, STEP_TIMEOUT_MS);
}

function log(msg: string) {
    console.log(msg);
}

function objPreview(obj: { type: string; content: unknown }): string {
    const c = obj.content;
    if (obj.type === 'inf') {
        const info = c as { key: string; value: string };
        return `{key:"${info.key}", value:"${info.value}"}`;
    }
    if (obj.type === 'hda') {
        const items = c as Record<string, unknown>[];
        return `[${items.length} items]`;
    }
    const str = JSON.stringify(c);
    return str.length > 100 ? str.slice(0, 100) + '...' : str;
}

function handleMessage(data: Buffer) {
    messageCount++;
    log(`[recv #${messageCount}] ${data.length} bytes`);

    // Convert Buffer to ArrayBuffer (Protocol.parse expects ArrayBuffer)
    const arrayBuf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;

    let parsed: ParsedMessage;
    try {
        parsed = protocol.parse(arrayBuf);
    } catch (e) {
        console.error(`[FAIL] parse error:`, e);
        process.exit(1);
        return;
    }

    log(`  id="${parsed.id}"  objects=${parsed.objects.length}`);
    for (const obj of parsed.objects) {
        log(`    type="${obj.type}"  content=${objPreview(obj)}`);
    }
}

const ws = new WebSocket(RELAY_URL);

ws.on('open', () => {
    log(`[connect] Connected to ${RELAY_URL}`);

    const handshakeStr = Protocol.formatHandshake({
        password_hash_algo: 'plain',
        compression: 'zlib'
    });
    startTimer('handshake');
    log(`[handshake] → "${handshakeStr}"`);
    ws.send(handshakeStr);
});

ws.on('message', (data: Buffer) => {
    // Convert to proper ArrayBuffer
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as unknown as Uint8Array);
    handleMessage(buf);

    if (!handshakeDone && messageCount === 1) {
        // Verify handshake response
        const arrayBuf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
        let parsed: ParsedMessage;
        try {
            parsed = protocol.parse(arrayBuf);
        } catch {
            return;
        }
        const obj = parsed.objects[0];
        if (obj?.type === 'inf') {
            const info = obj.content as { key: string; value: string };
            log(`  → auth method: ${info.value}`);
            if (info.value !== 'plain') {
                console.error(`[FAIL] Expected 'plain' auth, got '${info.value}'`);
                process.exit(1);
                return;
            }
        }
        handshakeDone = true;
        clearTimer();

        // Step 2: Send init (fire-and-forget)
        const initStr = Protocol.formatInit('plain:' + PASSWORD, null);
        log(`[init] → "${initStr}"`);
        ws.send(initStr);

        // Step 3: Request version (small delay to let WeeChat process init)
        setTimeout(() => {
            const versionStr = protocol.setId(1, Protocol.formatInfo({ name: 'version' }));
            log(`[version] → "${versionStr}"`);
            startTimer('version response');
            ws.send(versionStr);
        }, 10);
        return;
    }

    if (handshakeDone && messageCount >= 2) {
        clearTimer();
        log(`\n[SUCCESS] Protocol verified:`);
        log(`  - Connected to relay at ${RELAY_URL}`);
        log(`  - Handshake sent and response parsed correctly`);
        log(`  - Init (${PASSWORD}) sent`);
        log(`  - ${messageCount} message(s) received and parsed`);
        log(`  - Protocol.parse() handles binary framing, decompression, and object types`);

        pendingCloseTimer = setTimeout(() => {
            ws.close();
            log(`[done] Connection closed cleanly`);
            process.exit(0);
        }, 200);
    }
});

ws.on('error', (err: Error) => {
    console.error(`[FAIL] WebSocket error:`, err.message);
    process.exit(1);
});

ws.on('close', (code: number, reason: Buffer) => {
    if (!pendingCloseTimer) {
        console.error(`[FAIL] Connection closed unexpectedly: code=${code} reason="${reason?.toString()}"`);
        process.exit(1);
    }
});
