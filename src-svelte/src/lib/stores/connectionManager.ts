import { get } from 'svelte/store';
import { setConnectionStatus, setErrors, clearErrors, disconnect as disconnectStore, connectionState, recordBytesReceived, recordBytesSent } from '$lib/stores/connectionStore';
import { buffers, servers, activeBufferId, getBuffer, connected, setActiveBuffer } from '$lib/stores/models';
import { settings } from '$lib/stores/settings';
import { handleVersionInfo, handleConfValue, handleBufferInfo, handleHotlistInfo, handleLineInfo, handleMessage, handleNicklist } from '$lib/stores/handlers';
// TODO: Re-enable nick color customization when desired
// import { IDEAL_NICK_COLORS, IDEAL_COLOR_NICKS_IN_NICKLIST, shouldAutoApply } from '$lib/stores/nickColors';
import { Protocol } from '$lib/weechat';
import type { ProtocolMessage } from '$lib/types';
import { DEBUG_NICKLIST, DEBUG_WEECHAT_COMMANDS } from '$lib/debug';

// Protocol instance for instance methods (setId, parse)
// Static methods (formatHandshake, formatInit, etc.) are called on the constructor directly
const protocolInstance = new Protocol();

let ws: WebSocket | null = null;
let hotlistInterval: ReturnType<typeof setInterval> | null = null;
let connectionData: [string, number, string, string, boolean, boolean] | null = null;
let wasClosingDuringConnect = false;
let connecting = false;

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

    // Detect if we're reconnecting after HMR killed an established connection
    // (old module's event listeners were torn down, but ws object survived in memory)
    if (ws && ws.readyState === WebSocket.OPEN) {
        // Connection was alive when HMR happened — this is the key signal
        wasClosingDuringConnect = true;
        console.log('[connect] HMR reload detected: previous connection was OPEN');
    }
    if (ws) {
        ws.close();
        ws = null;
    }
    connectionData = [host, port, path, password, tls, noCompression];
    setConnectionStatus('connecting');

    let rejectPromise: ((e: Error) => void) | null = null;

    return new Promise<void>((resolve, reject) => {
        rejectPromise = reject;
        ws = new WebSocket(url);
        const connectStart = Date.now();
        ws.binaryType = 'arraybuffer';

        ws.onopen = async () => {
            connecting = true;
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
                await fetchConfValue('weechat.color.chat_nick_colors');

                // TODO: Re-enable auto-apply nick colors when desired
                // autoApplyNickColors();

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

                // Start hotlist sync interval — only if user enabled it in settings.
                // Keeps unread counts in sync with other clients or terminal usage directly.
                if (get(settings).hotlistsync) {
                    hotlistInterval = setInterval(async () => {
                        const hlMsg = Protocol.formatHdata({
                            path: 'hotlist:gui_hotlist(*)',
                            keys: []
                        });
                        const hlResp = await sendAsync(hlMsg);
                        handleHotlistInfo(hlResp);
                    }, 15000);
                }

                resolve();
            } catch (e) {
                // If onclose already set passwordError, don't overwrite with generic error
                const errors = get(connectionState).errors;
                if (errors.passwordError) {
                    console.log('[connect] connection closed after auth failure');
                    return;
                }
                console.error('Connection error:', e);
                reject(e);
            }
        };

        ws.onmessage = (event) => {
            if (event.data instanceof ArrayBuffer) {
                onMessage(event.data);
            }
        };

        ws.onclose = (evt) => {
            // Reject all pending callbacks to unblock awaiting sendAsync promises
            Object.keys(callbacks).forEach(k => {
                const id = parseInt(k, 10);
                if (callbacks[id]) {
                    callbacks[id].reject(new Error('WebSocket closed'));
                }
                delete callbacks[id];
            });

            connecting = false;
            console.log('Disconnected from relay', evt.code, evt.reason);
            if (hotlistInterval) {
                clearInterval(hotlistInterval);
                hotlistInterval = null;
            }
            setConnectionStatus('disconnected');
            connected.set(false);

            let shouldReject = false;

            // Always detect error types for initial connections first,
            // before autoconnect/focus checks that control reconnection behavior
            if (!get(connectionState).wasEverConnected) {
                if (evt.code === 403 || evt.code === 401) {
                    setErrors({ passwordError: true });
                    shouldReject = true;
                } else if (wasClosingDuringConnect) {
                    // Page reloaded during initial connect
                    setErrors({ hmrReloadError: true });
                } else if (evt.code === 1006) {
                    // 1006 after handshake succeeded = auth rejected by server, not unreachable
                    if (connecting === false && ws !== null) {
                        // onclose already ran, connection was established then closed → bad password
                        setErrors({ passwordError: true });
                        shouldReject = true;
                    } else {
                        // Never connected at all → truly unreachable
                        setErrors({ serverUnreachable: true });
                    }
                }
            }

            // Then decide reconnect behavior
            if (get(connectionState).userDisconnect) {
                // User initiated disconnect, don't auto-reconnect
                connectionData = null;
            } else if (!get(settings).autoconnect) {
                // Autoconnect is OFF — stay disconnected, require manual login
                connectionData = null;
            } else if (typeof document !== 'undefined' && !document.hasFocus()) {
                // User was not focused — stay disconnected
            } else if (!get(connectionState).wasEverConnected) {
                // First connection failed — don't reconnect (errors already set above)
            } else if (evt.code === 1006 || evt.code === 1011) {
                // Unexpected disconnect after being connected — retry
                scheduleReconnect();
            } else if (evt.code === 403 || evt.code === 401) {
                // Auth failure after reconnect — show password error
                setErrors({ passwordError: true });
            } else {
                // Normal close or other codes
                scheduleReconnect();
            }

            if (shouldReject && rejectPromise) {
                rejectPromise(new Error('Authentication failed'));
            }
        };

        ws.onerror = (evt) => {
            console.error('Relay error:', evt);
            setConnectionStatus('error');
            // HMR/reload detection: WebSocket was already closing when we started
            if (wasClosingDuringConnect) {
                setErrors({ hmrReloadError: true });
            } else if (!get(connectionState).wasEverConnected && !connecting) {
                // onclose already ran, check if it was a pre-connect failure
                const elapsed = Date.now() - connectStart;
                if (elapsed < 10000) {
                    setErrors({ serverUnreachable: true });
                } else {
                    setErrors({ errorMessage: true });
                }
            }
            // Don't reject if onclose already handled the close — prevents timeout from overwriting onclose's error state
            if (!connecting) return;
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

async function fetchConfValue(name: string) {
    const msg = Protocol.formatInfolist({
        name: 'option',
        pointer: 0,
        args: name
    });
    const resp = await sendAsync(msg);
    handleConfValue(resp);
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

        // Timeout after 10 seconds — if WS already closed, reject immediately so the promise settles
        setTimeout(() => {
            if (!ws || ws.readyState !== WebSocket.OPEN) {
                delete callbacks[cbId];  // Clean up dangling callback
                reject(new Error('Connection closed before response received'));
                return;
            }
            if (callbacks[cbId]) {
                delete callbacks[cbId];
                console.error('[connect] timeout id=' + cbId);
                reject(new Error('Request timeout'));
            }
        }, 10000);
    });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic callback resolution/rejection types
const callbacks: Record<string, { resolve: (v: any) => void; reject: (e: any) => void }> = {};
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

function concatenateTypedArrays(...arrays: Uint8Array[]): Uint8Array<ArrayBuffer> {
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
    if (DEBUG_WEECHAT_COMMANDS && data instanceof ArrayBuffer) {
        const text = new TextDecoder().decode(data);
        console.log('[WeeChatCmd] SEND', label || '(raw):', text.substring(0, 200));
    } else if (DEBUG_WEECHAT_COMMANDS && typeof data === 'string') {
        console.log('[WeeChatCmd] SEND', label || '(raw):', data.substring(0, 200));
    }
    const byteLength = typeof data === 'string' ? new Blob([data]).size : (data as ArrayBuffer).byteLength;
    ws.send(data);
    recordBytesSent(byteLength);
}

// Handle incoming messages
export async function onMessage(data: ArrayBuffer) {
    recordBytesReceived(data.byteLength);
    const message = await protocolInstance.parse(data);

    if (message.id && callbacks[message.id]) {
        const cb = callbacks[message.id]!;
        cb.resolve(message);
        delete callbacks[message.id];
    } else if (message.id) {
        handleMessage(message as unknown as ProtocolMessage);
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
    connectionData = null;
    if (ws) {
        const quitMsg = Protocol.formatQuit();
        sendWs(quitMsg, 'quit');
        ws.close();
        ws = null;
    }
}

export async function requestNicklist(bufferId: string) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        if (DEBUG_NICKLIST) console.log('[nicklist] requestNicklist skipped - WebSocket not open');
        return;
    }
    if (DEBUG_NICKLIST) console.log('[nicklist] requesting nicklist for buffer:', bufferId);
    try {
        const msg = Protocol.formatNicklist({ buffer: '0x' + bufferId });
        const response = await sendAsync(msg);
        if (DEBUG_NICKLIST) console.log('[nicklist] received nicklist response, objects:', response?.objects?.length ?? 0);
        // Call handleNicklist directly since callback responses don't have event IDs
        const nicklist = response.objects[0]?.content;
        if (nicklist) {
            handleNicklist(response);
        }
    } catch (err) {
        if (DEBUG_NICKLIST) console.error('[nicklist] request failed:', err);
    }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- async fetch returns protocol response
export async function fetchMoreLines(numLines: number = 0): Promise<any> {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        throw new Error('WebSocket not open');
    }

    const bufferId = get(activeBufferId);
    const buffer = getBuffer(bufferId);
    if (!buffer) throw new Error('No active buffer');

    // Prevent redundant fetches when all lines have already been loaded
    if (buffer.allLinesFetched) {
        return;
    }

    const bufferIdStr = '0x' + buffer.id;
    if (pendingFetchBuffers.has(bufferIdStr)) {
        return;
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

    let message: any;
    try {
        message = await new Promise((resolve, reject) => {
            if (!ws || ws.readyState !== WebSocket.OPEN) {
                delete callbacks[cbId];
                return reject(new Error('WebSocket not open'));
            }

            callbacks[cbId] = { resolve, reject };

            // Double-check WS is still open right before sending (TOCTOU guard)
            if (!ws || ws.readyState !== WebSocket.OPEN) {
                delete callbacks[cbId];
                return reject(new Error('WebSocket not open'));
            }

            const formattedMsg = protocolInstance.setId(cbId, msg);
            sendWs(formattedMsg, 'fetch#' + cbId);

            // Timeout after 30 seconds
            setTimeout(() => {
                if (callbacks[cbId]) {
                    delete callbacks[cbId];
                    reject(new Error('fetchMoreLines timeout'));
                }
            }, 30000);
        });
        // Process the fetched lines — clear old lines and refill (matching AngularJS flow).
        // Preserve readmarker position by subtracting the old line count from lastSeen
        // after handleLineInfo increments it per-line (including injected date-change lines).
        const oldLength = buffer.lines.length;
        buffer.lines = [];
        buffer.requestedLines = 0;
        handleLineInfo(message, true);
        // Correct the read marker for the lines that were counted twice (old + new).
        buffer.lastSeen -= oldLength;

        // Determine if all lines are fetched
        const linesReceived = message.objects?.[0]?.content?.length ?? 0;
        if (linesReceived < numLines && buffer) {
            buffer.allLinesFetched = true;
        }
    } catch (err) {
        console.warn('[fetchMoreLines] fetch failed, marking allLinesFetched:', err);
        if (buffer) {
            buffer.allLinesFetched = true;
        }
    } finally {
        pendingFetchBuffers.delete(bufferIdStr);
    }
}

// TODO: Re-enable when desired
// function autoApplyNickColors() {
//     const cfg = get(wconfig);
//     if (!shouldAutoApply(cfg['weechat.color.chat_nick_colors'] ?? '')) {
//         return; // User has customized, leave it alone
//     }
//
//     sendWeeChatCommand(`/set weechat.color.chat_nick_colors "${IDEAL_NICK_COLORS}"`);
//     sendWeeChatCommand(`/set irc.look.color_nicks_in_nicklist ${IDEAL_COLOR_NICKS_IN_NICKLIST}`);
//     sendWeeChatCommand('/save');
//
//     console.log('[nick-colors] auto-applied ideal nick color palette (175 colors) + saved');
// }

export function sendWeeChatCommand(command: string, bufferId?: string) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        console.warn('[sendWeeChatCommand] WebSocket not open');
        return;
    }
    // Send command to core WeeChat buffer (0x0), or to a specific buffer if bufferId is provided
    const msg = Protocol.formatInput({
        buffer: bufferId ? '0x' + bufferId : '0x0',
        data: command
    });
    sendWs(msg, 'cmd:' + command.substring(0, 50));
}

