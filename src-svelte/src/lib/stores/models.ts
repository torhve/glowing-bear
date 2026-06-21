import { writable, get, derived } from 'svelte/store';

export const activeBufferChanged = writable(0);
import { recordBuffer } from '$lib/stores/bufferResume';
import type {
    BufferData,
    BufferLine,
    HotlistEntry,
    Nick,
    NickGroup,
    RichTextPart
} from '$lib/types';
import { Protocol } from '$lib/weechat';

// ---- Utility: convert rich text parts to HTML ----
export function richTextToHtml(parts: RichTextPart[]): string {
    if (!parts || parts.length === 0) return '';
    return parts.map(part => {
        const escaped = part.text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
        const classes = part.classes ? part.classes.join(' ') : '';
        return classes
            ? `<span class="${classes}">${escaped}</span>`
            : escaped;
    }).join('');
}

// ---- Utility: parse rich text (delegates to Protocol.rawText2Rich) ----
function buildClasses(part: { fgColor: { type: string; name: string }; bgColor: { type: string; name: string }; attrs: { name: string | null; override: Record<string, boolean> } }): string[] {
    const classes: string[] = [];
    const prefixFg = part.fgColor.type === 'option' ? 'cof-' : part.fgColor.type === 'weechat' ? 'cwf-' : 'cef-';
    const prefixBg = part.bgColor.type === 'option' ? 'cob-' : part.bgColor.type === 'weechat' ? 'cwb-' : 'ceb-';
    classes.push(prefixFg + part.fgColor.name);
    classes.push(prefixBg + part.bgColor.name);
    if (part.attrs.name) {
        classes.push('coa-' + part.attrs.name);
    }
    for (const attr in part.attrs.override) {
        if (part.attrs.override[attr]) {
            classes.push('a-' + attr);
        } else {
            classes.push('a-no-' + attr);
        }
    }
    return classes;
}

export function parseRichText(text: string | undefined | null): RichTextPart[] {
    if (!text) {
        return [{ text: text || '', fgColor: { type: 'option', name: 'default' }, bgColor: { type: 'option', name: 'default' }, attrs: { name: null, override: {} } }];
    }
    const rawParts = Protocol.rawText2Rich(text);
    return rawParts.map((p) => ({
        text: p.text,
        fgColor: p.fgColor,
        bgColor: p.bgColor,
        attrs: p.attrs,
        classes: buildClasses(p)
    }));
}

