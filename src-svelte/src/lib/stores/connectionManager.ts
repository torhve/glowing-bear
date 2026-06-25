import { get } from 'svelte/store';
import { setConnectionStatus, setErrors, clearErrors, disconnect as disconnectStore, connectionState, recordBytesReceived, recordBytesSent, resetReconnectAttempts, incrementReconnectAttempts } from '$lib/stores/connectionStore';
import { buffers, servers, activeBufferId, getBuffer, connected, setActiveBuffer, clearAllUnread, localUnreadBuffers, hotlistClearedBuffers, bufferBottom, previousBufferId, pendingBufferSwitch } from '$lib/stores/models';
import { settings } from '$lib/stores/settings';
import { handleVersionInfo, handleConfValue, handleBufferInfo, handleHotlistInfo, handleLineInfo, handleMessage, handleNicklist, setOnUpgrade, setOnUpgradeEnded } from '$lib/stores/handlers';
import { addToast, removeToast, clearToasts, toastStore } from '$lib/toast';
import { onDisconnect } from '$lib/notifications';
import { Protocol } from '$lib/weechat';
import { sha256, pbkdf2 as nativePbkdf2, toHexString } from '$lib/utils/crypto';
import type { ProtocolMessage } from '$lib/types';
import { DEBUG_NICKLIST, DEBUG_WEECHAT_COMMANDS, DEBUG_CONNECTION } from '$lib/debug';

// Protocol instance for instance methods (setId, parse)
// Static methods (formatHandshake, formatInit, etc.) are called on the constructor directly
const protocolInstance = new Protocol();

// Track all WebSocket instances (including stale ones from previous connections)
// so that disconnect() can close them all — prevents orphaned connections.
const webSockets = new Set<WebSocket>();

let ws: WebSocket | null = null;
let hotlistInterval: ReturnType<typeof setInterval> | null = null;
let reconnectingTimer: ReturnType<typeof setTimeout> | null = null;
let connectionData: [string, number, string, string, boolean, boolean] | null = null;
let connecting = false;
let manualReconnectRequested = false;
let connectionGeneration = 0;

// Reset connection state after WebSocket close — rejects pending callbacks,
// clears timers and tracking sets, updates stores. Preserves activeBufferId
// and previousBufferId for reconnect recovery.
function resetConnectionState() {
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
    if (hotlistInterval) {
        clearInterval(hotlistInterval);
        hotlistInterval = null;
    }
    if (hotlistDebounceTimer) {
        clearTimeout(hotlistDebounceTimer);
        hotlistDebounceTimer = null;
    }
    pendingFetchBuffers.clear();
    bufferBottom.set(true);
    pendingBufferSwitch.set(null);
    setConnectionStatus('disconnected');
    connected.set(false);
    if (get(connectionState).wasEverConnected) {
        clearAllUnread();
        onDisconnect();
    }
}

// Detect error type from close event for initial connection failures.
// Uses close codes to distinguish auth errors from server unreachable.
function detectError(evt: CloseEvent): boolean {
    if (get(connectionState).wasEverConnected) return false;
    if (evt.code === 403 || evt.code === 401) {
        setErrors({ passwordError: true });
        return true;
    }
    if (evt.code === 1006) {
        if (connecting === false && ws !== null) {
            setErrors({ passwordError: true });
            return true;
        }
        setErrors({ serverUnreachable: true });
    }
    return false;
}

// Decide whether to auto-reconnect or show a toast after WebSocket close.
// Handles user disconnect, focus state, first-connection failure, and
// unexpected close codes. Delegates to scheduleReconnect for auto-retry.
function handleReconnectDecision(evt: CloseEvent) {
    const state = get(connectionState);
    if (state.userDisconnect) {
        connectionData = null;
    } else if (typeof document !== 'undefined' && !document.hasFocus()) {
        if (state.wasEverConnected && connectionData) {
            showDisconnectToast(connectionData);
        }
    } else if (!state.wasEverConnected) {
        // First connection failed — errors already set by detectError
    } else if (evt.code === 1005 || evt.code === 1006 || evt.code === 1011) {
        if (connectionData) showDisconnectToast(connectionData);
        scheduleReconnect();
    } else if (evt.code === 403 || evt.code === 401) {
        setErrors({ passwordError: true });
        if (connectionData) showDisconnectToast(connectionData);
    } else {
        if (connectionData) showDisconnectToast(connectionData);
        scheduleReconnect();
    }
}

