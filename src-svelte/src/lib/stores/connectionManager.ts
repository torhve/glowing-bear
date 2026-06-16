import { get } from 'svelte/store';
import { setConnectionStatus, setErrors, clearErrors, disconnect as disconnectStore, connectionState } from '$lib/stores/connectionStore';
import { buffers, servers, activeBufferId, previousBufferId, wconfig, getBuffer, connected, setActiveBuffer } from '$lib/stores/models';
import { handleVersionInfo, handleConfValue, handleBufferInfo, handleHotlistInfo, handleLineInfo, handleMessage, handleNicklist } from '$lib/stores/handlers';
import { IDEAL_NICK_COLORS, IDEAL_COLOR_NICKS_IN_NICKLIST, shouldAutoApply } from '$lib/stores/nickColors';
import { Protocol } from '$lib/weechat';
import { DEBUG_NICKLIST, DEBUG_WEETCHAT_COMMANDS } from '$lib/debug';

// Protocol instance for instance methods (setId, parse)
// Static methods (formatHandshake, formatInit, etc.) are called on the constructor directly
const protocolInstance = new Protocol();

let ws: WebSocket | null = null;
let hotlistInterval: ReturnType<typeof setInterval> | null = null;
let connectionData: [string, number, string, string, boolean, boolean] | null = null;

export async function connect(host: string, port: number, path: string, password: string, tls: boolean, noCompression: boolean) {
    clearErrors();

    const isSecureContext = typeof window !== 'undefined' && window.isSecureContext;
    const proto = tls ? 'wss' : 'ws';

    // Handle IPv6
    let formattedHost = host;
    if (host.indexOf(":") !== -1 && host[0] !== "[" && host[host.length - 1] !== "]") {
        formattedHost = "[" + host + "]";
    }

    const url = `${proto}://${formattedHost}:${port}/${path}`;
    console.log('Connecting to:', url);

    // Close previous WebSocket connection if it exists
    if (ws) {
        ws.close();
        ws = null;
    }

    connectionData = [host, port, path, password, tls, noCompression];
    setConnectionStatus('connecting');

    return new Promise<void>((resolve, reject) => {
        ws = new WebSocket(url);
        ws.binaryType = 'arraybuffer';

        ws.onopen = async () => {
            try {
                // Reset callbacks for new connection
                Object.keys(callbacks).forEach(k => delete callbacks[parseInt(k, 10)]);
                currentCallbackId = 0;

                // Handshake
                const handshakeMsg = Protocol.formatHandshake({
                    password_hash_algo: (isSecureContext && tls) ? 'pbkdf2+sha512' : 'plain',
                    compression: noCompression ? 'off' : 'zlib'
                });

                const handshakeResponse = await sendAsync(handshakeMsg);
                const content = handshakeResponse.objects[0]?.content;

                const passwordMethod = content?.password_hash_algo;
                const nonce = hexStringToByte(content?.nonce || '');
                const iterations = content?.password_hash_iterations || 0;

                // Initialize connection
                if (passwordMethod === 'pbkdf2+sha512') {
                    await initializePBKDF2(password, nonce, iterations);
                } else if (passwordMethod === 'plain') {
                    const initMsg = Protocol.formatInit('plain:' + password, null);
                    // Fire-and-forget: WeeChat increments callback IDs so sendAsync would timeout
                    if (ws && ws.readyState === WebSocket.OPEN) {
                        sendWs(initMsg, 'init(plain)');
                    }
                    await new Promise(r => setTimeout(r, 5));
                }

                // Get version
                const versionMsg = Protocol.formatInfo({ name: 'version' });
                const versionResponse = await sendAsync(versionMsg);

                handleVersionInfo(versionResponse);

                 // Get buffer info
                const bufInfoMsg = Protocol.formatHdata({
                    path: 'buffer:gui_buffers(*)',
                    keys: ['local_variables,notify,number,full_name,short_name,title,hidden,type']
                });
                const bufInfoResponse = await sendAsync(bufInfoMsg);
                handleBufferInfo(bufInfoResponse);

                // Get hotlist
                const hotlistMsg = Protocol.formatHdata({
                    path: 'hotlist:gui_hotlist(*)',
                    keys: []
                });
                const hotlistResponse = await sendAsync(hotlistMsg);
                handleHotlistInfo(hotlistResponse);

                // Get config values
                await fetchConfValue('weechat.look.buffer_time_format');
                await fetchConfValue('weechat.completion.nick_completer');
                await fetchConfValue('weechat.completion.nick_add_space');

                // Auto-apply ideal nick colors if using WeeChat defaults
                autoApplyNickColors();

                // Request sync (fire-and-forget, like AngularJS code)
                const syncMsg = Protocol.formatSync({});
                if (ws && ws.readyState === WebSocket.OPEN) {
                    sendWs(syncMsg, 'sync');
                }

                // Mark connected after buffer info + line loading complete
                setConnectionStatus('connected');
                connected.set(true);
                console.log('[connect] connected=true, resolving promise');
                connectionState.update(current => ({ ...current, wasEverConnected: true }));

                // Start hotlist sync
                if (get(wconfig).hotlistsync) {
                    hotlistInterval = setInterval(async () => {
                        const hlMsg = Protocol.formatHdata({
                            path: 'hotlist:gui_hotlist(*)',
                            keys: []
                        });
                        const hlResp = await sendAsync(hlMsg);
                        handleHotlistInfo(hlResp);
                    }, 60000);
                }

                resolve();
            } catch (e) {
                console.error('Connection error:', e);
                reject(e);
            }
        };

       ws.onmessage = (event) => {
            if (event.data instanceof ArrayBuffer) {
                onMessage(event.data);
            }
        };

        ws.onclose = () => {
            console.log('Disconnected from relay');
            setConnectionStatus('disconnected');
            connected.set(false);

            if (get(connectionState).userDisconnect) {
                // User initiated disconnect, don't auto-reconnect
            } else if (typeof document !== 'undefined' && !document.hasFocus()) {
                // First connection failed or user was not focused
            } else if (!get(connectionState).wasEverConnected) {
                // First connection failed, don't auto-reconnect
                setErrors({ passwordError: true });
            } else {
                scheduleReconnect();
            }
        };

        ws.onerror = (evt) => {
            console.error('Relay error:', evt);
            setConnectionStatus('error');
            setErrors({ errorMessage: true });
            reject(new Error('Connection failed'));
        };
    });
}

