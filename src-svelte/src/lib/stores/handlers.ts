import { get } from 'svelte/store';
import {
    buffers,
    servers,
    activeBufferId,
    previousBufferId,
    localUnreadBuffers,
    hotlistClearedBuffers,
    weechatVersion,
    wconfig,
    addBuffer,
    getBuffer,
    updateBuffer,
    updateBufferDeep,
    setActiveBuffer,
    createBuffer,
    createBufferLine,
    createNick,
    createNickGroup,
    parseRichText,
    removeBuffer,
    pendingBufferSwitch,
    setSyncing,
    isSyncing,
    maxBufferLines,
    deepCloneBufferLine
} from '$lib/stores/models';
import { lastBufferId, shouldResume } from '$lib/stores/bufferResume';
import { createHighlight, playNotificationSound, updateTitle, updateFavico } from '$lib/notifications';
import { DEBUG_NICKLIST, DEBUG_HANDLERS, DEBUG_HOTLIST } from '$lib/debug';
import type { ProtocolMessage, BufferMessage, BufferLineMessage, NickMessage, NickGroupMessage, HotlistEntry, BufferData, BufferType } from '$lib/types';

/**
 * Trims buffer lines to the given limit, adjusting lastSeen and requestedLines
 * to preserve readmarker position relative to visible content.
 */
function trimBufferLines(buffer: BufferData, limit: number) {
    if (buffer.lines.length <= limit) return;
    const linesToRemove = buffer.lines.length - limit;
    buffer.lines.splice(0, linesToRemove);
    buffer.requestedLines -= linesToRemove;
    buffer.lastSeen = Math.max(0, buffer.lastSeen - linesToRemove);
    buffer.lastSeen = Math.min(buffer.lastSeen, buffer.lines.length - 1);
    buffer.allLinesFetched = false;
}

// ---- Version handler ----
export function handleVersionInfo(message: ProtocolMessage) {
    const obj = message.objects[0];
    if (!obj) return;
    const content = obj.content;
    if (!content) return;
    // Info responses are of type "inf" with content { key, value }
    if (typeof content === 'object' && !Array.isArray(content) && 'value' in content) {
        const value = (content as { key: string; value: string }).value;
        if (typeof value === 'string' && value.length > 0) {
            const version = value.split('.').map((c: string) => parseInt(c, 10));
            if (DEBUG_HANDLERS) console.log('[version] WeeChat version:', value, version);
            weechatVersion.set(version);
            return;
        }
    }
    // Fallback for older/alternative response structures
    if (Array.isArray(content) && content.length > 0) {
        const first = content[0];
        if (!first) return;
        const value = first.value;
        if (typeof value === 'string' && value.length > 0) {
            const version = value.split('.').map((c: string) => parseInt(c, 10));
            if (DEBUG_HANDLERS) console.log('[version] WeeChat version:', value, version);
            weechatVersion.set(version);
        }
    }
}

// ---- Config handler ----
export function handleConfValue(message: ProtocolMessage) {
    const infolist = message.objects[0]?.content;
    if (!infolist) return;

    const config: Record<string, string> = {};
    for (const item of infolist) {
        // Each item is an array of key-value pairs that need to be merged into a single object
        const merged: Record<string, unknown> = {};
        for (const confitem of item) {
            Object.assign(merged, confitem);
        }
        if (merged.full_name) config[String(merged.full_name)] = String(merged.value || '');
    }
    wconfig.update(current => ({ ...current, ...config }));
}

// ---- Buffer info handler ----
export function handleBufferInfo(message: ProtocolMessage) {
    const bufferInfos = message.objects[0]?.content as BufferMessage[];
    if (!bufferInfos) return;

    console.debug('[handler] _buffer_info: buffers=' + bufferInfos.length);
    for (const b of bufferInfos) {
        console.debug('[handler]   buffer id=' + b.pointers[0] + ' short_name=' + b.short_name + ' type=' + b.type);
    }

    const currentBuffers = get(buffers);

    // Build working copies for mutation during the loop.
    // Only actually-modified buffers are published via buffers.update().
    // Pre-copy existing buffers so we can mutate them without touching the store.
    const workingBuffers: Record<string, BufferData> = {};
    for (const id in currentBuffers) {
        const buf = currentBuffers[id];
        if (buf) workingBuffers[id] = { ...buf };
    }

    // Mark that we're in initial sync phase — hotlist has arrived with unread
    // counts but lines haven't been synced yet. During sync, don't increment
    // lastSeen per-line; instead calculate it once after sync completes.
    setSyncing(true);

    // Track pending server unread adjustments for batch update.
    const serverDeltas: Record<string, number> = {};

    // Track whether any buffer was auto-resumed during this loop.
    // If so, skip the fallback (weechat core / first buffer) below.
    let resumed = false;

    for (const bufferMsg of bufferInfos) {
        const bufferId = bufferMsg.pointers[0];
        if (!bufferId) continue;
        if (workingBuffers[bufferId]) {
            // Update existing buffer — handleBufferUpdate returns partial data without mutating
            const updates = handleBufferUpdate(workingBuffers[bufferId], bufferMsg);
            // Clear existing lines on reconnect — sync events will repopulate.
            // Reset lastSeen/localUnread so the sync phase recalculates them
            // from hotlist counts (handleHotlistInfo runs after handleBufferInfo).
            workingBuffers[bufferId] = {
                ...workingBuffers[bufferId],
                ...updates,
                lines: [],
                requestedLines: 0,
                allLinesFetched: false,
                lastSeen: -1,
                localUnread: 0,
            };
        } else {
            // Create new buffer
            const buffer = createBuffer(bufferMsg);
            if (buffer.type === 'server') {
                // Register server
                const key = `${buffer.plugin}.${buffer.server}`;
                servers.update(current => ({
                    ...current,
                    [key]: { id: buffer.id, unread: 0 }
                }));
            } else {
                // Track server unread delta for batch apply after the loop.
                const serverKey = `${buffer.plugin}.${buffer.server}`;
                serverDeltas[serverKey] = (serverDeltas[serverKey] || 0) + buffer.unread + buffer.notification;
            }
            workingBuffers[bufferId] = buffer;
            console.debug('[handler]   created buffer:', buffer.id, buffer.shortName, 'lines=' + buffer.lines.length);

            // Auto-resume
            if (shouldResume(buffer.id)) {
                setActiveBuffer(buffer.id);
                resumed = true;
                console.debug('[handler]   auto-resumed to:', buffer.id);
            }
        }
    }

    // Apply pending server unread deltas immutably.
    if (Object.keys(serverDeltas).length > 0) {
        servers.update(current => {
            const next = { ...current };
            for (const [key, delta] of Object.entries(serverDeltas)) {
                const srv = next[key];
                if (srv) next[key] = { ...srv, unread: srv.unread + delta };
            }
            return next;
        });
    }

    // Check for resume on existing buffers too — on reconnect, buffers already
    // exist in the store so the per-buffer shouldResume check above was never hit.
    // Read directly from localStorage (same source as shouldResume) rather than
    // the store, because the store retains stale values preserved across disconnect.
    if (!resumed && typeof window !== 'undefined') {
        const savedId = localStorage.getItem('gb-last-buffer');
        if (savedId && workingBuffers[savedId]) {
            setActiveBuffer(savedId);
            lastBufferId.set(savedId);
            resumed = true;
            console.debug('[handler]   auto-resumed (existing buffer) to:', savedId);
        }
    }

    // Publish changed buffers to the store using update() to merge with
    // current state, preventing overwrites of concurrent changes from other
    // handlers (e.g., setActiveBuffer called during auto-resume above).
    const changedBuffers: Record<string, BufferData> = {};
    for (const id in workingBuffers) {
        const oldBuf = currentBuffers[id];
        const newBuf = workingBuffers[id];
        if (!newBuf) continue;
        // Always include newly-created buffers; skip unchanged existing ones.
        if (!oldBuf || newBuf !== oldBuf) {
            changedBuffers[id] = newBuf;
        }
    }
    if (Object.keys(changedBuffers).length > 0) {
        buffers.update(current => {
            const merged = { ...current };
            for (const id in changedBuffers) {
                if (changedBuffers[id]) merged[id] = changedBuffers[id];
            }
            return merged;
        });
    }

    // If no buffer was auto-resumed, prefer weechat.core before falling back to first buffer.
    if (resumed) return;
    let targetBufferId: string | null = null;
    const allBuffers = get(buffers);
    for (const id in allBuffers) {
        const buf = allBuffers[id];
        if (buf?.shortName === 'core' && buf?.plugin === 'weechat') {
            targetBufferId = id;
            break;
        }
    }
    if (!targetBufferId) {
        const bufferKeys = Object.keys(allBuffers);
        targetBufferId = bufferKeys[0] || null;
    }
    if (targetBufferId) {
        setActiveBuffer(targetBufferId);
    }
}