export async function connect(host: string, port: number, path: string, password: string, tls: boolean, noCompression: boolean) {
    // If user clicked manual reconnect while auto-reconnect was in progress,
    // abort the existing connection attempt and take over.
    if (manualReconnectRequested) {
        manualReconnectRequested = false;
        if (connecting) {
            // Close all tracked WebSocket instances (including stale ones)
            for (const w of webSockets) w.close(1000, 'manual reconnect');
            webSockets.clear();
            ws = null;
        }
    }
    if (connecting) {
        if (DEBUG_CONNECTION) console.log('[connect] already connecting, skipping duplicate');
        return;
    }
    connecting = true;
    connectionGeneration++;
    clearErrors();

    const hasCryptoSubtle = typeof crypto.subtle !== 'undefined';
    const proto = tls ? 'wss' : 'ws';

    // Handle IPv6
    let formattedHost = host;
    if (host.indexOf(":") !== -1 && host[0] !== "[" && host[host.length - 1] !== "]") {
        formattedHost = "[" + host + "]";
    }

    const url = `${proto}://${formattedHost}:${port}/${path}`;
    if (DEBUG_CONNECTION) console.log('Connecting to:', `${proto}://${formattedHost}:${port}`);

    // Close all existing WebSocket instances before starting new connection
    for (const w of webSockets) w.close(1000, 'new connection');
    webSockets.clear();
    ws = null;
    connectionData = [host, port, path, password, tls, noCompression];
    setConnectionStatus('connecting');

    // Register upgrade callbacks so handlers can trigger disconnect/reconnect.
    setOnUpgrade(() => {
        for (const w of webSockets) {
            if (w.readyState === WebSocket.OPEN) w.close(1000, 'WeeChat upgrading');
        }
    });
    setOnUpgradeEnded(() => {
        const [h, p, path, pw, tls, noComp] = connectionData || [null, 0, '', '', false, false];
        if (h !== null) {
            connect(h, p, path, pw, tls, noComp).catch(() => {});
        }
    });

    let rejectPromise: ((e: Error) => void) | null = null;

    return new Promise<void>((resolve, reject) => {
        rejectPromise = reject;
        try {
            ws = new WebSocket(url);
            webSockets.add(ws);
        } catch (e) {
            connecting = false;
            reject(e);
            return;
        }
        const genAtConnect = connectionGeneration;
        const thisWs = ws;
        ws.binaryType = 'arraybuffer';

        ws.onopen = async () => {
            // If connect() was called again while this WebSocket was connecting,
            // connectionGeneration has changed and this handler is stale.
            if (genAtConnect !== connectionGeneration) {
                thisWs.close();
                return;
            }
            connecting = true;
            try {
                // Reset callbacks for new connection
                Object.keys(callbacks).forEach(k => delete callbacks[parseInt(k, 10)]);
                currentCallbackId = 0;

                // Handshake — prefer pbkdf2+sha512, fallback to sha256 variants or plain
                const algoList = hasCryptoSubtle
                    ? 'pbkdf2+sha512:pbkdf2+sha256:sha512:sha256:plain'
                    : 'pbkdf2+sha256:sha256:plain';
                const handshakeMsg = Protocol.formatHandshake({
                    password_hash_algo: algoList,
                    compression: noCompression ? 'off' : 'zlib'
                });

                const handshakeResponse = await sendAsync(handshakeMsg);
                const content = handshakeResponse.objects[0]?.content as Record<string, unknown> | undefined;

                const passwordMethod = content?.password_hash_algo as string | undefined;
                const nonce = hexStringToByte(content?.nonce as string || '');
                const iterations = (content?.password_hash_iterations as number) || 0;

                // PBKDF2 algorithms require a nonce from the server
                const needsNonce: boolean = !passwordMethod || passwordMethod === '' || passwordMethod.startsWith('pbkdf2+');
                if (nonce.length === 0 && needsNonce) {
                    setErrors({ hashAlgorithmDisagree: true });
                    reject(new Error('Server did not provide a nonce for PBKDF2 authentication'));
                    if (ws) ws.close(1000, 'Missing nonce');
                    return;
                }

                // Initialize connection — handle server's chosen hash algorithm
                if (passwordMethod === 'pbkdf2+sha512') {
                    if (hasCryptoSubtle) {
                        await initializePBKDF2(password, nonce, iterations, 'SHA-512');
                    } else {
                        // Server wants pbkdf2+sha512 but we only support sha256 variants natively → error
                        setErrors({ hashAlgorithmDisagree: true });
                        reject(new Error('Unsupported hash algorithm: pbkdf2+sha512 (needs crypto.subtle)'));
                        if (ws) ws.close(1000, 'Unsupported hash algorithm');
                        return;
                    }
                } else if (passwordMethod === 'pbkdf2+sha256') {
                    if (hasCryptoSubtle) {
                        await initializePBKDF2(password, nonce, iterations, 'SHA-256');
                    } else {
                        await initializePBKDF2Native(password, nonce, iterations);
                    }
                } else if (passwordMethod === 'sha256') {
                    if (hasCryptoSubtle) {
                        await initializeSHA(password, 'sha256');
                    } else {
                        await initializeSHANative(password);
                    }
                } else if (passwordMethod === 'sha512') {
                    if (hasCryptoSubtle) {
                        await initializeSHA(password, 'sha512');
                    } else {
                        // No native SHA-512 — report error
                        setErrors({ hashAlgorithmDisagree: true });
                        reject(new Error('Unsupported hash algorithm: sha512 (needs crypto.subtle)'));
                        if (ws) ws.close(1000, 'Unsupported hash algorithm');
                        return;
                    }
                } else if (passwordMethod === 'plain') {
                    const initMsg = Protocol.formatInit('plain:' + password, null);
                    // Fire-and-forget: WeeChat increments callback IDs so sendAsync would timeout
                    if (ws && ws.readyState === WebSocket.OPEN) {
                        sendWs(initMsg, 'init(plain)');
                    }
                    await new Promise(r => setTimeout(r, 5));
                } else if (!passwordMethod || passwordMethod === '') {
                    // Empty password_hash_algo = WeeChat using non-default algo (pbkdf2+sha256).
                    // Default to pbkdf2+sha256 when server doesn't explicitly report the algo.
                    if (hasCryptoSubtle) {
                        await initializePBKDF2(password, nonce, iterations, 'SHA-256');
                    } else {
                        await initializePBKDF2Native(password, nonce, iterations);
                    }
                } else if (passwordMethod && passwordMethod !== 'plain') {
                    // Unsupported algorithm — report error and abort
                    setErrors({ hashAlgorithmDisagree: true });
                    reject(new Error('Unsupported hash algorithm: ' + passwordMethod));
                    if (ws) ws.close(1000, 'Unsupported hash algorithm');
                    return;
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

                // Request sync (fire-and-forget, like AngularJS code)
                const syncMsg = Protocol.formatSync({});
                if (ws && ws.readyState === WebSocket.OPEN) {
                    sendWs(syncMsg, 'sync');
                }

                // Mark connected after buffer info + line loading complete
                setConnectionStatus('connected');
                connected.set(true);
                if (DEBUG_CONNECTION) console.log('[connect] connected=true, resolving promise');
                connectionState.update(current => ({ ...current, wasEverConnected: true, userDisconnect: false }));

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
                // Clear stale disconnect toasts from previous connection cycle
                clearToasts();
                resolve();
            } catch (e) {
                // If onclose already set passwordError, don't overwrite with generic error
                const errors = get(connectionState).errors;
                if (errors.passwordError) {
                    if (DEBUG_CONNECTION) console.log('[connect] connection closed after auth failure');
                    return;
                }
                console.error('Connection error:', e);
                // Ensure connected stays false when handshake fails — onclose may not fire
                if (get(connected) === true) {
                    connected.set(false);
                }
                reject(e);
            }
        };

        ws.onmessage = (event) => {
            if (event.data instanceof ArrayBuffer) {
                onMessage(event.data);
            }
        };

        ws.onclose = (evt) => {
            // Always remove closed WebSocket from tracking set
            webSockets.delete(thisWs);
            // If connection generation has changed, connect() replaced this WS — ignore
            if (genAtConnect !== connectionGeneration) return;
            if (DEBUG_CONNECTION) console.log('[connect] WebSocket close code=' + evt.code + ' reason=' + evt.reason);
            resetConnectionState();
            const shouldReject = detectError(evt);
            handleReconnectDecision(evt);
            if (shouldReject && rejectPromise) {
                rejectPromise(new Error('Authentication failed'));
            }
        };

        ws.onerror = (evt) => {
            console.error('Relay error:', evt);
            setConnectionStatus('error');
            reject(new Error('Connection failed'));
        };
    });
}

// Compute PBKDF2 password hash using the specified SHA variant.
async function initializePBKDF2(password: string, nonce: Uint8Array, iterations: number, hashAlgo: 'SHA-512' | 'SHA-256' = 'SHA-512') {
    const passwordArray = new TextEncoder().encode(password);
    const key = await crypto.subtle.importKey('raw', passwordArray, { name: 'PBKDF2' }, false, ['deriveBits']);

    const clientNonce = crypto.getRandomValues(new Uint8Array(16));
    const salt = concatenateTypedArrays(nonce, new Uint8Array([0x3A]), clientNonce);

    const bitLength = hashAlgo === 'SHA-512' ? 512 : 256;
    const hash = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', hash: hashAlgo, salt, iterations },
        key,
        bitLength
    );

    const hashHex = Array.from(new Uint8Array(hash))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
    const saltHex = Array.from(salt)
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');

    // Map Web Crypto algo name to WeeChat's label (remove hyphen: SHA-512 → sha512)
    const algoLabel = hashAlgo.toLowerCase().replace('-', '');
    const initMsg = Protocol.formatInit(
        `pbkdf2+${algoLabel}:${saltHex}:${iterations}:${hashHex}`,
        null
    );
    // Fire-and-forget: WeeChat increments callback IDs so sendAsync would timeout
    if (ws && ws.readyState === WebSocket.OPEN) {
        sendWs(initMsg, `init(pbkdf2+${algoLabel})`);
    }
    await new Promise(r => setTimeout(r, 5));
}