export async function switchBuffer(bufferId: string): Promise<boolean> {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        return false;
    }
    // Fetch lines only for buffers that haven't been read yet (lastSeen < 0).
    // Buffers with a valid readmarker position should not have their lines
    // cleared and refetched — that would destroy the preserved lastSeen value.
    const buffer = getBuffer(bufferId);
    if (buffer && buffer.lastSeen < 0 && buffer.requestedLines < 100) {
        try {
            activeBufferId.set(bufferId);
            await fetchMoreLines(100);
        } catch {
            // Silently ignore fetch failures on buffer switch
        }
    }
    const success = setActiveBuffer(bufferId);
    if (!success) {
        return false;
    }
    // Defer hotlist/unread clear until after the scroll effect (rAF) has run,
    // so that lastSeen calculation uses the correct localUnread value before it's zeroed out.
    requestAnimationFrame(() => {
        sendWeeChatCommand('/buffer set hotlist -1', bufferId);
        sendWeeChatCommand('/input set_unread_current_buffer', bufferId);
        // Request authoritative current hotlist state from WeeChat to ensure
        // stale counts are cleared (e.g., after scroll-to-bottom).
        const hlMsg = Protocol.formatHdata({
            path: 'hotlist:gui_hotlist(*)',
            keys: []
        });
        sendAsync(hlMsg).catch(() => {});
    });
    // Nicklist backfill is handled by $effect in +page.svelte (guarded: only fetches if empty).
    return true;
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