// ---- Buffer update handler ----
// Returns updated partial buffer data without mutating the original.
function handleBufferUpdate(buffer: BufferData, message: BufferMessage): Partial<BufferData> {
    if (message.pointers[0] !== buffer.id) return {};

    const shortName = message.short_name ?? buffer.shortName;
    const trimmedName = shortName.replace(/^[#&+]/, '') || (shortName ? ' ' : null);
    const prefix = ['#', '&', '+'].includes(shortName.charAt(0)) ? shortName.charAt(0) : '';
    const title = message.title && typeof message.title === 'string' ? parseRichText(message.title) : buffer.title;
    const number = message.number ?? buffer.number;
    const hidden = message.hidden !== undefined ? !!message.hidden : buffer.hidden;

    const bufferType = message.type !== undefined ? message.type : buffer.bufferType;
    const hideBufferLineTimes = bufferType === 1;

    // Merge local_variables map preserving existing entries not in this message.
    const localVariables = message.local_variables
        ? { ...(buffer.localVariables || {}), ...message.local_variables }
        : buffer.localVariables;
    const type = localVariables?.type as BufferType ?? buffer.type;
    const indent = ['channel', 'private'].includes(type);
    const plugin = localVariables?.plugin ?? buffer.plugin;
    const server = localVariables?.server ?? buffer.server;
    const pinned = localVariables?.pinned === 'true';
    const serverSortKey = `${plugin}.${server}${type === 'server' ? '' : '.' + shortName}`.toLowerCase();

    const notify = message.notify !== undefined ? message.notify : buffer.notify;

    return { shortName, trimmedName, prefix, title, number, hidden, bufferType, hideBufferLineTimes, localVariables, type, indent, plugin, server, pinned, serverSortKey, notify };
}

// ---- Buffer line added handler ----
/**
 * Strips remaining control codes (mIRC/WeeChat) that may leak through parsing
 * when input contains mixed-format codes (e.g., mIRC \x03 inside WeeChat \x19).
 */
// eslint-disable-next-line no-control-regex -- strips mIRC/WeeChat control bytes from parsed text
const stripControlCodes = (text: string) => text.replace(/[\x01-\x06\x0f\x16\x19-\x1f]/g, '');

/**
 * Strips WeeChat formatting codes from prefix and message for notification display.
 * Returns a plain-text body suitable for desktop notifications.
 */
function formatNotificationBody(lineMsg: BufferLineMessage): string {
    const prefixParts = parseRichText(lineMsg.prefix);
    const messageParts = parseRichText(lineMsg.message);
    const prefixText = stripControlCodes(prefixParts.map(p => p.text).join('')).trim();
    const msgText = stripControlCodes(messageParts.map(p => p.text).join(''));
    return prefixText ? `<${prefixText}> ${msgText}` : msgText;
}

// Builds immutable copies of affected buffers first, then mutates only those copies.
// This ensures Svelte's $derived($currentBuffer?.lines) sees a new array reference
// and triggers re-render, which is required for readmarker rendering to work.
export function handleBufferLineAdded(message: ProtocolMessage) {
    const lines = message.objects[0]?.content as BufferLineMessage[];
    if (!lines) {
        console.debug('[handler] _buffer_line_added: no content');
        return;
    }

    const currentBuffers = get(buffers);
    const activeId = get(activeBufferId);
    // Use Page Visibility API (same as AngularJS $rootScope.isWindowFocused).
    // document.hidden is more reliable than hasFocus() for detecting tab-inactive periods.
    const isWindowFocused = typeof document !== 'undefined' && !document.hidden;

    // Accumulate server unread deltas for batch-apply at the end.
    const serverDeltas: Record<string, number> = {};

    // First pass: identify all affected buffer IDs
    const affectedIds = new Set<string>();
    for (const lineMsg of lines) {
        affectedIds.add(lineMsg.buffer);
    }

    // Build immutable copies: deep-copy only affected buffers.
    // Unaffected buffers are NOT included — the merge via buffers.update()
    // will preserve whatever state they currently have in the store.
    const updatedBuffers: Record<string, BufferData> = {};
    for (const id of affectedIds) {
        const buf = currentBuffers[id];
        if (!buf) continue;
        updatedBuffers[id] = { ...buf, lines: buf.lines.map(deepCloneBufferLine), nicklist: { ...buf.nicklist }, localVariables: buf.localVariables ? { ...buf.localVariables } : undefined };
    }

    for (const lineMsg of lines) {
        let buffer = updatedBuffers[lineMsg.buffer];
        if (!buffer) {
            // Buffer not in our store yet (e.g., WeeChat auto-created query buffer for PM).
            // Extract nick from prefix (format: <nick> or <nick!user@host>) and delegate
            // to createBuffer so the construction logic lives in a single place.
            let inferredNick = '';
            const prefix = lineMsg.prefix || '';
            const nickMatch = prefix.match(/^<([^>]+)>/);
            if (nickMatch) {
                inferredNick = nickMatch[1]!;
            }
            if (DEBUG_HANDLERS) console.log('[handler] creating buffer for:', lineMsg.buffer, 'nick:', inferredNick, 'msg:', lineMsg.message?.substring(0, 50));

            buffer = createBuffer({
                pointers: [lineMsg.buffer],
                full_name: inferredNick,
                short_name: inferredNick,
                type: 2,
                notify: 3
            });
            updatedBuffers[lineMsg.buffer] = buffer;
        }

        if (!buffer) {
            console.warn('[handler] buffer unexpectedly undefined for:', lineMsg.buffer);
            continue;
        }

        const line = createBufferLine(lineMsg);
        buffer.requestedLines++;

          console.debug('[handler] line displayed=', line.displayed, 'buffer=', buffer.fullName, 'text=', line.text?.substring(0, 30), 'tags=', JSON.stringify(lineMsg.tags_array), 'notify=', buffer.notify);
        if (line.displayed) {
            // Check for date change and inject date change message
            if (buffer.lines.length > 0) {
                const lastLine = buffer.lines[buffer.lines.length - 1]!;
                const oldDate = new Date(lastLine.date);
                const newDate = new Date(line.date);
                injectDateChangeMessageIfNeeded(buffer, false, oldDate, newDate);
            }

            buffer.lines = [...buffer.lines, line];

            // During initial sync, don't increment lastSeen per-line.
            // Instead, calculate it once after sync completes using the
            // unread count from the hotlist that arrived before sync.
            if (isSyncing() && buffer.lastSeen < 0) {
                // Check if we've received enough lines to cover all unread.
                // unreadSum = message unread + private + highlights.
                // unread is index 1, notification is indices 2+3 combined.
                const unreadSum = buffer.unread + buffer.notification;
                if (buffer.lines.length > unreadSum && buffer.lastSeen < 0) {
                    buffer.lastSeen = buffer.lines.length - unreadSum - 1;
                    setSyncing(false);
                }
            }
            // For buffers with lastSeen already set (already synced), apply post-sync logic
            // even during syncing phase. Also applies when not syncing (normal operation).
            if (buffer.lastSeen >= 0 || !isSyncing()) {
                // Do NOT advance lastSeen for active buffer lines. Readmarker stays in place
                // until user explicitly scrolls to bottom (absorbed by ChatView effect) or
                // switches buffers. This preserves the readmarker through incoming messages.
                if (buffer.id === activeId) {
                    // New lines on active buffer accumulate as unread; lastSeen unchanged.
                } else if (buffer.id !== activeId && lineMsg.notify_level >= 1) {
                    // Track local unread count for real-time messages (notify_level >= 1)
                    // on inactive buffers. Backfill data (notify_level=0) is not counted,
                    // as it will be reconciled by hotlist sync.
                    buffer.localUnread = (buffer.localUnread || 0) + 1;
                    localUnreadBuffers.update((s: Set<string>) => new Set(s).add(buffer.id));
                }

                // Increment unread for real-time messages with notify_level=1 (message) only.
                // PMs/highlights (notify_level>=2) increment notification, not unread.
                // Only count as unread if the buffer's notify setting allows message-level notifications.
                // Suppress for the active buffer regardless of window focus (user is looking at it).
                if (buffer.notify > 1 && lineMsg.notify_level === 1 && buffer.id !== activeId) {
                    buffer.unread++;
                    const serverKey = `${buffer.plugin}.${buffer.server}`;
                    serverDeltas[serverKey] = (serverDeltas[serverKey] || 0) + 1;
                }

                // Increment notification count for highlights/privates (notify_level >= 2).
                // Requires buffer.notify != 0 and either a highlight or private message.
                if (lineMsg.notify_level >= 2 && buffer.id !== activeId) {
                    const isPrivate = buffer.type === 'private';
                    if (buffer.notify !== 0 && (lineMsg.highlight || isPrivate)) {
                        buffer.notification++;
                        const serverKey = `${buffer.plugin}.${buffer.server}`;
                        serverDeltas[serverKey] = (serverDeltas[serverKey] || 0) + 1;
                    }
                }

                // Fire notification indicators for any message where the buffer's
                // notify setting allows it. WeeChat notify levels: 0=none,
                // 1=message, 2=important, 3=highlight.
                // buffer.notify >= lineMsg.notify_level means this buffer is configured
                // to notify at this level or higher.
                if (buffer.notify >= lineMsg.notify_level && lineMsg.notify_level >= 1 && buffer.id !== activeId) {
                    // Always update passive indicators regardless of window focus —
                    // title and favicon badge are useful even when tab is visible.
                    updateTitle();
                    updateFavico();

                    // Desktop notifications (popup) fire only when window is not focused,
                    // to avoid spamming the user when they're already looking at the tab.
                    // Sound plays regardless of focus — it's a local audio cue.
                    const isHighlight = !!lineMsg.highlight;
                    const isPrivateMessage = lineMsg.tags_array.includes('notify_private');
                    if (buffer.notify !== 0 && (isHighlight || isPrivateMessage)) {
                        // Play notification sound for highlights/PMs regardless of window focus.
                        // Sound is a local audio cue that doesn't depend on tab visibility.
                        playNotificationSound();

                        // Desktop popup only when window is not focused
                        if (!isWindowFocused) {
                            // Strip WeeChat formatting codes from message/prefix for notification display
                            const notificationBody = formatNotificationBody(lineMsg);

                            // Trigger notification subsystem
                            createHighlight(buffer, notificationBody);
                        }
                    }
                }
            }
        }
    }

    // Update spokeAt timestamps for tab completion on the immutable copies
    handleNickMessageForSpeakOnBuffers(lines, updatedBuffers);

    // Trim lines exceeding memory limit on affected buffers
    const limit = get(maxBufferLines);
    for (const id of affectedIds) {
        const buf = updatedBuffers[id];
        if (buf) trimBufferLines(buf, limit);
    }

    // Apply server unread deltas immutably.
    if (Object.keys(serverDeltas).length > 0) {
        servers.update(current => {
            const next = { ...current };
            for (const [key, delta] of Object.entries(serverDeltas)) {
                const srv = next[key];
                if (srv) next[key] = { ...srv, unread: srv.unread + delta };
            }
            return next;
        });
    }

    // Update stores using update() to merge with current state.
    // This prevents overwriting concurrent changes from other handlers
    // that modified unaffected buffers between our snapshot and this write.
    console.debug('[handler] updating buffers store, total lines:', Object.values(updatedBuffers).reduce((sum: number, b: BufferData) => sum + b.lines.length, 0));
    buffers.update(current => {
        const merged = { ...current };
        for (const id in updatedBuffers) {
            if (updatedBuffers[id]) merged[id] = updatedBuffers[id];
        }
        return merged;
    });
}

// ---- Buffer line data changed handler ----
// WeeChat can edit existing message content (e.g., /nick, /mode changes, plugin edits).
// Find the matching line by (buffer, date) and replace its prefix/content in place.
export function handleBufferLineDataChanged(message: ProtocolMessage) {
    const lineMsg = message.objects?.[0]?.content?.[0] as BufferLineMessage | undefined;
    if (!lineMsg) {
        console.debug('[handler] _buffer_line_data_changed: no content');
        return;
    }

    const currentBuffers = get(buffers);
    const buffer = currentBuffers[lineMsg.buffer];
    if (!buffer) {
        console.debug('[handler] _buffer_line_data_changed: buffer not found for', lineMsg.buffer);
        return;
    }

    // Find matching line by (buffer, date). Multiple lines may share the same timestamp,
    // so prefer the last match (closest to bottom) since WeeChat processes top-to-bottom.
    const matches: number[] = [];
    for (let i = 0; i < buffer.lines.length; i++) {
        const line = buffer.lines[i];
        if (line && line.buffer === lineMsg.buffer && line.date === lineMsg.date) {
            matches.push(i);
        }
    }
    if (matches.length === 0) {
        console.debug('[handler] _buffer_line_data_changed: no matching line for date', lineMsg.date);
        return;
    }
        const matchedIndex = matches[matches.length - 1]!;

    // Create new BufferLine from updated data using createBufferLine for consistent
    // highlight class handling and RichTextPart processing.
    const updatedLine = createBufferLine(lineMsg);

    // Immutable update: clone lines array, replace at index, then update store.
    const updatedBuffer = { ...buffer, lines: buffer.lines.map(deepCloneBufferLine) };
    updatedBuffer.lines[matchedIndex] = updatedLine;
    // Use update() to merge with current store state, preventing overwrites
    // of concurrent changes from other handlers.
    buffers.update(current => ({ ...current, [lineMsg.buffer]: updatedBuffer }));
}

// ---- Buffer merged/unmerged handler ----
// Both _buffer_merged and _buffer_unmerged update the buffer number when
// a buffer joins or leaves another buffer's merge group. Shift intermediate
// buffers to fill the gap, using immutable updates for Svelte reactivity.
export function handleBufferMergedOrUnmerged(message: ProtocolMessage) {
    const obj = message.objects[0]?.content[0];
    if (!obj) return;
    const bufferId = obj.pointers?.[0];
    if (!bufferId) return;
    const buffer = getBuffer(bufferId);
    if (!buffer) return;

    const oldNumber = buffer.number;
    const newNumber = obj.number;
    if (oldNumber === newNumber) return;

    const current = get(buffers);
    const updated: Record<string, BufferData> = {};

    // Shift intermediate buffers to fill the gap left by the moved buffer.
    for (const id in current) {
        if (id === bufferId) continue;
        const buf = current[id];
        if (!buf) continue;
        let num = buf.number;
        if (newNumber > oldNumber && buf.number > oldNumber && buf.number <= newNumber) {
            num -= 1;
        } else if (newNumber < oldNumber && buf.number < oldNumber && buf.number >= newNumber) {
            num += 1;
        }
        if (num !== buf.number) {
            const shifted = updateBuffer(id, { number: num });
            if (shifted) updated[id] = shifted;
        }
    }

    // Set the merged/unmerged buffer's new number.
    const moved = updateBuffer(bufferId, { number: newNumber });
    if (moved) updated[bufferId] = moved;
    // Use update() to merge with current store state, preventing overwrites
    // of concurrent changes from other handlers.
    buffers.update(c => {
        const merged = { ...c };
        for (const id in updated) {
            if (updated[id]) merged[id] = updated[id];
        }
        return merged;
    });
}

// ---- Pong handler ----
// WeeChat echoes back ping arguments; log for debugging and future latency tracking.
export function handlePong(message: ProtocolMessage) {
    const data = message.objects[0]?.content?.[0];
    console.debug('[handler] _pong:', typeof data === 'string' ? data : JSON.stringify(data));
}

// ---- Upgrade handler ----
// WeeChat is starting an upgrade — all internal pointers will change.
// Calls the registered onUpgrade callback from connectionManager to disconnect cleanly.
let onUpgradeCallback: (() => void) | null = null;
export function setOnUpgrade(cb: (() => void) | null) {
    onUpgradeCallback = cb;
}
export function handleUpgrade() {
    if (DEBUG_HANDLERS) console.log('[handler] _upgrade: WeeChat upgrading, disconnecting');
    onUpgradeCallback?.();
}

// ---- Upgrade ended handler ----
// WeeChat has finished upgrading — attempt to reconnect via the registered callback.
let onUpgradeEndedCallback: (() => void) | null = null;
export function setOnUpgradeEnded(cb: (() => void) | null) {
    onUpgradeEndedCallback = cb;
}
let upgradeReconnectTimer: ReturnType<typeof setTimeout> | null = null;
export function handleUpgradeEnded() {
    if (DEBUG_HANDLERS) console.log('[handler] _upgrade_ended: WeeChat upgrade complete, reconnecting');
    if (upgradeReconnectTimer) clearTimeout(upgradeReconnectTimer);
    upgradeReconnectTimer = setTimeout(() => {
        upgradeReconnectTimer = null;
        onUpgradeEndedCallback?.();
    }, 2000);
}

// ---- Date change injection ----
export function injectDateChangeMessageIfNeeded(buffer: BufferData, manually: boolean, oldDate: Date, newDate: Date) {
    if (buffer.bufferType === 1) return; // Free buffers

    oldDate.setHours(0, 0, 0, 0);
    newDate.setHours(0, 0, 0, 0);

    if (oldDate.valueOf() === newDate.valueOf()) return;

    if (manually) ++buffer.lastSeen;

    const datePlusOne = new Date(oldDate.getTime());
    datePlusOne.setDate(datePlusOne.getDate() + 1);
    datePlusOne.setHours(0, 0, 0, 0);

    let content = `\u001943\u2500`; // Day change color (code 43 = chat_day_change) + box drawing

    // Add day of week
    const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    content += weekdays[newDate.getDay()] + ' (';
    content += newDate.toLocaleDateString(undefined, { month: 'long', day: 'numeric' });

    if (newDate.getFullYear() !== oldDate.getFullYear()) {
        content += `, ${newDate.getFullYear()}`;
    }

    if (datePlusOne.valueOf() !== newDate.valueOf()) {
        const diff = Math.round((newDate.getTime() - oldDate.getTime()) / (24 * 60 * 60 * 1000)) + 1;
        if (diff < 0) {
            content += `, ${Math.abs(diff)} days before`;
        } else {
            content += `, ${diff} days later`;
        }
    }

    content += ')';

    const dateLine = createBufferLine({
        buffer: buffer.id,
        date: newDate.getTime(),
        date_long: 0,
        prefix: '\u001943\u2500',
        message: content,
        tags_array: [],
        displayed: 1,
        highlight: 0
    });

    buffer.lines.push(dateLine);
}

// ---- Buffer opened handler ----
export function handleBufferOpened(message: ProtocolMessage) {
    const bufferMsg = message.objects[0]?.content[0] as BufferMessage;
    if (!bufferMsg) return;

    const buffer = createBuffer(bufferMsg);
    if (buffer.type === 'server') {
        const key = `${buffer.plugin}.${buffer.server}`;
        servers.update(current => ({
            ...current,
            [key]: { id: buffer.id, unread: 0 }
        }));
    } else {
        const serverKey = `${buffer.plugin}.${buffer.server}`;
        const delta = buffer.unread + buffer.notification;
        if (delta > 0) {
            servers.update(current => {
                const server = current[serverKey];
                if (!server) return current;
                return { ...current, [serverKey]: { ...server, unread: server.unread + delta } };
            });
        }
    }
    addBuffer(buffer);

    // Check if this buffer matches a pending switch request from nicklist click
    const targetNick = get(pendingBufferSwitch) as string | null;
    if (targetNick && (buffer.shortName.toLowerCase() === targetNick.toLowerCase())) {
        if (DEBUG_HANDLERS) console.log('[handler] auto-switching to query buffer for:', targetNick);
        setActiveBuffer(buffer.id);
        pendingBufferSwitch.set(null);
    }
}

// ---- Buffer title changed ----
// Update buffer metadata immutably to trigger Svelte reactivity.
export function handleBufferTitleChanged(message: ProtocolMessage) {
    const obj = message.objects[0]?.content[0];
    if (!obj) return;
    const bufferId = obj.pointers[0];
    const updated = updateBuffer(bufferId, {
        fullName: obj.full_name,
        title: obj.title ? parseRichText(obj.title) : undefined,
        number: obj.number,
    });
    if (!updated) return;
    // Use update() to merge with current store state, preventing overwrites
    // of concurrent changes from other handlers.
    buffers.update(current => ({ ...current, [bufferId]: updated }));
}

// ---- Buffer renamed ----
// Update buffer name fields immutably to trigger Svelte reactivity.
export function handleBufferRenamed(message: ProtocolMessage) {
    const obj = message.objects[0]?.content[0];
    if (!obj) return;
    const bufferId = obj.pointers[0];
    const updated = updateBuffer(bufferId, {
        fullName: obj.full_name,
        shortName: obj.short_name,
        trimmedName: obj.short_name.replace(/^[#&+]/, '') || (obj.short_name ? ' ' : null),
        prefix: ['#', '&', '+'].includes(obj.short_name.charAt(0)) ? obj.short_name.charAt(0) : '',
    });
    if (!updated) return;
    // Use update() to merge with current store state, preventing overwrites
    // of concurrent changes from other handlers.
    buffers.update(current => ({ ...current, [bufferId]: updated }));
}

// ---- Buffer hidden/unhidden ----
// Toggle buffer.hidden immutably to trigger Svelte reactivity.
export function handleBufferHidden(message: ProtocolMessage) {
    const obj = message.objects[0]?.content[0];
    if (!obj) return;
    const updated = updateBuffer(obj.pointers[0], { hidden: true });
    if (!updated) return;
    // Use update() to merge with current store state, preventing overwrites
    // of concurrent changes from other handlers.
    buffers.update(current => ({ ...current, [obj.pointers[0]]: updated }));
}

export function handleBufferUnhidden(message: ProtocolMessage) {
    const obj = message.objects[0]?.content[0];
    if (!obj) return;
    const updated = updateBuffer(obj.pointers[0], { hidden: false });
    if (!updated) return;
    // Use update() to merge with current store state, preventing overwrites
    // of concurrent changes from other handlers.
    buffers.update(current => ({ ...current, [obj.pointers[0]]: updated }));
}

// ---- Buffer moved ----
// Adjust all buffer numbers when a buffer changes position,
// shifting intermediate buffers to fill the gap, using immutable updates.
export function handleBufferMoved(message: ProtocolMessage) {
    const obj = message.objects[0]?.content[0];
    if (!obj) return;
    const bufferId = obj.pointers[0];
    const buffer = getBuffer(bufferId);
    if (!buffer) return;

    const oldNumber = buffer.number;
    const newNumber = obj.number;
    if (oldNumber === newNumber) return;

    const current = get(buffers);
    const updated: Record<string, BufferData> = {};

    // Shift intermediate buffers to fill the gap left by the moved buffer.
    for (const id in current) {
        if (id === bufferId) continue;
        const buf = current[id];
        if (!buf) continue;
        let newNum = buf.number;
        if (newNumber > oldNumber && buf.number > oldNumber && buf.number <= newNumber) {
            newNum -= 1;
        } else if (newNumber < oldNumber && buf.number < oldNumber && buf.number >= newNumber) {
            newNum += 1;
        }
        if (newNum !== buf.number) {
            const shifted = updateBuffer(id, { number: newNum });
            if (shifted) updated[id] = shifted;
        }
    }

    // Set the moved buffer's new number.
    const moved = updateBuffer(bufferId, { number: newNumber });
    if (moved) updated[bufferId] = moved;
    // Use update() to merge with current store state, preventing overwrites
    // of concurrent changes from other handlers.
    buffers.update(c => {
        const merged = { ...c };
        for (const id in updated) {
            if (updated[id]) merged[id] = updated[id];
        }
        return merged;
    });
}

// ---- Buffer local var changed ----
// Update buffer type/plugin/server/pinned fields immutably to trigger Svelte reactivity.
export function handleBufferLocalvarChanged(message: ProtocolMessage) {
    const obj = message.objects[0]?.content[0];
    if (!obj) return;
    const bufferId = obj.pointers[0];
    const buffer = getBuffer(bufferId);
    if (!buffer || !obj.local_variables) return;

    const lv = obj.local_variables;
    const type = lv.type || buffer.type;
    const plugin = lv.plugin || buffer.plugin;
    const server = lv.server || buffer.server;
    const pinned = lv.pinned === 'true';
    const indent = ['channel', 'private'].includes(type);
    const serverSortKey = `${plugin}.${server}${type === 'server' ? '' : '.' + buffer.shortName}`.toLowerCase();

    // Merge new local vars into existing map, preserving existing entries not in this message.
    const mergedLocalVars = { ...(buffer.localVariables || {}), ...lv };

    const updated = updateBuffer(bufferId, { type, indent, plugin, server, serverSortKey, pinned, localVariables: mergedLocalVars });
    if (!updated) return;
    // Use update() to merge with current store state, preventing overwrites
    // of concurrent changes from other handlers.
    buffers.update(current => ({ ...current, [bufferId]: updated }));
}

// ---- Buffer cleared ----
// Clear lines and requestedLines immutably using deep copy for the lines array.
export function handleBufferCleared(message: ProtocolMessage) {
    const bufferMsg = message.objects[0]?.content[0];
    if (!bufferMsg) return;
    const bufferId = bufferMsg.pointers[0];
    const updated = updateBufferDeep(bufferId, { lines: [], requestedLines: 0 });
    if (!updated) return;
    // Use update() to merge with current store state, preventing overwrites
    // of concurrent changes from other handlers.
    buffers.update(current => ({ ...current, [bufferId]: updated }));
}

// ---- Buffer closing ----
export function handleBufferClosing(message: ProtocolMessage) {
    const bufferMsg = message.objects[0]?.content[0];
    if (!bufferMsg) return;
    const bufferId = bufferMsg.pointers[0];

    const currentBuffers = get(buffers);
    removeBuffer(bufferId, !!currentBuffers[bufferId]?.active);
}

// ---- Hotlist handler ----
export function handleHotlistInfo(message: ProtocolMessage) {
    const currentBuffers = get(buffers);
    const activeId = get(activeBufferId);
    const previousId = get(previousBufferId);
    const currentServers = get(servers);
    const hotlistCleared = get(hotlistClearedBuffers);

    const hotlist = message.objects[0]?.content as HotlistEntry[];
    if (!hotlist) return;

    if (DEBUG_HOTLIST) {
        console.table(hotlist.map(entry => ({
            buffer: entry.buffer,
            shortName: currentBuffers[entry.buffer]?.shortName || entry.buffer,
            unread: entry.count[1],
            highlight: entry.count[2],
            private: entry.count[3],
        })));
    }

    // Build immutable copies of affected buffers and servers to ensure
    // Svelte reactivity triggers correctly when unread counts change.
    // Skip active and previous buffers — they are managed separately by
    // setActiveBuffer and should not be overwritten by hotlist data.
    const updatedBuffers = {} as Record<string, BufferData>;
    const updatedServers = { ...currentServers };

    for (const id in currentBuffers) {
        if (id === activeId || id === previousId) continue;
        const buf = currentBuffers[id];
        if (buf) {
            updatedBuffers[id] = { ...buf };
        }
    }

    // Only reset unread/notification counts for buffers that appear in the hotlist.
    // Buffers not in the hotlist keep their existing counts — this preserves locally-tracked
    // unreads (from handleBufferLineAdded) for buffers where WeeChat hasn't reported activity
    // since the last sync. Resetting all buffers would wipe valid local state.
    // Skip the previous buffer — its unread counts were optimistically cleared by
    // setActiveBuffer, and stale hotlist data hasn't been processed by WeeChat yet.
    // Also skip the active buffer since it's managed separately.
    // Also skip buffers with any non-zero counts (unread, notification, or localUnread) —
    // these represent real-time messages received since the last sync that may not yet
    // be reflected in WeeChat's hotlist. Stale hotlist entries from prior activity
    // should not overwrite correct local counts.
    const hotlistBufferIds = new Set(hotlist.map(e => e.buffer));
    // Re-read current store state to check guards against fresh data,
    // since other handlers may have updated buffers between our initial snapshot
    // and this point.
    const freshBuffers = get(buffers);
    for (const id of hotlistBufferIds) {
        if (id === activeId || id === previousId) continue;
        const freshBuf = freshBuffers[id];
        if (!freshBuf) continue;
        if ((freshBuf.unread || 0) + (freshBuf.notification || 0) + (freshBuf.localUnread || 0) > 0) continue;

        const buf = updatedBuffers[id];
        if (!buf) continue;
        buf.unread = 0;
        buf.notification = 0;
    }

    // Reset all server unread totals before recalculating from hotlist entries.
    for (const key in updatedServers) {
        const srv = updatedServers[key];
        if (srv) srv.unread = 0;
    }

    for (const entry of hotlist) {
        if (entry.buffer === activeId || entry.buffer === previousId) continue;

        // Skip merge for buffers whose hotlist was recently cleared by setActiveBuffer.
        // WeeChat may not have processed the clear command yet, so its data is stale.
        // This prevents unread counts from reappearing during rapid buffer switching.
        if (hotlistCleared.has(entry.buffer)) continue;

        // Read fresh state from store for accurate merging.
        // Our snapshot may be stale if other handlers updated this buffer.
        const freshBuf = freshBuffers[entry.buffer];
        if (!freshBuf) continue;

        // Skip buffers with real-time unreads — their local state is more accurate
        // than stale hotlist data. Don't include them in updatedBuffers so the merge
        // preserves their current store state (including lastSeen).
        const hasFreshUnreads = (freshBuf.unread || 0) + (freshBuf.notification || 0) + (freshBuf.localUnread || 0) > 0;
        if (hasFreshUnreads) continue;

        // Build working copy from fresh data, not stale snapshot.
        const buffer = { ...freshBuf };
        updatedBuffers[entry.buffer] = buffer;

        // Merge WeeChat hotlist counts with locally-tracked counts.
        // Use Math.max to preserve optimistic local increments that haven't
        // been acknowledged by WeeChat's hotlist yet.
        const hotlistUnread = entry.count[1] || 0;
        const hotlistNotif = (entry.count[2] || 0) + (entry.count[3] || 0);
        buffer.unread = Math.max(buffer.unread, hotlistUnread);
        buffer.notification = Math.max(buffer.notification, hotlistNotif);
        // Only calculate lastSeen if buffer has lines and no local unreads tracked.
        // Buffers with localUnread > 0 have more accurate local data than stale WeeChat hotlist.
        const freshLocalUnread = get(localUnreadBuffers);
        if (buffer.lines.length > 0 && !freshLocalUnread.has(entry.buffer)) {
            const totalUnread = buffer.unread + buffer.notification;
            buffer.lastSeen = buffer.lines.length - 1 - totalUnread;
        }

        // Clean up cleared set once WeeChat confirms zero counts for this buffer.
        if (hotlistUnread === 0 && hotlistNotif === 0) {
            hotlistClearedBuffers.update(s => { const copy = new Set(s); copy.delete(entry.buffer); return copy; });
        }

        const serverKey = `${buffer.plugin}.${buffer.server}`;
        const server = updatedServers[serverKey];
        if (server) {
            server.unread += buffer.unread + buffer.notification;
        }
    }

    // Use update() instead of set() to merge with current store state.
    // This prevents overwriting concurrent changes from other handlers
    // (e.g., handleBufferLineAdded) that modified buffers between our
    // initial get(buffers) snapshot and this final write.
    buffers.update(current => {
        // Start with the live store state, then overlay our hotlist-derived changes.
        const merged = { ...current };
        for (const id in updatedBuffers) {
            if (updatedBuffers[id]) merged[id] = updatedBuffers[id];
        }
        return merged;
    });
    servers.set(updatedServers);
}

// ---- Nicklist handler ----
// Clear nicklist for a buffer, preserving only root group.
function clearBufferNicklist(bufferId: string) {
    const buffer = getBuffer(bufferId);
    if (buffer) {
        if (DEBUG_NICKLIST) console.log('[nicklist] clearing nicklist for buffer:', bufferId);
        buffer.nicklist = { root: buffer.nicklist.root || { name: '', visible: '', nicks: [] } };
    }
}

export function handleNicklist(message: ProtocolMessage, fresh?: boolean) {
    const nicklist = message.objects[0]?.content as (NickMessage | NickGroupMessage)[];
    if (DEBUG_NICKLIST) console.log('[nicklist] handleNicklist called, total items:', nicklist?.length ?? 0, 'fresh:', !!fresh);
    if (!nicklist) return;

    // For explicit fetches or WeeChat-sent clears, reset before populating
    if (fresh || nicklist.length === 1) {
        const affected = new Set<string>();
        for (const item of nicklist) {
            const ptr = item.pointers?.[0];
            if (ptr) affected.add(ptr);
        }
        for (const bid of affected) {
            clearBufferNicklist(bid);
        }
    }

    let group = 'root';
    const modifiedBuffers = new Set<string>();
    for (const n of nicklist) {
        const ptr0 = n.pointers[0];
        if (!ptr0) continue;
        const buffer = getBuffer(ptr0);
        if (!buffer) {
            if (DEBUG_NICKLIST) console.log('[nicklist] buffer not found for ID:', ptr0);
            continue;
        }
        if (DEBUG_NICKLIST) console.log('[nicklist] processing item for buffer', buffer.shortName || buffer.id, '- pointers:', JSON.stringify(n.pointers));
        // Ensure root group always exists for hasData check
        if (!('root' in buffer.nicklist)) {
            buffer.nicklist.root = { name: '', visible: '', nicks: [] };
            if (DEBUG_NICKLIST) console.log('[nicklist] created root group for', buffer.shortName);
        }

        if ((n as NickGroupMessage).group === 1) {
            const g = createNickGroup(n as NickGroupMessage);
            group = g.name;
            buffer.nicklist[group] = g;
            if (DEBUG_NICKLIST) console.log('[nicklist] added group', group, 'to', buffer.shortName, '- visible:', g.visible);
        } else {
            const nick = createNick(n as NickMessage);
            if (DEBUG_NICKLIST) console.log('[nicklist] adding nick', nick.name, 'with prefix', nick.prefix, 'to group', group, 'in buffer', buffer.shortName);
            const nickGroup = buffer.nicklist[group];
            if (nickGroup) {
                nickGroup.nicks.push(nick);
            } else {
                if (DEBUG_NICKLIST) console.log('[nicklist] WARNING: no group', group, 'found for nick', nick.name);
            }
        }
        modifiedBuffers.add(ptr0);
    }

    // Create new references only for affected buffers to trigger reactivity.
    // Only include modified buffers — unaffected buffers are preserved by buffers.update().
    const current = get(buffers);

    // Log final nicklist structure
    if (DEBUG_NICKLIST) {
        const summary = [];
        for (const id of modifiedBuffers) {
            const buf = current[id];
            if (buf) {
                const groups = Object.keys(buf.nicklist || {});
                const nickCounts = groups.map(g => `${g}:${(buf.nicklist?.[g]?.nicks?.length ?? 0)}`).join(', ');
                summary.push({ buffer: buf.shortName, groups: groups.join(', '), nicks: nickCounts });
            }
        }
        console.table(summary);
    }

    const updated: Record<string, BufferData> = {};
    for (const id of modifiedBuffers) {
        const deep = updateBufferDeep(id);
        if (deep) updated[id] = deep;
    }
    if (DEBUG_NICKLIST) console.log('[nicklist] updating buffers store with', modifiedBuffers.size, 'modified buffer(s)');
    // Use update() to merge with current store state, preventing overwrites
    // of concurrent changes from other handlers.
    buffers.update(c => {
        const merged = { ...c };
        for (const id in updated) {
            if (updated[id]) merged[id] = updated[id];
        }
        return merged;
    });
}

// ---- Update nick spokeAt timestamp for tab completion ----
// Extracts the nick from a message's prefix or text, then updates spokeAt
// on the matching nick within a single buffer's nicklist.
function updateNickSpokeAtInBuffer(buffer: BufferData, lineMsg: BufferLineMessage, now: number) {
    const line = createBufferLine(lineMsg);
    const prefix = line.prefix;
    if (prefix.length === 0) return;

    let nick = '';

    // Try to find nick from the last element of the prefix rich text
    const lastPart = prefix[prefix.length - 1];
    if (lastPart && lastPart.text) {
        nick = lastPart.text;
    }

    // Action /me: find the nick as the first word of the message
    if (nick === " *" || nick === '') {
        const match = line.text.match(/^(.+)\s/);
        if (match && match[1]) {
            nick = match[1];
        }
    }

    if (!nick || nick === "" || nick === "=!=") return;

    // Only search this specific buffer's nicklist — O(n) where n = nicks in
    // one buffer instead of O(all nicks across all buffers).
    if (!buffer.nicklist) return;
    for (const groupIdx in buffer.nicklist) {
        const groupObj = buffer.nicklist[groupIdx];
        if (!groupObj) continue;
        for (const curr_nick of groupObj.nicks) {
            if (curr_nick.name === nick) {
                curr_nick.spokeAt = now;
                break;
            }
        }
    }
}

// Updates spokeAt timestamps on pre-built buffer copies (for immutable updates).
// Each line message is matched to its buffer and only that buffer's nicklist is searched.
export function handleNickMessageForSpeakOnBuffers(lineMsgs: BufferLineMessage[], updatedBuffers: Record<string, BufferData>) {
    const now = Date.now();
    for (const lineMsg of lineMsgs) {
        const buffer = updatedBuffers[lineMsg.buffer];
        if (!buffer) continue;
        updateNickSpokeAtInBuffer(buffer, lineMsg, now);
    }
}

// ---- Nicklist diff handler ----
// Handles incremental nicklist changes from WeeChat (_nicklist_diff event).
// Operations: _diff=43 (+ add), 45 (- remove), 42 (* update).
// Same sequential group-tracking pattern as handleNicklist, but resets group
// when switching buffers to avoid leaking group names across buffers.
export function handleNicklistDiff(message: ProtocolMessage) {
    const nicklist = message.objects[0]?.content as (NickMessage | NickGroupMessage)[];
    if (DEBUG_NICKLIST) console.log('[nicklist] handleNicklistDiff called, total items:', nicklist?.length ?? 0);
    if (!nicklist) return;

    // Log nick count per affected buffer before applying diff
    if (DEBUG_NICKLIST) {
        const affectedBufferIds = new Set<string>();
        for (const item of nicklist) {
            const ptr = item.pointers?.[0];
            if (ptr) affectedBufferIds.add(ptr);
        }
        const store = get(buffers);
        for (const bid of affectedBufferIds) {
            const buf = store[bid];
            const count = buf ? Object.values(buf.nicklist).reduce((s, g) => s + g.nicks.length, 0) : -1;
            console.log('[nicklist] BEFORE diff:', buf?.shortName || bid, '- nicks:', count);
        }
    }

    // Track current group per buffer — WeeChat sends items ordered by buffer then group
    // Reset to 'root' whenever we switch to a different buffer
    let currentBufferId: string | null = null;
    let group = 'root';
    const modifiedBuffers = new Set<string>();

    for (const n of nicklist) {
        const ptr0 = n.pointers[0];
        if (!ptr0) continue;
        const buffer = getBuffer(ptr0);
        if (!buffer) {
            if (DEBUG_NICKLIST) console.log('[nicklist] buffer not found for diff:', ptr0);
            continue;
        }

        // Reset group tracking when switching between buffers in the same message
        if (currentBufferId !== ptr0) {
            group = 'root';
            currentBufferId = ptr0;
        }

        // Skip diffs for buffers that haven't had their nicklist requested yet.
        // Mirrors AngularJS's addNick/delNick/updateNick guard on nicklistRequested().
        if (!('root' in buffer.nicklist)) {
            if (DEBUG_NICKLIST) console.log('[nicklist] skipping diff for', buffer.shortName || buffer.id, '- nicklist not requested');
            continue;
        }

        if (DEBUG_NICKLIST) console.log('[nicklist] processing diff item for', buffer.shortName || buffer.id, '- pointers:', JSON.stringify(n.pointers));

        if ((n as NickGroupMessage).group === 1) {
            const g = createNickGroup(n as NickGroupMessage);
            // Only create the group if it doesn't already exist (prevents overwrites)
            if (!(g.name in buffer.nicklist)) {
                buffer.nicklist[g.name] = g;
                if (DEBUG_NICKLIST) console.log('[nicklist] diff group:', g.name, 'added to', buffer.shortName);
            }
            group = g.name;
        } else {
            const d = n._diff;
            const op = d === 43 ? '+' : d === 45 ? '-' : d === 42 ? '*' : '?';
            const nick = createNick(n as NickMessage);
            if (DEBUG_NICKLIST) console.log('[nicklist] diff nick:', nick.name, 'prefix:', nick.prefix, 'in group', group, 'op:', op);
            const nickGroup = buffer.nicklist[group];
            if (!nickGroup) {
                if (DEBUG_NICKLIST) console.log('[nicklist] group', group, 'not found for nick', nick.name);
                continue;
            }
            if (d === 43) { // + add nick
                nickGroup.nicks.push(nick);
            } else if (d === 45) { // - remove nick
                nickGroup.nicks = nickGroup.nicks.filter(nk => nk.name !== nick.name);
            } else if (d === 42) { // * update nick
                const idx = nickGroup.nicks.findIndex(nk => nk.name === nick.name);
                if (idx >= 0) {
                    nickGroup.nicks[idx] = nick;
                }
            }
        }
        modifiedBuffers.add(ptr0);
    }

    // Create new references only for affected buffers to trigger reactivity.
    // Only include modified buffers — unaffected buffers are preserved by buffers.update().
    const updated: Record<string, BufferData> = {};
    for (const id of modifiedBuffers) {
        const deep = updateBufferDeep(id);
        if (deep) updated[id] = deep;
    }
    if (DEBUG_NICKLIST) console.log('[nicklist] updating buffers store with', modifiedBuffers.size, 'modified buffer(s)');
    // Use update() to merge with current store state, preventing overwrites
    // of concurrent changes from other handlers.
    buffers.update(c => {
        const merged = { ...c };
        for (const id in updated) {
            if (updated[id]) merged[id] = updated[id];
        }
        return merged;
    });

    // Log nick count per affected buffer after applying diff
    if (DEBUG_NICKLIST) {
        for (const id of modifiedBuffers) {
            const buf = updated[id];
            const count = buf ? Object.values(buf.nicklist).reduce((s, g) => s + g.nicks.length, 0) : -1;
            console.log('[nicklist] AFTER diff:', buf?.shortName || id, '- nicks:', count);
        }
    }
}

// ---- Line info handler (for fetchMoreLines and auto-sync) ----
// Builds immutable copies of affected buffers, processes all lines on those
// copies, then uses buffers.update() to merge changes with current store state.
export function handleLineInfo(message: ProtocolMessage, manually: boolean = true, clearLinesBufferId?: string) {
    const lines = message.objects[0]?.content as BufferLineMessage[];
    if (!lines) {
        console.debug('[handler] handleLineInfo: no content');
        return;
    }
    const addedCount = lines.filter(l => {
        const buf = get(buffers)[l.buffer];
        return buf && l.displayed;
    }).length;
    console.debug('[handler] handleLineInfo: manually=' + manually + ' lines=' + lines.length + ' displayed=' + addedCount);

    // Reverse because WeeChat returns newest first
    const reversed = [...lines].reverse();
    const currentBuffers = get(buffers);

    // Identify all affected buffer IDs
    const affectedIds = new Set<string>();
    for (const lineMsg of reversed) {
        affectedIds.add(lineMsg.buffer);
    }
    if (clearLinesBufferId) {
        affectedIds.add(clearLinesBufferId);
    }

    // Build immutable copies: deep-copy only affected buffers.
    // Unaffected buffers are NOT included — the merge via buffers.update()
    // will preserve whatever state they currently have in the store.
    const updatedBuffers: Record<string, BufferData> = {};
    for (const id of affectedIds) {
        const buf = currentBuffers[id];
        if (!buf) continue;
        let linesCopy = buf.lines.map(deepCloneBufferLine);
        // Clear lines for the buffer that requested a fresh fetch
        if (id === clearLinesBufferId) {
            linesCopy = [];
        }
        updatedBuffers[id] = { ...buf, lines: linesCopy, nicklist: { ...buf.nicklist }, localVariables: buf.localVariables ? { ...buf.localVariables } : undefined };
    }

    for (const lineMsg of reversed) {
        const buffer = updatedBuffers[lineMsg.buffer];
        if (!buffer) continue;

        const line = createBufferLine(lineMsg);
        buffer.requestedLines++;

        if (line.displayed) {
            if (buffer.lines.length > 0) {
                const lastLine = buffer.lines[buffer.lines.length - 1]!;
                const oldDate = new Date(lastLine.date);
                const newDate = new Date(line.date);
                injectDateChangeMessageIfNeeded(buffer, manually, oldDate, newDate);
            }
            buffer.lines.push(line);
            // For manual fetches on active buffer, do NOT increment lastSeen —
            // readmarker stays in place. For inactive buffers with lastSeen set
            // or no unread, increment normally (will be corrected by fetchMoreLines).
            // For buffers not yet synced (lastSeen < 0, no unread), defer to post-backfill.
            if (manually && buffer.id !== get(activeBufferId)) {
                if (buffer.lastSeen >= 0 || (buffer.unread === 0 && buffer.notification === 0)) {
                    buffer.lastSeen++;
                }
            }
        }
    }

    // Post-backfill: set lastSeen for buffers with lastSeen < 0 after loading.
    // Account for hotlist-reported unread counts so the readmarker appears at
    // the correct position instead of being hidden at the bottom.
    for (const buf of Object.values(updatedBuffers)) {
        if (buf.lastSeen < 0 && buf.lines.length > 0) {
            const unreadSum = (buf.unread || 0) + (buf.notification || 0);
            buf.lastSeen = unreadSum > 0
                ? Math.max(0, buf.lines.length - unreadSum - 1)
                : buf.lines.length - 1;
        }
    }

    // Trim lines exceeding memory limit on affected buffers
    const limit = get(maxBufferLines);
    for (const id of affectedIds) {
        const buf = updatedBuffers[id];
        if (buf) trimBufferLines(buf, limit);
    }

    // Use update() to merge with current store state, preventing overwrites
    // of concurrent changes from other handlers.
    buffers.update(current => {
        const merged = { ...current };
        for (const id in updatedBuffers) {
            if (updatedBuffers[id]) merged[id] = updatedBuffers[id];
        }
        return merged;
    });
}

// ---- Event dispatch table ----
const eventHandlers: Record<string, (msg: ProtocolMessage) => void> = {
    '_buffer_cleared': handleBufferCleared,
    '_buffer_closing': handleBufferClosing,
    '_buffer_line_added': handleBufferLineAdded,
    '_buffer_line_data_changed': handleBufferLineDataChanged,
    '_buffer_localvar_added': handleBufferLocalvarChanged,
    '_buffer_localvar_removed': handleBufferLocalvarChanged,
    '_buffer_localvar_changed': handleBufferLocalvarChanged,
    '_buffer_merged': handleBufferMergedOrUnmerged,
    '_buffer_moved': handleBufferMoved,
    '_buffer_unmerged': handleBufferMergedOrUnmerged,
    '_buffer_opened': handleBufferOpened,
    '_buffer_title_changed': handleBufferTitleChanged,
    '_buffer_type_changed': (msg) => {
        const obj = msg.objects[0]?.content[0];
        if (!obj) return;
        const bufferId = obj.pointers[0];
        const buffer = getBuffer(bufferId);
        if (!buffer) return;
        const bufferType = obj.type;
        const hideBufferLineTimes = bufferType === 1;
        const updated = updateBuffer(bufferId, { bufferType, hideBufferLineTimes });
        if (!updated) return;
        // Use update() to merge with current store state, preventing overwrites
        // of concurrent changes from other handlers.
        buffers.update(current => ({ ...current, [bufferId]: updated }));
    },
    '_buffer_renamed': handleBufferRenamed,
    '_buffer_hidden': handleBufferHidden,
    '_buffer_unhidden': handleBufferUnhidden,
    '_nicklist': handleNicklist,
    '_nicklist_diff': handleNicklistDiff,
    '_pong': handlePong,
    '_upgrade': handleUpgrade,
    '_upgrade_ended': handleUpgradeEnded
};

export function handleEvent(event: ProtocolMessage) {
    const handler = eventHandlers[event.id];
    if (handler) {
        console.debug('[handler] dispatch:', event.id, 'objects=' + (event.objects?.length ?? 0));
        handler(event);
    } else {
        console.debug('[handler] unhandled:', event.id);
    }
}

export function handleMessage(event: ProtocolMessage) {
    handleEvent(event);
}