// Compute SHA-256 or SHA-512 password digest for authentication.
async function initializeSHA(password: string, method: 'sha256' | 'sha512') {
    const data = new TextEncoder().encode(password);
    const hashBuffer = await crypto.subtle.digest(method.toUpperCase(), data);
    const hashHex = Array.from(new Uint8Array(hashBuffer))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');

    const initMsg = Protocol.formatInit(`${method}:${hashHex}`, null);
    if (ws && ws.readyState === WebSocket.OPEN) {
        sendWs(initMsg, `init(${method})`);
    }
    await new Promise(r => setTimeout(r, 5));
}

// Native TypeScript SHA-256 fallback (no crypto.subtle required).
async function initializeSHANative(password: string) {
    const data = new TextEncoder().encode(password);
    const hashHex = toHexString(sha256(data));

    const initMsg = Protocol.formatInit(`sha256:${hashHex}`, null);
    if (ws && ws.readyState === WebSocket.OPEN) {
        sendWs(initMsg, 'init(sha256-native)');
    }
    await new Promise(r => setTimeout(r, 5));
}

// Native TypeScript PBKDF2-SHA256 fallback (no crypto.subtle required).
async function initializePBKDF2Native(password: string, nonce: Uint8Array, iterations: number) {
    const passwordArray = new TextEncoder().encode(password);
    const clientNonce = crypto.getRandomValues(new Uint8Array(16));
    const salt = concatenateTypedArrays(nonce, new Uint8Array([0x3A]), clientNonce);

    const hashHexBytes = nativePbkdf2(passwordArray, salt, iterations, 32);
    const hashHex = toHexString(hashHexBytes);
    const saltHex = Array.from(salt).map(b => b.toString(16).padStart(2, '0')).join('');

    const initMsg = Protocol.formatInit(
        `pbkdf2+sha256:${saltHex}:${iterations}:${hashHex}`,
        null
    );
    if (ws && ws.readyState === WebSocket.OPEN) {
        sendWs(initMsg, 'init(pbkdf2+sha256-native)');
    }
    await new Promise(r => setTimeout(r, 5));
}

