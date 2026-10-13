import { get } from 'svelte/store';
import { setConnectionStatus, setErrors, clearErrors, connectionState, recordBytesReceived, recordBytesSent, resetReconnectAttempts, beginSessionStats } from '#lib/stores/connectionStore.ts';
import { buffers, activeBufferId, getBuffer, connected, setActiveBuffer, beginSyncPhase, endSyncPhase, hasNoHistoryToFetch, markHistoryComplete } from '#lib/stores/models.ts';
import { handleVersionInfo, handleConfValue, handleBufferInfo, handleHotlistInfo, handleLineInfo, handleMessage, handleNicklist, flushLineBatch, setOnUpgrade, setOnUpgradeEnded } from '#lib/stores/handlers.ts';
import { addToast, removeToast, clearToasts, toastStore } from '#lib/toast.ts';

import { Protocol } from '#lib/weechat.ts';
import { sha256, pbkdf2 as nativePbkdf2, toHexString } from '#lib/utils/crypto.ts';
import type { ProtocolMessage } from '#lib/types.ts';
import {
    beginManualReconnect,
    cleanupFocusReconnect as sharedCleanupFocusReconnect,
    cancelPendingRetry,
    pendingRetryState,
    HANDSHAKE_TIMEOUT_MS,
    scheduleRetry,
    teardownAll,
    debounceHotlistQuery,
    resetAppState,
    showDisconnectToast as sharedShowDisconnectToast,
    startHotlistPoll,
    stopHotlistPoll,
    type ConnectionProfile,
    type PendingRetry,
    type TransportAdapter,
} from '#lib/stores/connectionLifecycle.ts';
import { DEBUG_NICKLIST, DEBUG_WEECHAT_COMMANDS, DEBUG_CONNECTION } from '#lib/debug.ts';
import { applyRetainedHandoff, markCaptureIntent } from '#lib/stores/retainedChat.ts';
import { clearHistoryOutcomes } from '#lib/stores/historyState.ts';

// Protocol instance for instance methods (setId, parse)
// Static methods (formatHandshake, formatInit, etc.) are called on the constructor directly
const protocolInstance = new Protocol();

// Track all WebSocket instances (including stale ones from previous connections)
// so that disconnect() can close them all — prevents orphaned connections.
const webSockets = new Set<WebSocket>();

/**
 * Decide the TOTP code to send in `init` from the handshake response.
 * A legacy relay reports totp:"on" when it requires a token; the user is
 * prompted interactively (the Angular client's flow). Cancel or empty input
 * sends no totp parameter — the server then rejects init, which surfaces as
 * an auth error instead of a silent hang.
 */
export function resolveTotpCode(
    content: Record<string, unknown> | undefined,
    promptFn: (message: string) => string | null = (msg) => window.prompt(msg),
): string | null {
    if (content?.totp !== 'on') return null;
    const code = promptFn('Please enter your TOTP Token');
    return code === null || code.trim() === '' ? null : code.trim();
}

let ws: WebSocket | null = null;

let connectionData: ConnectionProfile | null = null;
let connecting = false;
/**
 * The in-flight `connect()` promise's rejecter.
 *
 * A superseded attempt needs settling, not just ignoring: `connect()` closes the
 * sockets of an older attempt after bumping `connectionGeneration`, so those
 * handlers return early and their promise never settles — not a crash, just a
 * promise and every closure it holds, retained forever. `quiesce()` uses this to
 * settle it deliberately.
 */
let pendingConnectReject: ((e: Error) => void) | null = null;
// Armed per attempt. Module-level rather than a closure local so that every
// path which ends an attempt — a real close, an explicit teardown, a quiesce —
// can disarm it; a deadline left armed past its own attempt is a timer that
// closes a socket belonging to a later one.
let handshakeDeadlineTimer: ReturnType<typeof setTimeout> | null = null;

function clearHandshakeDeadline(): void {
    if (handshakeDeadlineTimer !== null) {
        clearTimeout(handshakeDeadlineTimer);
        handshakeDeadlineTimer = null;
    }
}
let manualReconnectRequested = false;
let connectionGeneration = 0;

/** Hotlist poll interval is shared configuration; re-exported so callers that
 * import this transport keep working unchanged. */
export { setHotlistPollInterval } from '#lib/stores/connectionLifecycle.ts';