async function initializePBKDF2(password: string, nonce: Uint8Array, iterations: number) {
    const passwordArray = new TextEncoder().encode(password);
    const key = await crypto.subtle.importKey('raw', passwordArray, { name: 'PBKDF2' }, false, ['deriveBits']);

    const clientNonce = crypto.getRandomValues(new Uint8Array(16));
    const salt = concatenateTypedArrays(nonce, new Uint8Array([0x3A]), clientNonce);

    const hash = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', hash: 'SHA-512', salt, iterations },
        key,
        512
    );

    const hashHex = Array.from(new Uint8Array(hash))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
    const saltHex = Array.from(salt)
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');

    const initMsg = Protocol.formatInit(
        `pbkdf2+sha512:${saltHex}:${iterations}:${hashHex}`,
        null
    );
    // Fire-and-forget: WeeChat increments callback IDs so sendAsync would timeout
    if (ws && ws.readyState === WebSocket.OPEN) {
        sendWs(initMsg, 'init(pbkdf2)');
    }
    await new Promise(r => setTimeout(r, 5));
}

function scheduleReconnect() {
    if (!connectionData) return;

    const [host, port, path, password, tls, noCompression] = connectionData;

    setTimeout(() => {
        setConnectionStatus('reconnecting');
        // Clear buffers
        buffers.set({});
        servers.set({});

        connect(host, port, path, password, tls, noCompression).catch(() => {
            scheduleReconnect();
        });
    }, 3000);
}

function fetchConfValue(name: string) {
    const msg = Protocol.formatInfolist({
        name: 'option',
        pointer: 0,
        args: name
    });
    return sendAsync(msg).then(resp => {
        handleConfValue(resp);
    });
}

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- async callback pattern with complex WeeChat protocol response
    function sendAsync(message: string): Promise<any> {
    return new Promise((resolve, reject) => {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            reject(new Error('WebSocket not open'));
            return;
        }

        // Use the protocol's message ID system
        const cbId = getNextCallbackId();
        const messageWithId = protocolInstance.setId(cbId, message);
        console.debug('[connect] sendAsync id=' + cbId + ' msg=' + message.substring(0, 60));

        sendWs(messageWithId, 'async#' + cbId);

        // Store callback
        callbacks[cbId] = { resolve, reject };

        // Timeout after 10 seconds
        setTimeout(() => {
            if (callbacks[cbId]) {
                delete callbacks[cbId];
                console.error('[connect] timeout id=' + cbId);
                reject(new Error('Request timeout'));
            }
        }, 10000);
    });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic callback resolution/rejection types