// Show a persistent disconnect toast with reconnect button.
// Called from both disconnect handlers (restored WS and normal WS).
function showDisconnectToast(connInfo: [string, number, string, string, boolean, boolean]) {
    const [host, port] = connInfo;
    // Prevent stacking multiple disconnect toasts during reconnect cycles
    const existing = get(toastStore);
    if (existing.some(t => t.type === 'warning' && t.message.includes('Disconnected from'))) {
        return;
    }
    addToast(
        `Disconnected from ${host}:${port}`,
        {
            type: 'warning',
            duration: 0,
            buttons: [{
                text: 'Reconnect',
                action: () => triggerManualReconnect(false)
            }]
        }
    );
}

// Manual reconnect triggered by toast button — shared between disconnect toast and max-attempts error toast.
function triggerManualReconnect(resetAttempts = false) {
    const toasts = get(toastStore);
    const lastToast = toasts[toasts.length - 1];
    if (lastToast) removeToast(lastToast.id);
    if (reconnectingTimer) {
        clearTimeout(reconnectingTimer);
        reconnectingTimer = null;
    }
    if (resetAttempts) resetReconnectAttempts();
    manualReconnectRequested = true;
    const [h, p, path, pw, tls, noComp] = connectionData!;
    connect(h, p, path, pw, tls, noComp);
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
    // Don't auto-reconnect if user has disabled autoconnect in settings
    if (!get(settings).autoconnect) return;

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
                    action: () => triggerManualReconnect(true)
                }]
            }
        );
        return;
    }

    const delay = reconnectDelay(attempts);
    if (DEBUG_CONNECTION) console.log(`[reconnect] attempt ${attempts}/${maxReconnectAttempts}, retrying in ${delay / 1000}s`);

    const [host, port, path, password, tls, noCompression] = connectionData;

    reconnectingTimer = setTimeout(() => {
        reconnectingTimer = null;
        setConnectionStatus('reconnecting');
        // Clear buffers and unread tracking sets so hotlist can't restore stale unreads for cleared buffers
        buffers.set({});
        servers.set({});
        localUnreadBuffers.update(() => new Set());
        hotlistClearedBuffers.update(() => new Set());

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

    // Send a formatted message and await its response via callback
    function sendAsync(message: string): Promise<ProtocolMessage> {
    return new Promise<unknown>((resolve, reject) => {
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
    }) as Promise<ProtocolMessage>;
}

const callbacks: Record<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }> = {};
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
    const generation = connectionGeneration;
    recordBytesReceived(data.byteLength);
    const message = await protocolInstance.parse(data);

    // Discard stale messages from previous connection instances (e.g., queued
    // onmessage events that arrived after disconnect or reconnect).
    if (generation !== connectionGeneration) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

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
    // Always reset stores regardless of ws state — onclose may not fire for failed connections
    disconnectStore();
    connected.set(false);
    if (hotlistInterval) clearInterval(hotlistInterval);
    hotlistInterval = null;
    if (hotlistDebounceTimer) {
        clearTimeout(hotlistDebounceTimer);
        hotlistDebounceTimer = null;
    }
    if (reconnectingTimer) {
        clearTimeout(reconnectingTimer);
        reconnectingTimer = null;
    }
    // Clear tracking sets and reset buffer state on disconnect
    pendingFetchBuffers.clear();
    bufferBottom.set(true);
    activeBufferId.set('');
    previousBufferId.set('');
    pendingBufferSwitch.set(null);

    connectionData = null;
    // Close ALL tracked WebSocket instances (including orphaned ones from previous connections)
    if (webSockets.size > 0) {
        const quitMsg = Protocol.formatQuit();
        for (const w of webSockets) {
            if (w.readyState === WebSocket.OPEN) sendWs(quitMsg, 'quit');
            w.close(1000, 'user disconnect');
        }
        webSockets.clear();
        ws = null;
    } else {
        // No active WebSockets — ensure stores are synchronized after failed/stale connection
        setConnectionStatus('disconnected');
    }
    // Clear unread counts, reset document title, and cancel notifications for all disconnect paths
    clearAllUnread();
    onDisconnect();
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
            handleNicklist(response, true);
        }
    } catch (err) {
        if (DEBUG_NICKLIST) console.error('[nicklist] request failed:', err);
    }
}

