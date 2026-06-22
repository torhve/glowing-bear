import { get } from 'svelte/store';
import {
    buffers,
    servers,
    activeBufferId,
    previousBufferId,
    bufferBottom,
    localUnreadBuffers,
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
    isSyncing
} from '$lib/stores/models';
import { shouldResume } from '$lib/stores/bufferResume';
import { createHighlight, playNotificationSound, updateTitle, updateFavico } from '$lib/notifications';
import { DEBUG_NICKLIST } from '$lib/debug';
import type { ProtocolMessage, BufferMessage, BufferLine, BufferLineMessage, NickMessage, NickGroupMessage, HotlistEntry, BufferData } from '$lib/types';

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
            console.log('[version] WeeChat version:', value, version);
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
            console.log('[version] WeeChat version:', value, version);
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

     // Mark that we're in initial sync phase — hotlist has arrived with unread
    // counts but lines haven't been synced yet. During sync, don't increment
    // lastSeen per-line; instead calculate it once after sync completes.
    setSyncing(true);

    // Track whether any buffer was auto-resumed during this loop.
    // If so, skip the fallback (weechat core / first buffer) below.
    let resumed = false;

    for (const bufferMsg of bufferInfos) {
        const bufferId = bufferMsg.pointers[0];
        if (!bufferId) continue;
        if (currentBuffers[bufferId]) {
            // Update existing buffer
            handleBufferUpdate(currentBuffers[bufferId], bufferMsg);
            // Clear existing lines on reconnect — sync events will repopulate.
            // Reset lastSeen/localUnread so the sync phase recalculates them
            // from hotlist counts (handleHotlistInfo runs after handleBufferInfo).
            currentBuffers[bufferId].lines = [];
            currentBuffers[bufferId].requestedLines = 0;
            currentBuffers[bufferId].allLinesFetched = false;
            currentBuffers[bufferId].lastSeen = -1;
            currentBuffers[bufferId].localUnread = 0;
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
                const serverKey = `${buffer.plugin}.${buffer.server}`;
                const server = get(servers)[serverKey];
                if (server) {
                    server.unread += buffer.unread + buffer.notification;
                }
            }
            addBuffer(buffer);
            console.debug('[handler]   created buffer:', buffer.id, buffer.shortName, 'lines=' + buffer.lines.length);

            // Auto-resume
            if (shouldResume(buffer.id)) {
                setActiveBuffer(buffer.id);
                resumed = true;
                console.debug('[handler]   auto-resumed to:', buffer.id);
            }
        }
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- WeeChat buffer object from protocol
function handleBufferUpdate(buffer: any, message: BufferMessage) {
    if (message.pointers[0] !== buffer.id) return;

    buffer.shortName = message.short_name;
    buffer.trimmedName = buffer.shortName.replace(/^[#&+]/, '') || (buffer.shortName ? ' ' : null);
    buffer.prefix = ['#', '&', '+'].includes(buffer.shortName.charAt(0)) ? buffer.shortName.charAt(0) : '';
    buffer.title = message.title && typeof message.title === 'string' ? parseRichText(message.title) : buffer.title;
    buffer.number = message.number;
    buffer.hidden = !!message.hidden;

    // Update server unread totals by removing this buffer's old contribution before
    // handleHotlistInfo recalculates them authoritatively.
    const serverKey = `${buffer.plugin}.${buffer.server}`;
    const server = get(servers)[serverKey];
    if (server) {
        server.unread -= (buffer.unread + buffer.notification);
    }
    // Unread/notification/lastSeen counts are managed by handleHotlistInfo (authoritative
    // WeeChat data) and handleBufferLineAdded (real-time local tracking). This handler
    // only updates buffer metadata (name, title, type, etc.) — not message counts.

    if (message.type !== undefined) {
        buffer.bufferType = message.type;
        buffer.hideBufferLineTimes = buffer.bufferType === 1;
    }

    if (message.local_variables?.type !== undefined) {
        buffer.type = message.local_variables.type;
        buffer.indent = ['channel', 'private'].includes(buffer.type);
    }
    if (message.local_variables?.plugin !== undefined) {
        buffer.plugin = message.local_variables.plugin;
    }
    if (message.local_variables?.server !== undefined) {
        buffer.server = message.local_variables.server;
    }
    if (message.local_variables?.pinned !== undefined) {
        buffer.pinned = message.local_variables.pinned === 'true';
    }
    buffer.serverSortKey = `${buffer.plugin}.${buffer.server}${buffer.type === 'server' ? '' : '.' + buffer.shortName}`.toLowerCase();

    if (message.notify !== undefined) {
        buffer.notify = message.notify;
    }
}

// ---- Buffer line added handler ----
/**
 * Strips WeeChat formatting codes from prefix and message for notification display.
 * Returns a plain-text body suitable for desktop notifications.
 */
function formatNotificationBody(lineMsg: BufferLineMessage): string {
    const prefixParts = parseRichText(lineMsg.prefix);
    const messageParts = parseRichText(lineMsg.message);
    const prefixText = prefixParts.map(p => p.text).join('').trim();
    const msgText = messageParts.map(p => p.text).join('');
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

    // First pass: identify all affected buffer IDs
    const affectedIds = new Set<string>();
    for (const lineMsg of lines) {
        affectedIds.add(lineMsg.buffer);
    }

    // Build immutable copies: deep-copy (new lines array) for affected buffers,
    // shallow-copy for unchanged ones. Mutations below apply only to these copies.
    const updatedBuffers: Record<string, BufferData> = {};
    for (const id in currentBuffers) {
        const buf = currentBuffers[id];
        if (!buf) continue;
        if (affectedIds.has(id)) {
            updatedBuffers[id] = { ...buf, lines: [...buf.lines], nicklist: { ...buf.nicklist } };
        } else {
            updatedBuffers[id] = buf;
        }
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
            console.log('[handler] creating buffer for:', lineMsg.buffer, 'nick:', inferredNick, 'msg:', lineMsg.message?.substring(0, 50));

            buffer = createBuffer({
                pointers: [lineMsg.buffer],
                full_name: inferredNick,
                short_name: inferredNick,
                type: 2,
                notify: 3,
                local_variables: { type: 'private', plugin: 'irc' }
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
            if (isSyncing()) {
                // Check if we've received enough lines to cover all unread.
                // unreadSum = message unread + private + highlights.
                // unread is index 1, notification is indices 2+3 combined.
                const unreadSum = buffer.unread + buffer.notification;
                if (buffer.lines.length > unreadSum && buffer.lastSeen < 0) {
                    buffer.lastSeen = buffer.lines.length - unreadSum - 1;
                    setSyncing(false);
                }
            } else {
                // After sync: for active buffers at bottom, set lastSeen to the
                // last line so there are no phantom unread messages. For active
                // buffers scrolled up, increment as before. For inactive buffers,
                // track local unread count regardless of whether lastSeen is set.
                if (buffer.id === activeId && buffer.lastSeen >= 0) {
                    if (get(bufferBottom)) {
                        buffer.lastSeen = buffer.lines.length - 1;
                    } else {
                        buffer.lastSeen++;
                    }
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
                    const server = get(servers)[serverKey];
                    if (server) server.unread++;
                }
            }

            // Trigger notification subsystem for highlights/privates with notify_level >= 2.
            // Suppress counting and desktop notifications when the buffer is active.
            // Desktop notifications/sounds are further suppressed when tab is visible
            // (user is looking at the app, even if scrolled to a different buffer).
            if (lineMsg.notify_level >= 2 && buffer.id !== activeId) {
                const isPrivate = buffer.type === 'private';
                if (buffer.notify !== 0 && (lineMsg.highlight || isPrivate)) {
                    buffer.notification++;
                    const serverKey = `${buffer.plugin}.${buffer.server}`;
                    const server = get(servers)[serverKey];
                    if (server) server.unread++;

                    // Only show desktop notifications and play sounds when tab is hidden.
                    // When the window is focused, the user can see the message in the UI.
                    if (!isWindowFocused) {
                        // Strip WeeChat formatting codes from message/prefix for notification display
                        const notificationBody = formatNotificationBody(lineMsg);

                        // Trigger notification subsystem
                        createHighlight(buffer, notificationBody);
                        playNotificationSound();
                        updateTitle();
                        updateFavico();
                    }
                }
            }
        }
    }

    // Update spokeAt timestamps for tab completion on the immutable copies
    handleNickMessageForSpeakOnBuffers(lines, updatedBuffers);

    // Update stores
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- buffer object type from models store
    console.debug('[handler] updating buffers store, total lines:', Object.values(updatedBuffers).reduce((sum: number, b: any) => sum + b.lines.length, 0));
    buffers.set(updatedBuffers);
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
    let matchedIndex = -1;
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
    matchedIndex = matches[matches.length - 1]!;

    // Create new BufferLine from updated data.
    const date = new Date(lineMsg.date);
    const prefix = parseRichText(lineMsg.prefix);
    const content = parseRichText(lineMsg.message);
    const showHiddenBrackets = lineMsg.tags_array.includes('irc_privmsg') && !lineMsg.tags_array.includes('irc_action');

    const updatedLine: BufferLine = {
        prefix,
        content,
        date: date.getTime(),
        shortTime: date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
        formattedTime: date.toLocaleTimeString(),
        buffer: lineMsg.buffer,
        tags: lineMsg.tags_array,
        highlight: !!lineMsg.highlight,
        displayed: !!lineMsg.displayed,
        prefixtext: prefix.map(p => p.text).join(''),
        text: content.map(c => c.text).join(''),
        showHiddenBrackets
    };

    // Immutable update: clone lines array, replace at index, then update store.
    const updatedBuffers = { ...currentBuffers };
    const updatedBuffer = { ...buffer, lines: [...buffer.lines] };
    updatedBuffer.lines[matchedIndex] = updatedLine;
    updatedBuffers[lineMsg.buffer] = updatedBuffer;
    buffers.set(updatedBuffers);
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
    const updated = { ...current };

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
    buffers.set(updated);
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
    console.log('[handler] _upgrade: WeeChat upgrading, disconnecting');
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
    console.log('[handler] _upgrade_ended: WeeChat upgrade complete, reconnecting');
    if (upgradeReconnectTimer) clearTimeout(upgradeReconnectTimer);
    upgradeReconnectTimer = setTimeout(() => {
        upgradeReconnectTimer = null;
        onUpgradeEndedCallback?.();
    }, 2000);
}

// ---- Date change injection ----
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- buffer type from protocol
export function injectDateChangeMessageIfNeeded(buffer: any, manually: boolean, oldDate: Date, newDate: Date) {
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
        const server = get(servers)[serverKey];
        if (server) server.unread += buffer.unread + buffer.notification;
    }
    addBuffer(buffer);

    // Check if this buffer matches a pending switch request from nicklist click
    const targetNick = get(pendingBufferSwitch) as string | null;
    if (targetNick && (buffer.shortName.toLowerCase() === targetNick.toLowerCase())) {
        console.log('[handler] auto-switching to query buffer for:', targetNick);
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
    const current = get(buffers);
    buffers.set({ ...current, [bufferId]: updated });
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
    const current = get(buffers);
    buffers.set({ ...current, [bufferId]: updated });
}

// ---- Buffer hidden/unhidden ----
// Toggle buffer.hidden immutably to trigger Svelte reactivity.
export function handleBufferHidden(message: ProtocolMessage) {
    const obj = message.objects[0]?.content[0];
    if (!obj) return;
    const updated = updateBuffer(obj.pointers[0], { hidden: true });
    if (!updated) return;
    const current = get(buffers);
    buffers.set({ ...current, [obj.pointers[0]]: updated });
}

export function handleBufferUnhidden(message: ProtocolMessage) {
    const obj = message.objects[0]?.content[0];
    if (!obj) return;
    const updated = updateBuffer(obj.pointers[0], { hidden: false });
    if (!updated) return;
    const current = get(buffers);
    buffers.set({ ...current, [obj.pointers[0]]: updated });
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
    const updated = { ...current };

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
    buffers.set(updated);
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

    const updated = updateBuffer(bufferId, { type, indent, plugin, server, serverSortKey, pinned });
    if (!updated) return;
    const current = get(buffers);
    buffers.set({ ...current, [bufferId]: updated });
}

// ---- Buffer cleared ----
// Clear lines and requestedLines immutably using deep copy for the lines array.
export function handleBufferCleared(message: ProtocolMessage) {
    const bufferMsg = message.objects[0]?.content[0];
    if (!bufferMsg) return;
    const bufferId = bufferMsg.pointers[0];
    const updated = updateBufferDeep(bufferId, { lines: [], requestedLines: 0 });
    if (!updated) return;
    const current = get(buffers);
    buffers.set({ ...current, [bufferId]: updated });
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
    const localUnread = get(localUnreadBuffers);

    const hotlist = message.objects[0]?.content as HotlistEntry[];
    if (!hotlist) return;

    console.table(hotlist.map(entry => ({
        buffer: entry.buffer,
        shortName: currentBuffers[entry.buffer]?.shortName || entry.buffer,
        unread: entry.count[1],
        highlight: entry.count[2],
        private: entry.count[3],
    })));

    // Build immutable copies of affected buffers and servers to ensure
    // Svelte reactivity triggers correctly when unread counts change.
    const updatedBuffers = {} as Record<string, BufferData>;
    const updatedServers = { ...currentServers };

    for (const id in currentBuffers) {
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
    for (const id of hotlistBufferIds) {
        const buf = updatedBuffers[id];
        if (!buf || id === activeId || id === previousId) continue;
        if ((buf.unread || 0) + (buf.notification || 0) + (buf.localUnread || 0) > 0) continue;

        buf.unread = 0;
        buf.notification = 0;
    }

    // Reset all server unread totals before recalculating from hotlist entries.
    for (const key in updatedServers) {
        const srv = updatedServers[key];
        if (srv) srv.unread = 0;
    }

    for (const entry of hotlist) {
        const buffer = updatedBuffers[entry.buffer];
        if (!buffer || entry.buffer === activeId || entry.buffer === previousId) continue;

        // Merge WeeChat hotlist counts with locally-tracked counts.
        // Use Math.max to preserve optimistic local increments that haven't
        // been acknowledged by WeeChat's hotlist yet.
        const hotlistUnread = entry.count[1] || 0;
        const hotlistNotif = (entry.count[2] || 0) + (entry.count[3] || 0);
        buffer.unread = Math.max(buffer.unread, hotlistUnread);
        buffer.notification = Math.max(buffer.notification, hotlistNotif);
        // Only calculate lastSeen if buffer has lines and no local unreads tracked.
        // Buffers with localUnread > 0 have more accurate local data than stale WeeChat hotlist.
        if (buffer.lines.length > 0 && !localUnread.has(entry.buffer)) {
            const totalUnread = buffer.unread + buffer.notification;
            buffer.lastSeen = buffer.lines.length - 1 - totalUnread;
        }

        const serverKey = `${buffer.plugin}.${buffer.server}`;
        const server = updatedServers[serverKey];
        if (server) {
            server.unread += buffer.unread + buffer.notification;
        }
    }

    buffers.set(updatedBuffers);
    servers.set(updatedServers);
}

// ---- Nicklist handler ----
function initNicklistIfFresh(nicklist: (NickMessage | NickGroupMessage)[]) {
    if (nicklist.length !== 1) return;
    const firstItem = nicklist[0];
    if (!firstItem) return;
    const bufferId = firstItem.pointers[0];
    if (!bufferId) return;
    const buffer = getBuffer(bufferId);
    if (DEBUG_NICKLIST) console.log('[nicklist] clearing nicklist for buffer:', bufferId);
    if (buffer) {
        buffer.nicklist = { root: buffer.nicklist.root || { name: '', visible: '', nicks: [] } };
    }
}

export function handleNicklist(message: ProtocolMessage) {
    const nicklist = message.objects[0]?.content as (NickMessage | NickGroupMessage)[];
    if (DEBUG_NICKLIST) console.log('[nicklist] handleNicklist called, total items:', nicklist?.length ?? 0);
    if (!nicklist) return;

    initNicklistIfFresh(nicklist);

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

    // Create new references only for affected buffers to trigger reactivity
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

    const updated = { ...current };
    for (const id of modifiedBuffers) {
        const deep = updateBufferDeep(id);
        if (deep) updated[id] = deep;
    }
    if (DEBUG_NICKLIST) console.log('[nicklist] updating buffers store with', modifiedBuffers.size, 'modified buffer(s)');
    buffers.set(updated);
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

        if (DEBUG_NICKLIST) console.log('[nicklist] processing diff item for', buffer.shortName || buffer.id, '- pointers:', JSON.stringify(n.pointers));

        // Ensure root group exists (mirrors AngularJS nicklistRequested check)
        if (!('root' in buffer.nicklist)) {
            buffer.nicklist.root = { name: '', visible: '', nicks: [] };
            if (DEBUG_NICKLIST) console.log('[nicklist] created missing root group for', buffer.shortName);
        }

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

    // Immutable update: copy affected buffers and push new reference to trigger reactivity
    const current = get(buffers);
    const updated = { ...current };
    for (const id of modifiedBuffers) {
        const deep = updateBufferDeep(id);
        if (deep) updated[id] = deep;
    }
    if (DEBUG_NICKLIST) console.log('[nicklist] updating buffers store with', modifiedBuffers.size, 'modified buffer(s)');
    buffers.set(updated);
}

// ---- Line info handler (for fetchMoreLines) ----
export function handleLineInfo(message: ProtocolMessage, manually: boolean = true) {
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

    for (const lineMsg of reversed) {
        const buffer = currentBuffers[lineMsg.buffer];
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
            // Only increment lastSeen for manual loads when no unread messages
            // exist yet — otherwise defer to post-backfill which accounts for
            // hotlist-reported unread counts. For scroll-back fetches where
            // lastSeen is already >= 0 from a previous visit, always increment.
            if (manually && (buffer.lastSeen >= 0 || (buffer.unread === 0 && buffer.notification === 0))) {
                buffer.lastSeen++;
            }
        }
    }

    // Post-backfill: set lastSeen for buffers with lastSeen < 0 after loading.
    // Account for hotlist-reported unread counts so the readmarker appears at
    // the correct position instead of being hidden at the bottom.
    for (const buf of Object.values(currentBuffers)) {
        if (buf.lastSeen < 0 && buf.lines.length > 0) {
            const unreadSum = (buf.unread || 0) + (buf.notification || 0);
            buf.lastSeen = unreadSum > 0
                ? Math.max(0, buf.lines.length - unreadSum - 1)
                : buf.lines.length - 1;
        }
    }

    buffers.set({ ...currentBuffers });
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
        const currentBuffers = get(buffers);
        const buffer = currentBuffers[obj.pointers[0]];
        if (!buffer) return;
        buffer.bufferType = obj.type;
        buffer.hideBufferLineTimes = buffer.bufferType === 1;
        buffers.set({ ...currentBuffers });
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