// ---- Buffer creation ----
// Accepts either a full BufferMessage from the protocol or a minimal shape
// with just { bufferId, fullName, shortName }. The latter is used for
// inline fallback when WeeChat auto-creates a query buffer from an incoming PM.
export function createBuffer(message: {
    pointers?: string[];
    full_name: string;
    short_name: string;
    title?: RichTextPart[] | string;
    hidden?: number;
    number?: number;
    type?: number;
    notify?: number;
    local_variables?: {
        type?: string;
        plugin?: string;
        server?: string;
        pinned?: string;
    };
}): BufferData {
    const id = (message.pointers && message.pointers[0]) || '';
    const fullName = message.full_name;
    const shortName = message.short_name;
    const trimmedName = shortName.replace(/^[#&+]/, '') || (shortName ? ' ' : null);
    const prefix = ['#', '&', '+'].includes(shortName.charAt(0)) ? shortName.charAt(0) : '';
    const title = Array.isArray(message.title) ? message.title : (message.title ? parseRichText(message.title) : []);
    const localVars = message.local_variables || {};
    const type = (localVars.type as BufferData['type']) || 'other';
    const indent = ['channel', 'private'].includes(type);
    const plugin = localVars.plugin || '';
    const server = localVars.server || '';
    const pinned = localVars.pinned === 'true';
    const hideBufferLineTimes = message.type === 1;
    const serverSortKey = `${plugin}.${server}${type === 'server' ? '' : '.' + shortName}`.toLowerCase();

    const buffer: BufferData = {
        id,
        fullName,
        shortName,
        hidden: !!message.hidden,
        trimmedName,
        nameClasses: [],
        prefix,
        number: message.number ?? 0,
        title,
        rtitle: title.map(t => t.text).join(''),
        lines: [],
        requestedLines: 0,
        allLinesFetched: false,
        lastSeen: -1,
        localUnread: 0,
        unread: 0,
        notification: 0,
        notify: message.notify ?? 3,
        nicklist: {},
        serverSortKey,
        indent,
        bufferType: message.type ?? 0,
        type,
        plugin,
        server,
        hideBufferLineTimes,
        pinned,
        active: false
    };

    return buffer;
}

// ---- BufferLine creation ----
export function createBufferLine(message: {
    buffer: string;
    date: number;
    date_long?: number;
    prefix?: string;
    message: string;
    tags_array: string[];
    displayed: number;
    highlight: number;
}): BufferLine {
    const date = new Date(message.date);
    const prefix = parseRichText(message.prefix);
    const content = parseRichText(message.message);

    const showHiddenBrackets = message.tags_array.includes('irc_privmsg') && !message.tags_array.includes('irc_action');

    const prefixtext = prefix.map(p => p.text).join('');

    // Add highlight class to prefix
    if (message.highlight) {
        prefix.forEach(p => {
            if (!p.classes) p.classes = [];
            p.classes.push('highlight');
        });
    }

    return {
        prefix,
        content,
        date: date.getTime(),
        shortTime: date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
        formattedTime: date.toLocaleTimeString(),
        buffer: message.buffer,
        tags: message.tags_array,
        highlight: !!message.highlight,
        displayed: !!message.displayed,
        prefixtext,
        text: content.map(c => c.text).join(''),
        showHiddenBrackets
    };
}

// ---- Nick creation ----
export function createNick(message: {
    pointers: string[];
    prefix: string;
    visible: string;
    name: string;
    color?: string;
    prefix_color?: string;
}): Nick {
    const getNickColorClasses = (colorStr?: string): string[] => {
        const classes: string[] = ['cwf-default'];
        if (!colorStr) return classes;

        if (colorStr.startsWith('weechat')) {
            const match = colorStr.match(/[a-zA-Z0-9_]+$/);
            if (match) {
                return ['cof-' + match[0], 'cob-' + match[0], 'coa-' + match[0]];
            }
        } else if (/^[a-zA-Z]+(:|$)/.test(colorStr)) {
            const match = colorStr.match(/^[a-zA-Z]+/);
            if (match) classes[0] = 'cwf-' + match[0];
        } else if (/^[0-9]+(:|$)/.test(colorStr)) {
            const match = colorStr.match(/^[0-9]+/);
            if (match) classes[0] = 'cef-' + match[0];
        }

        if (/:([a-zA-Z]+)$/.test(colorStr)) {
            const match = colorStr.match(/:([a-zA-Z]+)$/);
            if (match) classes.push('cwb-' + match[1]);
        } else if (/:([0-9]+)$/.test(colorStr)) {
            const match = colorStr.match(/:([0-9]+)$/);
            if (match) classes.push('ceb-' + match[1]);
        }

        return classes;
    };

    return {
        prefix: message.prefix,
        visible: message.visible,
        name: message.name,
        prefixClasses: getNickColorClasses(message.prefix_color),
        nameClasses: getNickColorClasses(message.color),
        buffer: message.pointers[0] || '',
        spokeAt: Date.now()
    };
}

// ---- NickGroup creation ----
export function createNickGroup(message: { name: string; visible: string }): NickGroup {
    return {
        name: message.name,
        visible: message.visible,
        nicks: []
    };
}

// ---- Svelte Stores ----

export const buffers = writable<Record<string, BufferData>>({});

export const servers = writable<Record<string, { id: string; unread: number }>>({});

export const activeBufferId = writable<string>('');

export const weechatVersion = writable<number[]>([]);

export const wconfig = writable<Record<string, string>>({});

export const connected = writable<boolean>(false);

export const reconnecting = writable<boolean>(false);

export const lastError = writable<number>(0);

export const angularTimeFormat = writable<string>('');

export const supportsFormattingDate = writable<boolean>(false);

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- intent: stores the nickname of a user clicked in the nicklist so we can auto-switch to their private buffer once /query creates it; cleared on match or timeout
export const pendingBufferSwitch: any = writable<string | null>(null);
export const hotlist = writable<HotlistEntry[]>([]);

export const previousBufferId = writable<string>('');

// Tracks scroll Y position per buffer for read marker restoration
export const bufferScrollPositions = writable<Record<string, number>>({});

// Tracks buffer line count at last visit.
export const bufferLineCounts = writable<Record<string, number>>({});

// Tracks which buffers have local-only unread messages (not reported by WeeChat).
// Used by setActiveBuffer to preserve lastSeen when switching back to buffers with unreads.
export const localUnreadBuffers = writable<Set<string>>(new Set());

// Tracks whether the user is scrolled to the bottom of the chat buffer.
// Used by handlers to avoid marking newly arrived lines as "unread" when
// the user is at the bottom (similar to AngularJS bufferBottom behavior).
export const bufferBottom = writable(true);

// Track whether we're in the initial post-connect sync phase.
// During this phase, lastSeen is not updated per-line — it's calculated
// after sync completes using: lastSeen = lines.length - unread - 1.
let syncing = false;
let syncEndTimer: ReturnType<typeof setTimeout> | null = null;

export function setSyncing(value: boolean) {
    if (value) {
        syncing = true;
        if (syncEndTimer) clearTimeout(syncEndTimer);
    } else {
        // Schedule exit from sync mode after a quiet period.
        // This allows rapid-fire sync lines to keep us in sync mode.
        syncEndTimer = setTimeout(() => {
            syncing = false;
            syncEndTimer = null;
        }, 200);
    }
}

export function isSyncing(): boolean {
    return syncing;
}


export function saveScrollPosition(bufferId: string, scrollTop: number) {
    bufferScrollPositions.update(pos => ({ ...pos, [bufferId]: scrollTop }));
}

// Save scroll position and line count when leaving a buffer (called before switching).
// Line count is captured at this moment to know how far the user had read.
export function saveBufferState(bufferId: string, scrollTop: number) {
    bufferScrollPositions.update(pos => ({ ...pos, [bufferId]: scrollTop }));
    const buf = get(buffers)[bufferId];
    if (buf) {
        bufferLineCounts.update(counts => ({ ...counts, [bufferId]: buf.lines.length }));
    }
}

export function getScrollPosition(bufferId: string): number | undefined {
    return get(bufferScrollPositions)[bufferId];
}

export const currentBuffer = derived(
    [buffers, activeBufferId],
    ([$buffers, $activeBufferId]) => $buffers[$activeBufferId] || null
);

// ---- Store helpers ----
export function addBuffer(buffer: BufferData) {
    const current = get(buffers);
    buffers.set({ ...current, [buffer.id]: buffer });
}

export function getBuffer(bufferId: string): BufferData | undefined {
    return get(buffers)[bufferId];
}

export function getBuffers(): Record<string, BufferData> {
    return get(buffers);
}

export function setActiveBuffer(bufferId: string): boolean {
    const currentBuffers = get(buffers);
    const buffer = currentBuffers[bufferId];
    if (!buffer) return false;

  const prevId = get(activeBufferId);
    if (prevId && currentBuffers[prevId]) {
        const prev = currentBuffers[prevId];
        console.log('[buffer switch]', prev.shortName || prev.fullName, '→', buffer.shortName || buffer.fullName);
        bufferLineCounts.update(counts => ({ ...counts, [prevId]: prev.lines.length }));
        previousBufferId.set(prevId);
    } else if (prevId) {
        console.log('[buffer switch]', '(none)', '→', buffer.shortName || buffer.fullName);
    }

    const savedLineCount = buffer.lines.length;

    console.log('[setActiveBuffer] target:', buffer.shortName, '| lines:', buffer.lines.length, '| lastSeen:', buffer.lastSeen, '| localUnread:', buffer.localUnread, '| unread:', buffer.unread, '| notification:', buffer.notification);

    // Compute effective unread count that avoids double-counting.
    // handleBufferLineAdded increments both unread AND localUnread for
    // inactive buffers with notify > 1. Use weechatUnread plus the excess
    // to account for messages not tracked in the WeeChat hotlist.
    const weechatUnread = (buffer.unread || 0) + (buffer.notification || 0);
    const localUnread = (buffer.localUnread || 0);
    const effectiveUnread = weechatUnread + Math.max(0, localUnread - weechatUnread);

    // Recalculate lastSeen from effective unread whenever unread exists,
    // to handle stale values set during sync before the hotlist was processed.
    let targetLastSeen = buffer.lastSeen;
    if (buffer.lines.length > 0 && effectiveUnread > 0) {
        targetLastSeen = Math.max(0, buffer.lines.length - effectiveUnread - 1);
    } else if (targetLastSeen >= 0) {
        targetLastSeen = Math.min(targetLastSeen, buffer.lines.length - 1);
    }

    console.log('[setActiveBuffer] targetLastSeen:', targetLastSeen);

    // Build a new buffers object with immutable updates to avoid in-place
    // mutations that can race with concurrent handler updates (e.g. hotlist).
    const updatedBuffers: Record<string, BufferData> = {};
    for (const id in currentBuffers) {
        const buf = currentBuffers[id];
        if (!buf) continue;
        if (id === prevId) {
            // Optimistically clear unread counts when leaving a buffer.
            // Prevents stale hotlist responses from overwriting correct local state
            // before WeeChat's clear commands have been processed.
            updatedBuffers[id] = {
                ...buf,
                active: false,
                lastSeen: buf.lines.length - 1,
                unread: 0,
                notification: 0,
                localUnread: 0,
            };
        } else if (id === bufferId) {
            updatedBuffers[id] = {
                ...buf,
                lines: [...buf.lines],
                nicklist: { ...buf.nicklist },
                active: true,
                lastSeen: targetLastSeen,
                unread: 0,
                notification: 0,
                localUnread: 0,
            };
        } else {
            updatedBuffers[id] = buf;
        }
    }

    // Discard unread lines above 2 screenfuls to keep GB responsive when loading
    // buffers which have seen a lot of traffic (see issue #859). Adjust lastSeen
    // so the readmarker stays at the correct position relative to visible content.
    const linesPerScreen = 100;
    const maxLines = 2 * linesPerScreen + 10;
    const targetLinesLength = updatedBuffers[bufferId]!.lines.length;
    if (targetLinesLength > maxLines) {
        const linesToRemove = targetLinesLength - maxLines;
        updatedBuffers[bufferId]!.lines.splice(0, linesToRemove);
        updatedBuffers[bufferId]!.requestedLines -= linesToRemove;
        targetLastSeen = Math.max(0, targetLastSeen - linesToRemove);
        // Clamp to the new buffer length so readmarker doesn't point past end.
        targetLastSeen = Math.min(targetLastSeen, updatedBuffers[bufferId]!.lines.length - 1);
        updatedBuffers[bufferId]!.lastSeen = targetLastSeen;
        updatedBuffers[bufferId]!.allLinesFetched = false;
    }

    activeBufferId.set(bufferId);
    activeBufferChanged.update(n => n + 1);
    buffers.set(updatedBuffers);
    bufferLineCounts.update(counts => ({ ...counts, [bufferId]: savedLineCount }));
    // Remove target buffer from localUnreadBuffers tracking since localUnread is now cleared.
    localUnreadBuffers.update((s: Set<string>) => { const copy = new Set(s); copy.delete(bufferId); return copy; });
    // Also remove the previous buffer — its localUnread was zeroed above.
    if (prevId) {
        localUnreadBuffers.update((s: Set<string>) => { const copy = new Set(s); copy.delete(prevId); return copy; });
    }
    // Record the last-viewed buffer for reconnect auto-resume recovery.
    recordBuffer(bufferId);
    return true;
}

export function clearAllUnread() {
    // Build immutable copies of all buffers and servers to ensure
    // Svelte reactivity triggers correctly.
    // Also clear localUnread/lastSeen so readmarkers don't persist for
    // locally-tracked unreads that WeeChat's hotlist doesn't report.
    const updatedBuffers: Record<string, BufferData> = {};
    for (const id in get(buffers)) {
        const buf = get(buffers)[id];
        if (buf) {
            updatedBuffers[id] = {
                ...buf,
                unread: 0,
                notification: 0,
                localUnread: 0,
                lastSeen: buf.lines.length - 1,
            };
        }
    }
    buffers.set(updatedBuffers);
    localUnreadBuffers.update(() => new Set());

    const updatedServers: Record<string, { id: string; unread: number }> = {};
    for (const key in get(servers)) {
        const srv = get(servers)[key];
        if (srv) {
            updatedServers[key] = { ...srv, unread: 0 };
        }
    }
    servers.set(updatedServers);
}

export function closeBuffer(bufferId: string) {
    const current = get(buffers);
    const buffer = current[bufferId];
    if (!buffer) return;

    removeBuffer(bufferId, buffer.active);
}

export function removeBuffer(bufferId: string, wasActive: boolean) {
    const current = get(buffers);
    delete current[bufferId];
    buffers.set({ ...current });

    if (wasActive) {
        const remaining = Object.keys(current);
        if (remaining.length === 0) {
            activeBufferId.set('');
        } else {
            const firstId = remaining[0];
            if (firstId) setActiveBuffer(firstId);
        }
    }
}

export function checkAndNavigatePendingNotificationBuffer(): void {
    try {
        const pendingRaw = localStorage.getItem('gb_pendingNotificationBuffer');
        if (!pendingRaw) return;
        
        const pending = JSON.parse(pendingRaw) as { bufferId: string; timestamp: number };
        console.log('[models] Found pending notification buffer:', pending.bufferId, 'timestamp:', new Date(pending.timestamp).toISOString());
        
        const currentBuffers = get(buffers);
        if (pending.bufferId in currentBuffers) {
            console.log('[models] Buffer exists, navigating to:', pending.bufferId);
            setActiveBuffer(pending.bufferId);
            localStorage.removeItem('gb_pendingNotificationBuffer');
        } else {
            console.warn('[models] Pending buffer not found in store, clearing stale entry');
            localStorage.removeItem('gb_pendingNotificationBuffer');
        }
    } catch (e) {
        console.error('[models] Error checking pending notification buffer:', e);
        try {
            localStorage.removeItem('gb_pendingNotificationBuffer');
        } catch { /* ignore */ }
    }
}