export async function fetchMoreLines(numLines: number = 0, explicitBufferId?: string): Promise<void> {
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

    let message: ProtocolMessage;
    try {
        const rawResponse = await new Promise<unknown>((resolve, reject) => {
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
        message = rawResponse as ProtocolMessage;
        // Re-read the buffer from the store after await. handleBufferLineAdded may have
        // created a new store copy during the async wait, so our captured reference is stale.
        const freshBuffer = getBuffer(bufferId);
        if (!freshBuffer) return;
        // Capture old line count before clearing, to correct lastSeen after handleLineInfo
        // increments it per-line (including injected date-change lines).
        const oldLength = freshBuffer.lines.length;
        // Pass clearLinesBufferId so handleLineInfo clears old lines atomically in its
        // immutable update, triggering Svelte reactivity for the backfilled content.
        handleLineInfo(message, true, bufferId);

        // After handleLineInfo's buffers.set(), do an immutable update to correct lastSeen
        // and set allLinesFetched — freshBuffer reference is now stale.
        const linesReceived = message.objects?.[0]?.content?.length ?? 0;
        buffers.update(current => {
            const buf = current[bufferId];
            if (!buf) return current;
            const updated = { ...buf, lines: [...buf.lines], nicklist: { ...buf.nicklist } };
            updated.lastSeen -= oldLength;
            if (linesReceived < numLines) {
                updated.allLinesFetched = true;
            }
            return { ...current, [bufferId]: updated };
        });
    } catch (err) {
        // Don't mark allLinesFetched=true for connection failures — those are transient.
        // Only give up on actual protocol errors (timeout, parse failure, etc.).
        const msg = String(err);
        if (msg.includes('WebSocket not open') || msg.includes('Connection closed')) {
            console.warn('[fetchMoreLines] connection lost during fetch, aborting');
            return;  // finally block handles pendingFetchBuffers cleanup
        }
        console.warn('[fetchMoreLines] fetch failed, marking allLinesFetched:', err);
        buffers.update(current => {
            const buf = current[bufferId];
            if (!buf) return current;
            return { ...current, [bufferId]: { ...buf, lines: [...buf.lines], allLinesFetched: true } };
        });
    } finally {
        pendingFetchBuffers.delete(bufferIdStr);
    }
}

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

// Debounce hotlist queries: coalesce rapid buffer switches into a single request.
let hotlistDebounceTimer: ReturnType<typeof setTimeout> | null = null;
const HOTLIST_DEBOUNCE_MS = 2000;

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
        scheduleHotlistQuery(bufferId);
    });
    // Nicklist backfill is handled by $effect in +page.svelte (guarded: only fetches if empty).
    return true;
}

// Schedule a hotlist query with debounce — resets timer on each call so rapid
// buffer switches coalesce into a single request after switching settles.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function scheduleHotlistQuery(_bufferId: string) {
    if (hotlistDebounceTimer) clearTimeout(hotlistDebounceTimer);
    hotlistDebounceTimer = setTimeout(() => {
        hotlistDebounceTimer = null;
        // Request authoritative current hotlist state from WeeChat to ensure
        // stale counts are cleared (e.g., after scroll-to-bottom).
        const hlMsg = Protocol.formatHdata({
            path: 'hotlist:gui_hotlist(*)',
            keys: []
        });
        sendAsync(hlMsg).catch(() => {});
    }, HOTLIST_DEBOUNCE_MS);
}

export function sendBufferCommand(bufferId: string, command: string) {
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
    // Return the most recently created open/connecting WebSocket, or the primary ws reference
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        return ws;
    }
    for (const w of webSockets) {
        if (w.readyState === WebSocket.OPEN || w.readyState === WebSocket.CONNECTING) {
            return w;
        }
    }
    return null;
}