// Comprehensive cleanup for any disconnection path.
// Clears all app state (buffers, servers, unread tracking, timers, callbacks).
// Does NOT touch connectionData (needed by scheduleReconnect / handleReconnectDecision)
// and does NOT set connection status (caller decides based on context).
//
// `retainGeneration` is passed only by unexpected-loss call sites, and only
// alongside a `markCaptureIntent()`. `disconnect()` and the retry-timer wipe pass
// neither, so a user-initiated departure and a retry of an already-retained
// session both capture nothing.
/** Test seam for the wipe itself, so a unit test can assert capture ORDER
 *  (drain, capture, wipe) against the real function instead of a
 *  reimplementation. Application code must not call this: the loss call site is
 *  `ws.onclose`, which also declares capture intent. */
export const __resetAllStateForTest = resetAllState;

function resetAllState(retainGeneration?: number) {
    // Flush any pending line batches before clearing state to avoid losing data.
    flushLineBatch();
    // Buffer ids are per-session and 4.10.1 reuses them, so a recorded history
    // outcome from this generation must not describe a buffer the next session
    // creates under the same id.
    clearHistoryOutcomes();

    // No hotlist baseline will arrive for a closed connection: never leave the sync
    // phase open across a disconnect.
    endSyncPhase();
    // Reject all pending callbacks
    Object.keys(callbacks).forEach(k => {
        const id = parseInt(k, 10);
        if (callbacks[id]) {
            callbacks[id].reject(new Error('Connection closed'));
        }
        delete callbacks[id];
    });
    connecting = false;
    cancelPendingRetry();
    stopHotlistPoll();
    pendingFetchBuffers.clear();
    // Everything above is transport teardown; this is the shared wipe, and it is
    // the last thing that runs because it destroys the stores.
    resetAppState(retainGeneration);
}

// Detect error type from close event for initial connection failures.
// Uses close codes to distinguish auth errors from server unreachable.
// Skips on user-initiated disconnect — no error to report.
function detectError(evt: CloseEvent): boolean {
    const state = get(connectionState);
    if (state.userDisconnect) return false;
    if (state.wasEverConnected) return false;
    if (evt.code === 403 || evt.code === 401) {
        setErrors({ passwordError: true });
        return true;
    }
    if (evt.code === 1006) {
        // The connection never completed. The browser does not expose why
        // (refused port, DNS, TLS, timeout) — it all arrives as 1006 — so
        // report the relay as unreachable rather than a password problem.
        // (This runs after resetAllState() in onclose, which is why the
        // "connecting" flag cannot distinguish the cases here.)
        setErrors({ serverUnreachable: true });
    }
    return false;
}

// Decide what a closed socket means for this transport.
// Handles user disconnect, first-connection failure, and a rejected credential.
// Everything after that — retry or terminal — is one decision in the shared
// scheduler, which also owns what the app says while it waits and what it says
// when it stops waiting. The TOTP veto used to live here; it belongs with the
// decision it modifies.
function handleReconnectDecision(evt: CloseEvent) {
    const state = get(connectionState);
    if (state.userDisconnect) {
        connectionData = null;
    } else if (!state.wasEverConnected) {
        // First connection failed — errors already set by detectError
    } else if (evt.code === 403 || evt.code === 401) {
        setErrors({ passwordError: true });
        if (connectionData) showDisconnectToast(connectionData);
    } else if (connectionData) {
        scheduleReconnect();
    }
}

/**
 * End an attempt this connection still owns.
 *
 * Shared by `onclose` and the handshake deadline: a session that died and a
 * handshake that never completed are different causes of the same state — an
 * attempt that will not produce a protocol response — and they must not end by
 * two different sequences. The retry decision in particular belongs to
 * `handleReconnectDecision()`, not to whichever path noticed the loss.
 */
function handleAttemptLoss(evt: CloseEvent): void {
    clearHandshakeDeadline();
    if (get(connectionState).wasEverConnected) markCaptureIntent();
    resetAllState(connectionGeneration);
    setConnectionStatus('disconnected');
    const shouldReject = detectError(evt);
    handleReconnectDecision(evt);
    if (shouldReject) {
        const reject = pendingConnectReject;
        pendingConnectReject = null;
        reject?.(new Error('Authentication failed'));
    }
}