const callbacks: Record<number, { resolve: (v: any) => void; reject: (e: any) => void }> = {};
let currentCallbackId = 0;
const pendingFetchBuffers = new Set<string>();

function getNextCallbackId(): number {
    currentCallbackId++;
    if (currentCallbackId > 1000) currentCallbackId = 0;
    return currentCallbackId;
}

function hexStringToByte(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
        bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
    }
    return bytes;
}

function concatenateTypedArrays(...arrays: Uint8Array[]): Uint8Array {
    const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const arr of arrays) {
        result.set(arr, offset);
        offset += arr.length;
    }
    return result;
}

// Central WebSocket send wrapper — logs all outbound WS messages
function sendWs(data: string | ArrayBufferLike, label = '') {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        console.warn('[WS] send skipped — not open');
        return;
    }
    if (DEBUG_WEETCHAT_COMMANDS && data instanceof ArrayBuffer) {
        const text = new TextDecoder().decode(data);
        console.log('[WeeChatCmd] SEND', label || '(raw):', text.substring(0, 200));
    } else if (DEBUG_WEETCHAT_COMMANDS && typeof data === 'string') {
        console.log('[WeeChatCmd] SEND', label || '(raw):', data.substring(0, 200));
    }
    ws.send(data);
}

// Handle incoming messages
export function onMessage(data: ArrayBuffer) {
    const message = protocolInstance.parse(data);

    if (message.id && callbacks[message.id]) {
        callbacks[message.id].resolve(message);
        delete callbacks[message.id];
    } else if (message.id) {
        handleMessage(message);
    }
}

export function sendMessage(message: string) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        console.warn('[sendMessage] WebSocket not open');
        return;
    }

    const bufferId = get(activeBufferId);
    if (!bufferId) {
        console.warn('[sendMessage] no active buffer ID');
        return;
    }

    const buffer = getBuffer(bufferId);
    if (!buffer) {
        console.warn('[sendMessage] buffer not found for id:', bufferId);
        return;
    }

   const msg = Protocol.formatInput({
        buffer: '0x' + buffer.id,
        data: message
    });
    sendWs(msg, 'msg:' + buffer.shortName);
}

export function disconnect() {
    disconnectStore();
    if (hotlistInterval) clearInterval(hotlistInterval);
    if (ws) {
        const quitMsg = Protocol.formatQuit();
        sendWs(quitMsg, 'quit');
        ws.close();
        ws = null;
    }
}

export function requestNicklist(bufferId: string) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        if (DEBUG_NICKLIST) console.log('[nicklist] requestNicklist skipped - WebSocket not open');
        return;
    }
    if (DEBUG_NICKLIST) console.log('[nicklist] requesting nicklist for buffer:', bufferId);
    const msg = Protocol.formatNicklist({ buffer: '0x' + bufferId });
    sendAsync(msg).then((response) => {
        if (DEBUG_NICKLIST) console.log('[nicklist] received nicklist response, objects:', response?.objects?.length ?? 0);
        // Call handleNicklist directly since callback responses don't have event IDs
        const nicklist = response.objects[0]?.content;
        if (nicklist) {
            handleNicklist(response);
        }
    }).catch((err) => {
        if (DEBUG_NICKLIST) console.error('[nicklist] request failed:', err);
    });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- async fetch returns protocol response
