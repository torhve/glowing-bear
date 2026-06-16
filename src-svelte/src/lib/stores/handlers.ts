import { get } from 'svelte/store';
import {
    buffers,
    servers,
    activeBufferId,
    weechatVersion,
    wconfig,
    addBuffer,
    getBuffer,
    setActiveBuffer,
    createBuffer,
    createBufferLine,
    createNick,
    createNickGroup,
    parseRichText,
    removeBuffer,
    pendingBufferSwitch
} from '$lib/stores/models';
import { shouldResume } from '$lib/stores/bufferResume';
import { createHighlight, playNotificationSound, updateTitle, updateFavico } from '$lib/notifications';
import type { ProtocolMessage, BufferMessage, BufferLine, BufferLineMessage, NickMessage, NickGroupMessage, HotlistEntry, BufferData } from '$lib/types';

// ---- Version handler ----
export function handleVersionInfo(message: ProtocolMessage) {
    const content = message.objects[0]?.content;
    if (!content || !Array.isArray(content)) return;
    const first = content[0];
    if (!first) return;
    const value = first.value;
    if (typeof value === 'string') {
        const version = value.split('.').map((c: string) => parseInt(c, 10));
        weechatVersion.set(version);
    }
}

// ---- Config handler ----
export function handleConfValue(message: ProtocolMessage) {
    const infolist = message.objects[0]?.content;
    if (!infolist) return;

    const config: Record<string, string> = {};
    for (const item of infolist) {
        for (const confitem of item) {
            if (confitem.full_name) config[confitem.full_name] = confitem.value || '';
        }
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

    for (const bufferMsg of bufferInfos) {
        const bufferId = bufferMsg.pointers[0];
        if (!bufferId) continue;
        if (currentBuffers[bufferId]) {
            // Update existing buffer
            handleBufferUpdate(currentBuffers[bufferId], bufferMsg);
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
                console.debug('[handler]   auto-resumed to:', buffer.id);
            }
        }
    }

    // If no buffer was auto-resumed, go to first one
    const bufferKeys = Object.keys(get(buffers));
    const firstBufferKey = bufferKeys[0];
    if (firstBufferKey && !shouldResume(firstBufferKey)) {
        setActiveBuffer(firstBufferKey);
    }
}