export async function connect(profile: ConnectionProfile) {
    // Named destructuring, not positional: `host`/`path` are both strings and
    // `tls`/`noCompression` are both booleans, so the old 6-tuple signature let a
    // reordered call typecheck while connecting to the wrong thing.
    const { host, port, path, password, tls, noCompression } = profile;
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
    // This attempt is now the one the app describes. The counters start here so
    // they cover the whole session, bootstrap and history fetch included.
    beginSessionStats();

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
    connectionData = profile;
    setConnectionStatus('connecting');

    // Register upgrade callbacks so handlers can trigger disconnect/reconnect.
    setOnUpgrade(() => {
        for (const w of webSockets) {
            if (w.readyState === WebSocket.OPEN) w.close(1000, 'WeeChat upgrading');
        }
    });
    setOnUpgradeEnded(() => {
        const resumed = connectionData;
        if (resumed) {
            connect(resumed).catch((err) => {
                console.warn('[reconnect after upgrade] failed:', err.message);
                setErrors({ serverUnreachable: true });
            });
        }
    });

    return new Promise<void>((resolve, reject) => {
        // One module-level handle rather than a closure local: the deadline that
        // settles a hung attempt lives outside this promise's own scope.
        pendingConnectReject = reject;
        try {
            ws = new WebSocket(url);
            webSockets.add(ws);
        } catch (e) {
            connecting = false;
            pendingConnectReject = null;
            reject(e);
            return;
        }
        const genAtConnect = connectionGeneration;
        const thisWs = ws;
        ws.binaryType = 'arraybuffer';

        // The only thing that bounds a handshake. A relay that accepts the TCP
        // connection and never answers the WebSocket upgrade fires no `open` and
        // no `close`, so without this the attempt is pending forever: `connecting`
        // stays true, the status stays 'connecting', and the form's own Connect
        // button is disabled by that status.
        clearHandshakeDeadline();
        handshakeDeadlineTimer = setTimeout(() => {
            handshakeDeadlineTimer = null;
            // Defence in depth, not a reachable state today: `connect()` and
            // `quiesce()` both disarm this timer before any newer attempt exists,
            // so an armed deadline always belongs to the live attempt. The guard
            // is here because that is a property of the call graph, and call
            // graphs change.
            if (genAtConnect !== connectionGeneration) return;
            if (thisWs.readyState === WebSocket.OPEN || thisWs.readyState === WebSocket.CLOSED) return;

            // Silence the socket before closing it, the way `ApiSession.destroy()`
            // does. A browser is not obliged to deliver a close event for a socket
            // that never opened, so the attempt is settled here rather than
            // awaited from a handler that may not run.
            thisWs.onopen = null;
            thisWs.onmessage = null;
            thisWs.onclose = null;
            thisWs.onerror = null;
            thisWs.close();
            webSockets.delete(thisWs);
            if (ws === thisWs) ws = null;

            // The loss is reported as 1006 because that is what a handshake that
            // never completed is, and `detectError()` already names that code as
            // an unreachable relay. The socket is closed without a code of its
            // own — a code the relay never saw would be a claim nothing earned —
            // and whatever the browser then reports is irrelevant, because the
            // handlers are silenced above and this call carries the code.
            handleAttemptLoss({ code: 1006, reason: 'handshake timeout', wasClean: false } as CloseEvent);

            // `ConnectionForm` awaits `connect()` and only stores the profile when
            // it resolves. A deadline that merely closed the socket would leave
            // that await pending for the life of the page.
            const reject = pendingConnectReject;
            pendingConnectReject = null;
            reject?.(new Error(`Relay did not complete the WebSocket handshake within ${HANDSHAKE_TIMEOUT_MS / 1000}s`));
        }, HANDSHAKE_TIMEOUT_MS);

        ws.onopen = async () => {
            // If connect() was called again while this WebSocket was connecting,
            // connectionGeneration has changed and this handler is stale.
            if (genAtConnect !== connectionGeneration) {
                thisWs.close();
                return;
            }
            // The socket answered. From here the handshake is bounded by the
            // per-request timeouts, and a timer left armed past this point would
            // close a healthy connection ten seconds after it opened.
            clearHandshakeDeadline();
            connecting = true;
            // Sync phase, owned by this connection attempt: opened before anything is
            // requested, so it already covers the window in which WeeChat may push
            // replayed lines, and closed only once this attempt's hotlist baseline has
            // been applied (or the attempt ends). The token keeps a superseded attempt
            // from ending a newer connection's phase.
            const syncPhase = beginSyncPhase();
            // A response can resolve normally moments before this attempt is superseded
            // by a reconnect. Applying such a snapshot would write an old connection's
            // buffers and hotlist over a newer one's, so every state-applying step below
            // re-checks this instead of trusting that an awaited response is still fresh.
            const superseded = () => genAtConnect !== connectionGeneration;
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

                // TOTP is in-band on the legacy protocol (init totp=...), so a
                // browser CAN satisfy a TOTP-required relay — unlike the REST API
                // where the code needs a header WebSocket cannot set. Ask only
                // when the server requests it (same flow as the Angular version).
                const totpCode = resolveTotpCode(content);

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
                        await initializePBKDF2(password, nonce, iterations, 'SHA-512', totpCode);
                    } else {
                        // Server wants pbkdf2+sha512 but we only support sha256 variants natively → error
                        setErrors({ hashAlgorithmDisagree: true });
                        reject(new Error('Unsupported hash algorithm: pbkdf2+sha512 (needs crypto.subtle)'));
                        if (ws) ws.close(1000, 'Unsupported hash algorithm');
                        return;
                    }
                } else if (passwordMethod === 'pbkdf2+sha256') {
                    if (hasCryptoSubtle) {
                        await initializePBKDF2(password, nonce, iterations, 'SHA-256', totpCode);
                    } else {
                        await initializePBKDF2Native(password, nonce, iterations, totpCode);
                    }
                } else if (passwordMethod === 'sha256') {
                    if (hasCryptoSubtle) {
                        await initializeSHA(password, 'sha256', totpCode);
                    } else {
                        await initializeSHANative(password, totpCode);
                    }
                } else if (passwordMethod === 'sha512') {
                    if (hasCryptoSubtle) {
                        await initializeSHA(password, 'sha512', totpCode);
                    } else {
                        // No native SHA-512 — report error
                        setErrors({ hashAlgorithmDisagree: true });
                        reject(new Error('Unsupported hash algorithm: sha512 (needs crypto.subtle)'));
                        if (ws) ws.close(1000, 'Unsupported hash algorithm');
                        return;
                    }
                } else if (passwordMethod === 'plain') {
                    const initMsg = Protocol.formatInit('plain:' + password, totpCode);
                    // Fire-and-forget: WeeChat increments callback IDs so sendAsync would timeout
                    if (ws && ws.readyState === WebSocket.OPEN) {
                        sendWs(initMsg, 'init(plain)');
                    }
                    await new Promise(r => setTimeout(r, 5));
                } else if (!passwordMethod || passwordMethod === '') {
                    // Empty password_hash_algo = WeeChat using non-default algo (pbkdf2+sha256).
                    // Default to pbkdf2+sha256 when server doesn't explicitly report the algo.
                    if (hasCryptoSubtle) {
                        await initializePBKDF2(password, nonce, iterations, 'SHA-256', totpCode);
                    } else {
                        await initializePBKDF2Native(password, nonce, iterations, totpCode);
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

                // WeeChat's counts are not authoritative until the baseline below lands,
                // so real-time lines are not tallied locally while the phase is open.
                // Get buffer info
                const bufInfoMsg = Protocol.formatHdata({
                    path: 'buffer:gui_buffers(*)',
                    keys: ['local_variables,notify,number,full_name,short_name,title,hidden,type']
                });
                const bufInfoResponse = await sendAsync(bufInfoMsg);
                if (superseded()) throw new Error('connection superseded by a newer attempt');
                handleBufferInfo(bufInfoResponse);

                // Get hotlist
                const hotlistMsg = Protocol.formatHdata({
                    path: 'hotlist:gui_hotlist(*)',
                    keys: []
                });
                const hotlistResponse = await sendAsync(hotlistMsg);
                if (superseded()) throw new Error('connection superseded by a newer attempt');
                handleHotlistInfo(hotlistResponse);

                // Baseline applied: WeeChat's counts are authoritative from here on, so
                // local tallying of real-time lines resumes. History may still arrive
                // later; that is a per-buffer concern (readBoundaryKnown), not part of
                // this phase.
                endSyncPhase(syncPhase);

                // Get config values
                await fetchConfValue('weechat.look.buffer_time_format');
                await fetchConfValue('weechat.completion.nick_completer');
                await fetchConfValue('weechat.completion.nick_add_space');

                // Request sync (fire-and-forget, like AngularJS code)
                const syncMsg = Protocol.formatSync({});
                if (ws && ws.readyState === WebSocket.OPEN) {
                    sendWs(syncMsg, 'sync');
                }

                // Hand the retained window to this session before the view is told
                // the connection is live. The order is the point: `chatDisplay`
                // switches to live data at `connected`, so seeding after that
                // would show an empty transcript for a frame, and skipping it
                // altogether would leave a snapshot that reappears on the NEXT
                // loss with older content.
                applyRetainedHandoff();

                // Mark connected after buffer info + line loading complete
                setConnectionStatus('connected');
                connected.set(true);
                if (DEBUG_CONNECTION) console.log('[connect] connected=true, resolving promise');
                connectionState.update(current => ({ ...current, wasEverConnected: true, userDisconnect: false }));

                // Start hotlist sync interval — only if user enabled it in settings.
                // Keeps unread counts in sync with other clients or terminal usage directly.
                startHotlistPoll(() => {
                    void (async () => {
                        const hlMsg = Protocol.formatHdata({
                            path: 'hotlist:gui_hotlist(*)',
                            keys: []
                        });
                        const hlResp = await sendAsync(hlMsg);
                        handleHotlistInfo(hlResp);
                    })();
                });

                // Reset reconnect attempt counter on successful connection
                resetReconnectAttempts();
                cancelPendingRetry();
                // Clear stale disconnect toasts from previous connection cycle
                clearToasts();
                pendingConnectReject = null;
                resolve();
            } catch (e) {
                // Init ended without applying a hotlist baseline — this attempt closes
                // the phase it opened, so counters are not suppressed for a connection
                // that will never sync.
                endSyncPhase(syncPhase);
                if (superseded()) {
                    // A newer attempt owns the connection state now. Reporting an error or
                    // flipping `connected` here would describe this attempt, not the app.
                    if (DEBUG_CONNECTION) console.log('[connect] init abandoned: superseded by a newer attempt');
                    pendingConnectReject = null;
                    resolve();
                    return;
                }
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
            // onclose also fires for a first connect that never completed, so a
            // session must have reached its bootstrap before there is anything to
            // retain. The retry scheduler's wipe re-runs this loss path without
            // marking intent again: the loss is already retained, and a second
            // capture would snapshot the empty stores the first wipe left behind.
            handleAttemptLoss(evt);
        };

        ws.onerror = (evt) => {
            // The browser's WebSocket API does not expose the underlying failure
            // (refused port, TLS, timeout) — log the attempted URL so the line is
            // actionable.
            console.error(`Relay error: ${url}`, evt);
            setConnectionStatus('error');
            reject(new Error(`Connection failed: ${url}`));
        };
    });
}

