import { get } from 'svelte/store';
import { setConnectionStatus, setErrors, clearErrors, disconnect as disconnectStore, connectionState, recordBytesReceived, recordBytesSent, resetReconnectAttempts, incrementReconnectAttempts } from '$lib/stores/connectionStore';
import { buffers, servers, activeBufferId, getBuffer, connected, setActiveBuffer } from '$lib/stores/models';
import { settings } from '$lib/stores/settings';
import { handleVersionInfo, handleConfValue, handleBufferInfo, handleHotlistInfo, handleLineInfo, handleMessage, handleNicklist } from '$lib/stores/handlers';
import { addToast, removeToast, toastStore } from '$lib/toast';
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
let reconnectingTimer: ReturnType<typeof setTimeout> | null = null;
let connectionData: [string, number, string, string, boolean, boolean] | null = null;
let wasClosingDuringConnect = false;
let connecting = false;

// Persist WebSocket across Vite HMR by saving/restoring on window (dev only).
// Prevents "WebSocket not open" errors and query floods after hot reload.
let hmrCooldownUntil = 0;
if (import.meta.env.DEV && typeof window !== 'undefined') {
    const savedWs = (window as any).__gb_ws;
    if (savedWs && savedWs.readyState === WebSocket.OPEN) {
        ws = savedWs;
        // Capture local reference for type narrowing in closures below.
        const restoredWs = savedWs;
        console.log('[connect] HMR: restored WebSocket from previous module');
        restoredWs.onmessage = (event: MessageEvent) => {
            if (event.data instanceof ArrayBuffer) {
                onMessage(event.data);
            }
        };
        // Re-attach onclose handler for the restored socket
        restoredWs.onclose = (evt: CloseEvent) => {
            Object.keys(callbacks).forEach(k => {
                const id = parseInt(k, 10);
                if (callbacks[id]) {
                    callbacks[id].reject(new Error('WebSocket closed'));
                }
                delete callbacks[id];
            });
            connecting = false;
            if (reconnectingTimer) {
                clearTimeout(reconnectingTimer);
                reconnectingTimer = null;
            }
            console.log('Disconnected from relay', evt.code, evt.reason);
            if (hotlistInterval) {
                clearInterval(hotlistInterval);
                hotlistInterval = null;
            }
            setConnectionStatus('disconnected');
            connected.set(false);

            if (get(connectionState).userDisconnect) {
                connectionData = null;
            } else if (!get(settings).autoconnect) {
                if (get(connectionState).wasEverConnected) {
                    const connInfo = connectionData ? [...connectionData] as [string, number, string, string, boolean, boolean] : null;
                    connectionData = null;
                    if (connInfo) {
                        const [host, port] = connInfo;
                        addToast(
                            `Disconnected from ${host}:${port}`,
                            {
                                type: 'warning',
                                duration: 0,
                                buttons: [{
                                    text: 'Reconnect',
                                    action: () => {
                                        const latest = get(toastStore);
                                        const lastToast = latest[latest.length - 1];
                                        if (lastToast) removeToast(lastToast.id);
                                        const [h, p, path, pw, tls, noComp] = connInfo!;
                                        connect(h, p, path, pw, tls, noComp);
                                    }
                                }]
                            }
                        );
                    }
                } else {
                    connectionData = null;
                }
            } else if (typeof document !== 'undefined' && !document.hasFocus()) {
                // stay disconnected
            } else if (!get(connectionState).wasEverConnected) {
                // first connection failed — don't reconnect
            } else if (evt.code === 1006 || evt.code === 1011) {
                scheduleReconnect();
            } else if (evt.code === 403 || evt.code === 401) {
                setErrors({ passwordError: true });
            } else {
                scheduleReconnect();
            }
        };
        restoredWs.onerror = (evt: Event) => {
            console.error('Relay error:', evt);
            setConnectionStatus('error');
        };
        hmrCooldownUntil = Date.now() + 500;
        console.log('[connect] HMR cooldown active for 500ms');
    }
}