// ---- Buffer update handler ----
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- WeeChat buffer object from protocol
function handleBufferUpdate(buffer: any, message: BufferMessage) {
    if (message.pointers[0] !== buffer.id) return;

    buffer.shortName = message.short_name;
    buffer.trimmedName = buffer.shortName.replace(/^[#&+]/, '') || (buffer.shortName ? ' ' : null);
    buffer.title = message.title && typeof message.title === 'string' ? parseRichText(message.title) : buffer.title;
    buffer.number = message.number;
    buffer.hidden = !!message.hidden;

    // Reset unread counts
    const serverKey = `${buffer.plugin}.${buffer.server}`;
    const server = get(servers)[serverKey];
    if (server) {
        server.unread -= (buffer.unread + buffer.notification);
    }
    buffer.notification = 0;
    buffer.unread = 0;
    buffer.lastSeen = -1;

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
export function handleBufferLineAdded(message: ProtocolMessage) {
    const lines = message.objects[0]?.content as BufferLineMessage[];
    if (!lines) {
        console.debug('[handler] _buffer_line_added: no content');
        return;
    }
    console.debug('[handler] _buffer_line_added: buffers=' + Object.keys(get(buffers)).length + ' active=' + get(activeBufferId) + ' lines=' + lines.length);

    const currentBuffers = get(buffers);
    const activeId = get(activeBufferId);
    const isWindowFocused = typeof document !== 'undefined' && document.hasFocus();
    const newBufferMap: Record<string, BufferData> = {};

    for (const lineMsg of lines) {
        let buffer = currentBuffers[lineMsg.buffer];
        if (!buffer) {
            // Buffer not in our store yet (e.g., WeeChat auto-created query buffer for PM).
            // Try to extract nick from prefix (format: <nick> or <nick!user@host>)
            let inferredNick = '';
            const prefix = lineMsg.prefix || '';
            const nickMatch = prefix.match(/^<([^>]+)>/);
            if (nickMatch) {
                inferredNick = nickMatch[1]!;
            }
            console.log('[handler] creating buffer for:', lineMsg.buffer, 'nick:', inferredNick, 'msg:', lineMsg.message?.substring(0, 50));

            const newBuffer: BufferData = {
                id: lineMsg.buffer,
                fullName: inferredNick,
                shortName: inferredNick,
                hidden: false,
                trimmedName: inferredNick.replace(/^[#&+]/, '') || null,
                nameClasses: [],
                prefix: '',
                number: 0,
                title: [],
                rtitle: inferredNick,
                lines: [],
                requestedLines: 0,
                allLinesFetched: false,
                lastSeen: -1,
                unread: 0,
                notification: 0,
                notify: 3,
                nicklist: {},
                serverSortKey: `irc.${inferredNick.toLowerCase()}`,
                indent: true,
                bufferType: 2,
                type: 'private' as const,
                plugin: 'irc',
                server: '',
                hideBufferLineTimes: false,
                pinned: false,
                active: false
            };
            buffer = newBuffer;
            newBufferMap[lineMsg.buffer] = newBuffer;
        }

        if (!buffer) {
            console.warn('[handler] buffer unexpectedly undefined for:', lineMsg.buffer);
            continue;
        }

        const line = createBufferLine(lineMsg);
        buffer.requestedLines++;

        // Update spokeAt timestamps for tab completion
        handleNickMessageForSpeak(line);

        console.debug('[handler] line displayed=', line.displayed, 'text=', line.text?.substring(0, 30));
        if (line.displayed) {
            // Check for date change and inject date change message
            if (buffer.lines.length > 0) {
                const lastLine = buffer.lines[buffer.lines.length - 1]!;
                const oldDate = new Date(lastLine.date);
                const newDate = new Date(line.date);
                injectDateChangeMessageIfNeeded(buffer, false, oldDate, newDate);
            }

            buffer.lines = [...buffer.lines, line];

            // Update unread counts
            if (!lineMsg.displayed || !(buffer.id === activeId && isWindowFocused)) {
                if (buffer.notify > 1 && lineMsg.tags_array.includes('notify_message') && !lineMsg.tags_array.includes('notify_none')) {
                    buffer.unread++;
                    const serverKey = `${buffer.plugin}.${buffer.server}`;
                    const server = get(servers)[serverKey];
                    if (server) server.unread++;
                }

                const isPrivate = buffer.type === 'private' && buffer.id !== activeId;
                if (buffer.notify !== 0 && (lineMsg.highlight || lineMsg.tags_array.includes('notify_private') || isPrivate)) {
                    buffer.notification++;
                    const serverKey = `${buffer.plugin}.${buffer.server}`;
                    const server = get(servers)[serverKey];
                    if (server) server.unread++;

                    // Trigger notification subsystem
                    createHighlight(buffer, lineMsg.message);
                    playNotificationSound();
                    updateTitle(buffer);
                    updateFavico();
                }
            }
        }
    }

    // Create new buffer references to trigger Svelte reactivity
    const updatedBuffers = {} as Record<string, BufferData>;
    for (const id of Object.keys(currentBuffers)) {
        const buf = currentBuffers[id];
        if (buf) {
            updatedBuffers[id] = { ...buf };
        }
    }
    // Merge in any newly created buffers from inside the loop
    for (const id of Object.keys(newBufferMap)) {
        const newBuf = newBufferMap[id];
        if (newBuf) {
            updatedBuffers[id] = newBuf;
        }
    }

    // Update stores
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- buffer object type from models store
    console.debug('[handler] updating buffers store, total lines:', Object.values(updatedBuffers).reduce((sum: number, b: any) => sum + b.lines.length, 0));
    buffers.set(updatedBuffers);
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

    let content = `\u001904\u2500`; // Day change color + box drawing

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
        prefix: '\u001904\u2500',
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
export function handleBufferTitleChanged(message: ProtocolMessage) {
    const obj = message.objects[0]?.content[0];
    if (!obj) return;

    const buffer = getBuffer(obj.pointers[0]);
    if (!buffer) return;

    buffer.fullName = obj.full_name;
    buffer.title = obj.title ? parseRichText(obj.title) : buffer.title;
    buffer.number = obj.number;
}

// ---- Buffer renamed ----
export function handleBufferRenamed(message: ProtocolMessage) {
    const obj = message.objects[0]?.content[0];
    if (!obj) return;

    const buffer = getBuffer(obj.pointers[0]);
    if (!buffer) return;

    buffer.fullName = obj.full_name;
    buffer.shortName = obj.short_name;
    buffer.trimmedName = obj.short_name.replace(/^[#&+]/, '') || (obj.short_name ? ' ' : null);
    buffer.prefix = ['#', '&', '+'].includes(obj.short_name.charAt(0)) ? obj.short_name.charAt(0) : '';
}

// ---- Buffer hidden/unhidden ----
export function handleBufferHidden(message: ProtocolMessage) {
    const obj = message.objects[0]?.content[0];
    if (!obj) return;
    const buffer = getBuffer(obj.pointers[0]);
    if (buffer) buffer.hidden = true;
}

export function handleBufferUnhidden(message: ProtocolMessage) {
    const obj = message.objects[0]?.content[0];
    if (!obj) return;
    const buffer = getBuffer(obj.pointers[0]);
    if (buffer) buffer.hidden = false;
}

// ---- Buffer moved ----
// Adjust all buffer numbers when a buffer changes position,
// shifting intermediate buffers to fill the gap.
export function handleBufferMoved(message: ProtocolMessage) {
    const obj = message.objects[0]?.content[0];
    if (!obj) return;
    const bufferId = obj.pointers[0];
    const buffer = getBuffer(bufferId);
    if (!buffer) return;

    const oldNumber = buffer.number;
    const newNumber = obj.number;
    if (oldNumber === newNumber) return;

    const currentBuffers = get(buffers);
    for (const key in currentBuffers) {
        const buf = currentBuffers[key]!;
        if (buf.number > oldNumber && buf.number <= newNumber) {
            buf.number -= 1;
        } else if (buf.number < oldNumber && buf.number >= newNumber) {
            buf.number += 1;
        }
    }
    buffer.number = newNumber;
    buffers.set({ ...currentBuffers });
}

// ---- Buffer local var changed ----
export function handleBufferLocalvarChanged(message: ProtocolMessage) {
    const obj = message.objects[0]?.content[0];
    if (!obj) return;

    const buffer = getBuffer(obj.pointers[0]);
    if (!buffer || !obj.local_variables) return;

    const lv = obj.local_variables;
    buffer.type = lv.type || buffer.type;
    buffer.indent = ['channel', 'private'].includes(buffer.type);
    buffer.plugin = lv.plugin || buffer.plugin;
    buffer.server = lv.server || buffer.server;
    buffer.serverSortKey = `${buffer.plugin}.${buffer.server}${buffer.type === 'server' ? '' : '.' + buffer.shortName}`.toLowerCase();
    buffer.pinned = lv.pinned === 'true';
}

// ---- Buffer cleared ----
export function handleBufferCleared(message: ProtocolMessage) {
    const bufferMsg = message.objects[0]?.content[0];
    if (!bufferMsg) return;
    const bufferId = bufferMsg.pointers[0];
    const buffer = getBuffer(bufferId);
    if (buffer) {
        buffer.lines = [];
        buffer.requestedLines = 0;
    }
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
    const currentServers = get(servers);

    // Reset all counts
    for (const id in currentBuffers) {
        const buf = currentBuffers[id];
        if (buf) {
            buf.unread = 0;
            buf.notification = 0;
        }
    }
    for (const key in currentServers) {
        const srv = currentServers[key];
        if (srv) {
            srv.unread = 0;
        }
    }

    const hotlist = message.objects[0]?.content as HotlistEntry[];
    if (!hotlist) return;

    for (const entry of hotlist) {
        const buffer = currentBuffers[entry.buffer];
        if (!buffer || buffer.active) continue;

        buffer.unread = entry.count[1] || 0;
        buffer.notification = (entry.count[2] || 0) + (entry.count[3] || 0);
        const unreadSum = entry.count.reduce((sum: number, n: number) => sum + n, 0);
        buffer.lastSeen = buffer.lines.length - 1 - unreadSum;

        const serverKey = `${buffer.plugin}.${buffer.server}`;
        const server = currentServers[serverKey];
        if (server && entry.count[1] !== undefined && entry.count[2] !== undefined && entry.count[3] !== undefined) {
            server.unread += entry.count[1] + entry.count[2] + entry.count[3];
        }
    }

    buffers.set({ ...currentBuffers });
    servers.set({ ...currentServers });
}

// ---- Nicklist handler ----
function initNicklistIfFresh(nicklist: (NickMessage | NickGroupMessage)[]) {
    if (nicklist.length !== 1) return;
    const firstItem = nicklist[0];
    if (!firstItem) return;
    const bufferId = firstItem.pointers[0];
    if (!bufferId) return;
    const buffer = getBuffer(bufferId);
    console.log('[nicklist] clearing nicklist for buffer:', bufferId);
    if (buffer) {
        buffer.nicklist = { root: buffer.nicklist.root || { name: '', visible: '', nicks: [] } };
    }
}

export function handleNicklist(message: ProtocolMessage) {
    const nicklist = message.objects[0]?.content as (NickMessage | NickGroupMessage)[];
    console.log('[nicklist] handleNicklist called, total items:', nicklist?.length ?? 0);
    if (!nicklist) return;

    initNicklistIfFresh(nicklist);

    let group = 'root';
    const modifiedBuffers = new Set<string>();
    for (const n of nicklist) {
        const ptr0 = n.pointers[0];
        if (!ptr0) continue;
        const buffer = getBuffer(ptr0);
        if (!buffer) {
            console.log('[nicklist] buffer not found for ID:', ptr0);
            continue;
        }
        console.log('[nicklist] processing item for buffer', buffer.shortName || buffer.id, '- pointers:', JSON.stringify(n.pointers));
        // Ensure root group always exists for hasData check
        if (!('root' in buffer.nicklist)) {
            buffer.nicklist.root = { name: '', visible: '', nicks: [] };
            console.log('[nicklist] created root group for', buffer.shortName);
        }

        if ((n as NickGroupMessage).group === 1) {
            const g = createNickGroup(n as NickGroupMessage);
            group = g.name;
            buffer.nicklist[group] = g;
            console.log('[nicklist] added group', group, 'to', buffer.shortName, '- visible:', g.visible);
        } else {
            const nick = createNick(n as NickMessage);
            console.log('[nicklist] adding nick', nick.name, 'with prefix', nick.prefix, 'to group', group, 'in buffer', buffer.shortName);
            const nickGroup = buffer.nicklist[group];
            if (nickGroup) {
                nickGroup.nicks.push(nick);
            } else {
                console.log('[nicklist] WARNING: no group', group, 'found for nick', nick.name);
            }
        }
        modifiedBuffers.add(ptr0);
    }

    // Create new references only for affected buffers to trigger reactivity
    const current = get(buffers);

    // Log final nicklist structure
    for (const id of modifiedBuffers) {
        const buf = current[id];
        if (buf) {
            const groups = Object.keys(buf.nicklist || {});
            const nickCounts = groups.map(g => `${g}:${(buf.nicklist?.[g]?.nicks?.length ?? 0)}`).join(', ');
            console.log('[nicklist] after processing buffer', buf.shortName, 'groups:', groups.join(', '), '- nicks per group:', nickCounts);
        }
    }

    const updated = { ...current };
    for (const id of modifiedBuffers) {
        const buf = current[id];
        if (buf) {
            updated[id] = { ...buf, nicklist: { ...buf.nicklist } };
        }
    }
    console.log('[nicklist] updating buffers store with', modifiedBuffers.size, 'modified buffer(s)');
    buffers.set(updated);
}

// ---- Update nick spokeAt timestamp for tab completion ----
export function handleNickMessageForSpeak(line: BufferLine) {
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

    const allBuffers = get(buffers);
    for (const bufId in allBuffers) {
        const buf = allBuffers[bufId];
        if (!buf || !buf.nicklist) continue;
        for (const groupIdx in buf.nicklist) {
            const groupObj = buf.nicklist[groupIdx];
            if (!groupObj) continue;
            const nicks = groupObj.nicks;
            for (const curr_nick of nicks) {
                if (curr_nick.name === nick) {
                    curr_nick.spokeAt = Date.now();
                    return;
                }
            }
        }
    }
}

// ---- Nicklist diff handler ----
export function handleNicklistDiff(message: ProtocolMessage) {
    const nicklist = message.objects[0]?.content as (NickMessage | NickGroupMessage)[];
    console.log('[nicklist] handleNicklistDiff called, total items:', nicklist?.length ?? 0);
    if (!nicklist) return;

    let group = 'root';
    const modifiedBuffers = new Set<string>();
    for (const n of nicklist) {
        const ptr0 = n.pointers[0];
        if (!ptr0) continue;
        const buffer = getBuffer(ptr0);
        if (!buffer) {
            console.log('[nicklist] buffer not found for diff:', ptr0);
            continue;
        }
        console.log('[nicklist] processing diff item for', buffer.shortName || buffer.id, '- pointers:', JSON.stringify(n.pointers));

        if ((n as NickGroupMessage).group === 1) {
            const g = createNickGroup(n as NickGroupMessage);
            group = g.name;
            buffer.nicklist[group] = g;
            console.log('[nicklist] diff group:', group, 'added to', buffer.shortName);
        } else {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- nick object with internal _diff property from WeeChat protocol
            const d = (n as any)._diff;
            const nick = createNick(n as NickMessage);
            const op = d === 43 ? '+' : d === 45 ? '-' : d === 42 ? '*' : '?';
            console.log('[nicklist] diff nick:', nick.name, 'prefix:', nick.prefix, 'in group', group, 'op:', op);
            const nickGroup = buffer.nicklist[group];
            if (d === 43) { // +
                if (nickGroup) {
                    nickGroup.nicks.push(nick);
                }
            } else if (d === 45) { // -
                if (nickGroup) {
                    nickGroup.nicks = nickGroup.nicks.filter(n => n.name !== nick.name);
                }
            } else if (d === 42) { // *
                if (nickGroup) {
                    const idx = nickGroup.nicks.findIndex(n => n.name === nick.name);
                    if (idx >= 0) nickGroup.nicks[idx] = nick;
                }
            }
        }
        modifiedBuffers.add(ptr0);
    }

    // Create new references only for affected buffers to trigger reactivity
    const current = get(buffers);

    // Log final state
    for (const id of modifiedBuffers) {
        const buf = current[id];
        if (buf) {
            const groups = Object.keys(buf.nicklist || {});
            const nickCounts = groups.map(g => `${g}:${(buf.nicklist?.[g]?.nicks?.length ?? 0)}`).join(', ');
            console.log('[nicklist] after diff buffer', buf.shortName, 'groups:', groups.join(', '), '- nicks per group:', nickCounts);
        }
    }

    const updated = { ...current };
    for (const id of modifiedBuffers) {
        const buf = current[id];
        if (buf) {
            updated[id] = { ...buf, nicklist: { ...buf.nicklist } };
        }
    }
    console.log('[nicklist] updating buffers store with', modifiedBuffers.size, 'modified buffer(s)');
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
            if (manually) buffer.lastSeen++;
        }
    }

    buffers.set({ ...currentBuffers });
}

// ---- Event dispatch table ----
const eventHandlers: Record<string, (msg: ProtocolMessage) => void> = {
    '_buffer_cleared': handleBufferCleared,
    '_buffer_closing': handleBufferClosing,
    '_buffer_line_added': handleBufferLineAdded,
    '_buffer_localvar_added': handleBufferLocalvarChanged,
    '_buffer_localvar_removed': handleBufferLocalvarChanged,
    '_buffer_localvar_changed': handleBufferLocalvarChanged,
    '_buffer_moved': handleBufferMoved,
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
    '_nicklist_diff': handleNicklistDiff
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