// Compute PBKDF2 password hash using the specified SHA variant.
async function initializePBKDF2(password: string, nonce: Uint8Array, iterations: number, hashAlgo: 'SHA-512' | 'SHA-256' = 'SHA-512', totp: string | null = null) {
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
        totp
    );
    // Fire-and-forget: WeeChat increments callback IDs so sendAsync would timeout
    if (ws && ws.readyState === WebSocket.OPEN) {
        sendWs(initMsg, `init(pbkdf2+${algoLabel})`);
    }
    await new Promise(r => setTimeout(r, 5));
}

// Compute SHA-256 or SHA-512 password digest for authentication.
async function initializeSHA(password: string, method: 'sha256' | 'sha512', totp: string | null = null) {
    const data = new TextEncoder().encode(password);
    const hashBuffer = await crypto.subtle.digest(method.toUpperCase(), data);
    const hashHex = Array.from(new Uint8Array(hashBuffer))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');

    const initMsg = Protocol.formatInit(`${method}:${hashHex}`, totp);
    if (ws && ws.readyState === WebSocket.OPEN) {
        sendWs(initMsg, `init(${method})`);
    }
    await new Promise(r => setTimeout(r, 5));
}

// Native TypeScript SHA-256 fallback (no crypto.subtle required).
async function initializeSHANative(password: string, totp: string | null = null) {
    const data = new TextEncoder().encode(password);
    const hashHex = toHexString(sha256(data));

    const initMsg = Protocol.formatInit(`sha256:${hashHex}`, totp);
    if (ws && ws.readyState === WebSocket.OPEN) {
        sendWs(initMsg, 'init(sha256-native)');
    }
    await new Promise(r => setTimeout(r, 5));
}