export async function connect(host: string, port: number, path: string, password: string, tls: boolean, noCompression: boolean) {
    clearErrors();

    const hasCryptoSubtle = typeof crypto.subtle !== 'undefined';
    const proto = tls ? 'wss' : 'ws';

    // Handle IPv6
    let formattedHost = host;
    if (host.indexOf(":") !== -1 && host[0] !== "[" && host[host.length - 1] !== "]") {
        formattedHost = "[" + host + "]";
    }

    const url = `${proto}://${formattedHost}:${port}/${path}`;
    console.log('Connecting to:', `${proto}://${formattedHost}:${port}`);

    // Detect if we're reconnecting after HMR killed an established connection
    // (old module's event listeners were torn down, but ws object survived in memory)
    if (ws && ws.readyState === WebSocket.OPEN) {
        // Connection was alive when HMR happened — this is the key signal
        wasClosingDuringConnect = true;
        console.log('[connect] HMR reload detected: previous connection was OPEN');
    }
    if (ws) {
        // Save WS to window before closing, so next HMR can restore it.
        if (import.meta.env.DEV && typeof window !== 'undefined') {
            (window as any).__gb_ws = ws;
        }
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

                // Handshake — request pbkdf2+sha512 only if crypto.subtle is available
                const handshakeMsg = Protocol.formatHandshake({
                    password_hash_algo: hasCryptoSubtle ? 'pbkdf2+sha512' : 'plain',
                    compression: noCompression ? 'off' : 'zlib'
                });

                const handshakeResponse = await sendAsync(handshakeMsg);
                const content = handshakeResponse.objects[0]?.content;

                const passwordMethod = content?.password_hash_algo;
                const nonce = hexStringToByte(content?.nonce || '');
                const iterations = content?.password_hash_iterations || 0;

                // Initialize connection — fallback to plain if pbkdf2 requested but crypto.subtle unavailable
                if (passwordMethod === 'pbkdf2+sha512' && hasCryptoSubtle) {
                    await initializePBKDF2(password, nonce, iterations);
                } else if (passwordMethod === 'plain' || passwordMethod === 'pbkdf2+sha512') {
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

                // Reset reconnect attempt counter on successful connection
                resetReconnectAttempts();
                if (reconnectingTimer) {
                    clearTimeout(reconnectingTimer);
                    reconnectingTimer = null;
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
            // Clear any pending reconnect timer from a previous attempt
            if (reconnectingTimer) {
                clearTimeout(reconnectingTimer);
                reconnectingTimer = null;
            }
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
                if (get(connectionState).wasEverConnected) {
                    const connInfo = connectionData ? [...connectionData] as [string, number, string, string, boolean, boolean] : null;
                    connectionData = null;
                    if (connInfo) {
                        const [host, port] = connInfo;
                        addToast(
                            `Disconnected from ${host}:${port}`,
                            {
                                type: 'warning',
                                duration: 0,
                                buttons: [{
                                    text: 'Reconnect',
                                    action: () => {
                                        const latest = get(toastStore);
                                        const lastToast = latest[latest.length - 1];
                                        if (lastToast) removeToast(lastToast.id);
                                        const [h, p, path, pw, tls, noComp] = connInfo!;
                                        connect(h, p, path, pw, tls, noComp);
                                    }
                                }]
                            }
                        );
                    }
                } else {
                    connectionData = null;
                }
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

// Max consecutive reconnection attempts before showing user a toast and stopping
const maxReconnectAttempts = 8;
// Minimum delay between reconnect attempts (ms)
const minReconnectDelay = 10_000;
// Maximum backoff delay (ms)
const maxReconnectDelay = 60_000;

// Calculate exponential backoff delay based on attempt number.
// Starts at minReconnectDelay, increases by 5s per attempt, capped at maxReconnectDelay.
function reconnectDelay(attempts: number): number {
    return Math.min(minReconnectDelay + (attempts - 1) * 5000, maxReconnectDelay);
}

function scheduleReconnect() {
    if (!connectionData) return;

    // Prevent stacking multiple reconnect timers
    if (reconnectingTimer) {
        clearTimeout(reconnectingTimer);
    }

    const attempts = incrementReconnectAttempts();

    if (attempts > maxReconnectAttempts) {
        // Max retries exhausted — stop auto-reconnecting, show persistent toast
        addToast(
            `Connection lost after ${attempts - 1} failed reconnect attempts.`,
            {
                type: 'error',
                duration: 0,
                buttons: [{
                    text: 'Retry',
                    action: () => {
                        const latest = get(toastStore);
                        const lastToast = latest[latest.length - 1];
                        if (lastToast) removeToast(lastToast.id);
                        resetReconnectAttempts();
                        const [h, p, path, pw, tls, noComp] = connectionData!;
                        connect(h, p, path, pw, tls, noComp);
                    }
                }]
            }
        );
        return;
    }

    const delay = reconnectDelay(attempts);
    console.log(`[reconnect] attempt ${attempts}/${maxReconnectAttempts}, retrying in ${delay / 1000}s`);

    const [host, port, path, password, tls, noCompression] = connectionData;

    reconnectingTimer = setTimeout(() => {
        reconnectingTimer = null;
        setConnectionStatus('reconnecting');
        // Clear buffers
        buffers.set({});
        servers.set({});

        connect(host, port, path, password, tls, noCompression);
    }, delay);
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
    // Suppress queries during HMR cooldown to prevent cascading requests after hot reload.
    if (Date.now() < hmrCooldownUntil) {
        return Promise.reject(new Error('HMR cooldown active'));
    }
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
        console.debug('[connect] recvAsync id=' + message.id + ' objects=' + message.objects.length);
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
    if (reconnectingTimer) {
        clearTimeout(reconnectingTimer);
        reconnectingTimer = null;
    }
    connectionData = null;
    if (ws) {
        const quitMsg = Protocol.formatQuit();
        sendWs(quitMsg, 'quit');
        // Save WS to window before closing, so next HMR can restore it.
        if (import.meta.env.DEV && typeof window !== 'undefined') {
            (window as any).__gb_ws = ws;
        }
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
export async function fetchMoreLines(numLines: number = 0, explicitBufferId?: string): Promise<any> {
    // Suppress during HMR cooldown to prevent cascading fetch requests after hot reload.
    if (Date.now() < hmrCooldownUntil) {
        return;
    }
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        throw new Error('WebSocket not open');
    }

    const bufferId = explicitBufferId ?? get(activeBufferId);
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
        // Re-read the buffer from the store after await. handleBufferLineAdded may have
        // created a new store copy during the async wait, so our captured reference is stale.
        const freshBuffer = getBuffer(bufferId);
        if (!freshBuffer) return;
        // Process the fetched lines — clear old lines and refill (matching AngularJS flow).
        // Preserve readmarker position by subtracting the old line count from lastSeen
        // after handleLineInfo increments it per-line (including injected date-change lines).
        const oldLength = freshBuffer.lines.length;
        freshBuffer.lines = [];
        freshBuffer.requestedLines = 0;
        handleLineInfo(message, true);
        // Correct the read marker for the lines that were counted twice (old + new).
        freshBuffer.lastSeen -= oldLength;

        // Determine if all lines are fetched
        const linesReceived = message.objects?.[0]?.content?.length ?? 0;
        if (linesReceived < numLines && freshBuffer) {
            freshBuffer.allLinesFetched = true;
        }
    } catch (err) {
        console.warn('[fetchMoreLines] fetch failed, marking allLinesFetched:', err);
        const fallbackBuffer = getBuffer(bufferId);
        if (fallbackBuffer) {
            fallbackBuffer.allLinesFetched = true;
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

// Deduplicate hotlist queries: prevent cascading requests during rapid buffer switches.
let lastHotlistQueryTime = 0;

export async function switchBuffer(bufferId: string): Promise<boolean> {
    // Suppress during HMR cooldown to prevent cascading effect-triggered switches.
    if (Date.now() < hmrCooldownUntil) {
        return false;
    }
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        return false;
    }
    // Fetch lines only for buffers that haven't been read yet (lastSeen < 0).
    // Buffers with a valid readmarker position should not have their lines
    // cleared and refetched — that would destroy the preserved lastSeen value.
    const buffer = getBuffer(bufferId);
    if (buffer && buffer.lastSeen < 0 && buffer.requestedLines < 100) {
        try {
            await fetchMoreLines(100, bufferId);
        } catch (err) {
            console.error('[setActiveBuffer] fetchMoreLines failed:', err);
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
        // Deduplicate: skip hotlist query if one was sent recently (< 300ms apart).
        // Prevents cascading queries during rapid buffer switches or HMR reloads.
        const now = Date.now();
        if (now - lastHotlistQueryTime < 300) return;
        lastHotlistQueryTime = now;
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