export function fetchMoreLines(numLines: number = 0): Promise<any> {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        return Promise.reject('WebSocket not open');
    }

    const bufferId = get(activeBufferId);
    const buffer = getBuffer(bufferId);
    if (!buffer) return Promise.reject('No active buffer');

    const bufferIdStr = '0x' + buffer.id;
    if (pendingFetchBuffers.has(bufferIdStr)) {
        return Promise.resolve();
    }
    pendingFetchBuffers.add(bufferIdStr);

    numLines = Math.max(numLines, buffer.requestedLines * 2);

    const msg = Protocol.formatHdata({
        path: `buffer:0x${buffer.id}/own_lines/last_line(-${numLines})/data`,
        keys: []
    });

    // Set up callback for this request
    currentCallbackId++;
    if (currentCallbackId > 1000) currentCallbackId = 0;
    const cbId = currentCallbackId;

    return new Promise((resolve, reject) => {
        callbacks[cbId] = { resolve, reject };

        const formattedMsg = protocolInstance.setId(cbId, msg);
        sendWs(formattedMsg, 'fetch#' + cbId);

        // Timeout after 30 seconds
        setTimeout(() => {
            if (callbacks[cbId]) {
                delete callbacks[cbId];
                reject(new Error('fetchMoreLines timeout'));
            }
        }, 30000);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- protocol response type
    }).then((message: any) => {
        // Process the fetched lines — clear old lines and refill (matching AngularJS flow)
        const oldLength = buffer.lines.length;
        buffer.lines = [];
        buffer.requestedLines = 0;
        handleLineInfo(message, true);
        buffer.lastSeen -= oldLength;

        // Determine if all lines are fetched
        const linesReceived = message.objects?.[0]?.content?.length ?? 0;
        if (linesReceived < numLines && buffer) {
            buffer.allLinesFetched = true;
        }
        return message;
    }).catch((err) => {
        console.warn('[fetchMoreLines] fetch failed, marking allLinesFetched:', err);
        if (buffer) {
            buffer.allLinesFetched = true;
        }
    }).finally(() => {
        pendingFetchBuffers.delete(bufferIdStr);
    });
}

function autoApplyNickColors() {
    const cfg = get(wconfig);
    if (!shouldAutoApply(cfg['weechat.color.chat_nick_colors'] ?? '')) {
        return; // User has customized, leave it alone
    }

    sendWeeChatCommand(`/set weechat.color.chat_nick_colors "${IDEAL_NICK_COLORS}"`);
    sendWeeChatCommand(`/set irc.look.color_nicks_in_nicklist ${IDEAL_COLOR_NICKS_IN_NICKLIST}`);
    sendWeeChatCommand('/save');

    console.log('[nick-colors] auto-applied ideal nick color palette (175 colors) + saved');
}

export function sendWeeChatCommand(command: string) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        console.warn('[sendWeeChatCommand] WebSocket not open');
        return;
    }
    // Send command to core WeeChat buffer (0x0), which accepts all /input commands
    const msg = Protocol.formatInput({
        buffer: '0x0',
        data: command
    });
    sendWs(msg, 'cmd:' + command.substring(0, 50));
}

export function switchBuffer(bufferId: string) {
    const prevBufferId = get(activeBufferId);
    const success = setActiveBuffer(bufferId);
    if (!success || !ws || ws.readyState !== WebSocket.OPEN) {
        return success;
    }
    // Sync read marker with WeeChat (matching Angular behavior)
    if (get(wconfig).hotlistsync) {
        // Clear hotlist for the buffer we're leaving, not the one we're switching to
        const prevBuffer = prevBufferId ? getBuffer(prevBufferId) : null;
        if (prevBuffer) {
            sendWeeChatCommand('/buffer ' + prevBuffer.fullName + ' set hotlist -1');
        }
        sendWeeChatCommand('/input set_unread_current_buffer');
    } else {
        sendWeeChatCommand('/buffer set hotlist -1');
        sendWeeChatCommand('/input hotlist_clear');
    }
    return success;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- WeeChat buffer ID is a hex string from protocol
export function sendBufferCommand(bufferId: any, command: string) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        console.warn('[sendBufferCommand] WebSocket not open');
        return;
    }
    const msg = Protocol.formatInput({
        buffer: '0x' + bufferId,
        data: command
    });
    sendWs(msg, 'bufcmd:' + command.substring(0, 50));
}

export function closeBufferOnWeeChat(bufferId: string) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        console.warn('[closeBufferOnWeeChat] WebSocket not open');
        return;
    }
    const msg = Protocol.formatInput({
        buffer: '0x' + bufferId,
        data: '/close'
    });
    sendWs(msg, 'close:' + bufferId);
}

export function pinBuffer(bufferId: string) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        console.warn('[pinBuffer] WebSocket not open');
        return;
    }
    const msg = Protocol.formatLocalvarSet({
        buffer: '0x' + bufferId,
        name: 'pinned',
        value: 'true'
    });
    sendWs(msg, 'pin:' + bufferId);
}

export function unpinBuffer(bufferId: string) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        console.warn('[unpinBuffer] WebSocket not open');
        return;
    }
    const msg = Protocol.formatLocalvarSet({
        buffer: '0x' + bufferId,
        name: 'pinned',
        value: 'false'
    });
    sendWs(msg, 'unpin:' + bufferId);
}

export function getWs() {
    return ws;
}