// Native TypeScript PBKDF2-SHA256 fallback (no crypto.subtle required).
async function initializePBKDF2Native(password: string, nonce: Uint8Array, iterations: number, totp: string | null = null) {
    const passwordArray = new TextEncoder().encode(password);
    const clientNonce = crypto.getRandomValues(new Uint8Array(16));
    const salt = concatenateTypedArrays(nonce, new Uint8Array([0x3A]), clientNonce);

    const hashHexBytes = nativePbkdf2(passwordArray, salt, iterations, 32);
    const hashHex = toHexString(hashHexBytes);
    const saltHex = Array.from(salt).map(b => b.toString(16).padStart(2, '0')).join('');

    const initMsg = Protocol.formatInit(
        `pbkdf2+sha256:${saltHex}:${iterations}:${hashHex}`,
        totp
    );
    if (ws && ws.readyState === WebSocket.OPEN) {
        sendWs(initMsg, 'init(pbkdf2+sha256-native)');
    }
    await new Promise(r => setTimeout(r, 5));
}

// Show a persistent disconnect toast with reconnect button.
// Called from both disconnect handlers (restored WS and normal WS).
function showDisconnectToast(connInfo: ConnectionProfile) {
    sharedShowDisconnectToast(connInfo, () => triggerManualReconnect(false));
}

// Manual reconnect triggered by toast button — resets backoff timer and tries immediately.
function triggerManualReconnect(resetAttempts = false) {
    beginManualReconnect(connectionData!, resetAttempts);
    cancelPendingRetry();
    manualReconnectRequested = true;
    // Handled, not fire-and-forget: this attempt can fail, and an unhandled
    // rejection from a retry is noise in the console and nothing on screen.
    void connect(connectionData!).catch(() => undefined);
}

/** True while a handshake is in flight, so a second Retry click cannot stack a
 *  third attempt on top of one already running. False during the backoff wait
 *  between attempts — that is exactly when a retry is worth taking over. */
export function isAttemptInProgress(): boolean {
    return connecting;
}

// Initial delay before first reconnect attempt (ms)
// Schedule the next reconnect attempt with countdown toast.
// Uses exponential backoff starting at 30s, capped at 5 min. Retries indefinitely.
function scheduleReconnect() {
    if (!connectionData) return;

    // Captured, not re-read at fire time: the wipe the scheduler runs destroys the
    // stores, and a later profile change must not redirect an already-scheduled
    // attempt.
    const profile = connectionData;

    scheduleRetry(
        {
            profile,
            error: 'connection closed',
            // The transport's own loss path, not an approximation of it: the drain
            // and the protocol teardown are what make the shared wipe safe here.
            wipe: () => resetAllState(),
            // Handled for the same reason as the manual path, and this one is the
            // site that produced a real unhandled rejection: a scheduled retry whose
            // handshake failed had nobody listening for it.
            open: () => void connect(profile).catch(() => undefined),
        },
        () => triggerManualReconnect(false),
    );
}

function pendingRetry(): PendingRetry {
    return pendingRetryState();
}

/**
 * Cancel everything this transport might still do, without wiping app stores and
 * without claiming the user left.
 *
 * `disconnect()` is the wrong tool here: it marks `userDisconnect`, which makes
 * the shared retry classifier answer 'no-retry-loop' for the session that is
 * about to start, and it wipes the stores the new attempt is about to fill.
 */
function quiesce(): void {
    cancelPendingRetry();
    clearHandshakeDeadline();
    manualReconnectRequested = false;
    // The hotlist poll is shared now, and this is the path that would otherwise
    // leak it: bumping the generation makes the old socket's onclose return early,
    // skipping the resetAllState() that used to clear these timers.
    stopHotlistPoll();
    // Without a profile there is nothing for a stale timer to reconnect to, even
    // if something still holds a reference to it.
    connectionData = null;
    // Bump the generation BEFORE closing. Every handler on these sockets then sees
    // a superseded attempt and returns, instead of running the onclose path —
    // which would wipe app stores and arm a retry for a transport that has just
    // been replaced.
    connectionGeneration++;
    const reject = pendingConnectReject;
    pendingConnectReject = null;
    for (const w of webSockets) w.close(1000, 'superseded by another transport');
    webSockets.clear();
    ws = null;
    connecting = false;
    reject?.(new Error('Connection attempt superseded'));
}

/**
 * This transport's `TransportAdapter` — the lifecycle's view of it.
 *
 * Every method is a thin read of state this module already owns. Nothing here is
 * new behaviour; the point is that the shared layer can ask these questions
 * without knowing it is talking to the legacy relay.
 */
export const transportAdapter: TransportAdapter = {
    kind: 'legacy',
    open: (profile) => connect(profile),
    teardown: () => teardownSession(),
    hasLiveSession: () => ws !== null && ws.readyState === WebSocket.OPEN,
    isAttemptInProgress: () => connecting,
    // A captured profile is the whole retry loop for this transport: the armed
    // timer is what reconnects, and without a profile there is nothing to arm.
    hasRetryLoop: () => connectionData !== null,
    manualReconnect: (resetAttempts) => triggerManualReconnect(resetAttempts),
    pendingRetry,
    quiesce,
};

// Remove the visibilitychange listener (called on page unmount).
export const cleanupFocusReconnect = sharedCleanupFocusReconnect;

// Fetch a single WeeChat config option via infolist and update wconfig store.
export async function fetchConfValue(name: string) {
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
        bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
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
// Returns false when the socket could not accept the payload, so callers can tell a
// real send apart from a silent drop.
function sendWs(data: string | ArrayBuffer, label = ''): boolean {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        console.warn('[WS] send skipped — not open');
        return false;
    }
    if (DEBUG_WEECHAT_COMMANDS && data instanceof ArrayBuffer) {
        const text = new TextDecoder().decode(data);
        console.log('[WeeChatCmd] SEND', label || '(raw):', text.substring(0, 200));
    } else if (DEBUG_WEECHAT_COMMANDS && typeof data === 'string') {
        console.log('[WeeChatCmd] SEND', label || '(raw):', data.substring(0, 200));
    }
    const byteLength = typeof data === 'string' ? new Blob([data]).size : (data as ArrayBuffer).byteLength;
    try {
        ws.send(data);
    } catch (e) {
        // The socket state can change between the readyState check and the send.
        console.warn('[WS] send failed:', e);
        return false;
    }
    recordBytesSent(byteLength);
    return true;
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

// Deliver one line to the active buffer. Returns false when nothing was sent so the
// caller can keep the text instead of discarding it.
export function sendMessage(message: string): boolean {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        console.warn('[sendMessage] WebSocket not open');
        return false;
    }

    const bufferId = get(activeBufferId);
    if (!bufferId) {
        console.warn('[sendMessage] no active buffer ID');
        return false;
    }

    const buffer = getBuffer(bufferId);
    if (!buffer) {
        console.warn('[sendMessage] buffer not found for id:', bufferId);
        return false;
    }

    const msg = Protocol.formatInput({
        buffer: '0x' + buffer.id,
        data: message
    });
    return sendWs(msg, 'msg:' + buffer.shortName);
}

function teardownSession() {
    clearHandshakeDeadline();
    // `teardownAll()` has already marked this a user-initiated departure by the
    // time this runs — that is what keeps the onclose handler below from
    // auto-reconnecting. This function closes this transport's session; declaring
    // the connection-level outcome is not its job, and doing it here is how both
    // transports ended up wiping the app on a Leave.
    connectionData = null;
    // Close ALL tracked WebSocket instances (including orphaned ones from previous
    // connections). Local-only: this deliberately does NOT send /quit, matching
    // the rule the API transport states explicitly. Quitting WeeChat stays a
    // command the user types (InputBar gates /quit behind a confirm), never a
    // side effect of leaving.
    //
    // What the removed line actually did: `Protocol.formatQuit()` produced a bare
    // "quit\n", which is not part of the relay's client->command grammar (a
    // command reaches WeeChat as `input <buffer> <data>`, which is what
    // sendWeeChatCommand uses). Live probe: gbtest's WeeChat 4.10.1 logged the
    // client connect and disconnect with no command executed and no error, and
    // stayed up — so on 4.10.1 the frame was inert. It is still the wrong thing
    // to send on a Leave, and it read as if Leave quit WeeChat when it did not.
    if (webSockets.size > 0) {
        for (const w of webSockets) {
            w.close(1000, 'user disconnect');
        }
        webSockets.clear();
        ws = null;
    }
    // Clear all app state — buffers, servers, timers, callbacks, notifications.
    resetAllState();
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
            // fresh=true cleared and repopulated: the snapshot is authoritative.
            buffers.update((current) =>
                current[bufferId] ? { ...current, [bufferId]: { ...current[bufferId]!, nicklistFetched: true } } : current,
            );
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

    // Free buffers (/exec -nf, plugin output) have no older history — their rows
    // are live-only, so asking for history would re-deliver the current rows as
    // duplicates. Mark them complete instead of issuing a line request.
    if (hasNoHistoryToFetch(buffer)) {
        markHistoryComplete(bufferId);
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
        // handleLineInfo remaps a known boundary by stable line identity. If the
        // previous anchor is absent, it deliberately leaves the boundary unknown.
        // This avoids deriving a false position from hotlist totals or row counts.
        handleLineInfo(message, true, bufferId);

        const linesReceived = message.objects?.[0]?.content?.length ?? 0;
        buffers.update(current => {
            const buf = current[bufferId];
            if (!buf) return current;
            return {
                ...current,
                [bufferId]: {
                    ...buf,
                    allLinesFetched: linesReceived < numLines,
                },
            };
        });
    } catch (err) {
        // Don't mark allLinesFetched=true for any errors — they're transient.
        // Timeouts, protocol errors, connection drops should not permanently block
        // future fetch attempts. Only set allLinesFetched when WeeChat explicitly
        // returns fewer lines than requested (beginning of history reached).
        const msg = String(err);
        console.warn('[fetchMoreLines] fetch failed, will retry on next attempt:', msg);
    } finally {
        pendingFetchBuffers.delete(bufferIdStr);
    }
}

// Deliver one WeeChat command. Returns false when nothing was sent.
export function sendWeeChatCommand(command: string, bufferId?: string): boolean {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        console.warn('[sendWeeChatCommand] WebSocket not open');
        return false;
    }
    // Send command to core WeeChat buffer (0x0), or to a specific buffer if bufferId is provided
    const msg = Protocol.formatInput({
        buffer: bufferId ? '0x' + bufferId : '0x0',
        data: command
    });
    return sendWs(msg, 'cmd:' + command.substring(0, 50));
}

// Debounce hotlist queries: coalesce rapid buffer switches into a single request.


export async function switchBuffer(bufferId: string): Promise<boolean> {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        return false;
    }
    // Fetch lines for buffers that need historical context before switching.
    // Fetch if: lastSeen < 0 (never synced), or line count is very low (< 20)
    // meaning initial sync didn't load enough history for proper readmarker positioning.
    // Buffers with sufficient cached lines should not be refetched — that would
    // destroy the preserved lastSeen value and localUnread state.
    const buffer = getBuffer(bufferId);
    if (buffer && (buffer.lastSeen < 0 || buffer.lines.length < 20) && buffer.requestedLines < 100) {
        // Line identity, rather than an array offset, preserves a known boundary when
        // a switch fetch replaces the cached snapshot. An absent identity remains unknown.
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
        // See apiConnection.switchBuffer: `/buffer set unread` (no argument) leaves a real
        // marker id; the `/input set_unread_current_buffer` alias is deprecated since 3.8.
        sendWeeChatCommand('/buffer set unread', bufferId);
        scheduleHotlistQuery(bufferId);
    });
    // Nicklist backfill is handled by $effect in +page.svelte (guarded: only fetches if empty).
    return true;
}

// Schedule a hotlist query with debounce — resets timer on each call so rapid
// buffer switches coalesce into a single request after switching settles. The
// timer itself is shared; only the query is legacy's.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function scheduleHotlistQuery(_bufferId: string) {
    debounceHotlistQuery(() => {
        // Request authoritative current hotlist state from WeeChat to ensure
        // stale counts are cleared (e.g., after scroll-to-bottom).
        const hlMsg = Protocol.formatHdata({
            path: 'hotlist:gui_hotlist(*)',
            keys: []
        });
        sendAsync(hlMsg).catch(() => {});
    });
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

// Handle Vite HMR: when critical store modules are hot-reloaded, disconnect and
// auto-reconnect to preserve connection state (module-level variables reset on HMR).
if (import.meta.hot) {
    let hmrReconnecting = false;
    import.meta.hot.on('vite:beforeUpdate', (payload) => {
        if (hmrReconnecting) return;
        const criticalModules = ['connectionManager.ts', 'handlers.ts', 'models.ts'];
        const shouldReconnect = payload.updates?.some(u =>
            criticalModules.some(m => u.acceptedPath?.endsWith(m) || u.path?.endsWith(m))
        );
        if (!shouldReconnect) return;

        // Save connection params before disconnect clears them
        const savedData = connectionData;
        if (!savedData) return;

        hmrReconnecting = true;
        addToast('HMR detected — reconnecting...', { type: 'info', duration: 0 });
        const toastId = get(toastStore)[get(toastStore).length - 1]?.id;

        // The whole-connection teardown, not just this transport's: the HMR path
        // needs the same outcome a Leave produces — userDisconnect set and the
        // status written — before it reconnects onto the same profile.
        teardownAll();

        setTimeout(() => {
            connect(savedData!)
                .then(() => { if (toastId) removeToast(toastId); })
                // `.finally` does not swallow a rejection; without this the HMR
                // reconnect could reject into nobody.
                .catch(() => undefined)
                .finally(() => { hmrReconnecting = false; });
        }, 100);
    });
}
