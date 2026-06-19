import { writable, get, derived } from 'svelte/store';

export const activeBufferChanged = writable(0);
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
export function createBuffer(message: {
    pointers: string[];
    full_name: string;
    short_name: string;
    title: RichTextPart[];
    hidden: number;
    number: number;
    type?: number;
    notify?: number;
    local_variables?: {
        type?: string;
        plugin?: string;
        server?: string;
        pinned?: string;
    };
}): BufferData {
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
        id: message.pointers[0] || '',
        fullName,
        shortName,
        hidden: !!message.hidden,
        trimmedName,
        nameClasses: [],
        prefix,
        number: message.number,
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

// Tracks buffer line count at last visit (for accurate lastSeen calculation)
export const bufferLineCounts = writable<Record<string, number>>({});

// Tracks which buffers have local-only unread messages (not reported by WeeChat).
// Used by handleHotlistChanged to avoid overwriting correct lastSeen with stale WeeChat data.
export const localUnreadBuffers = writable<Set<string>>(new Set());

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
            const cb = onSyncExit;
            onSyncExit = null;
            syncEndTimer = null;
            if (cb) cb();
        }, 200);
    }
}

export function isSyncing(): boolean {
    return syncing;
}

// Called when sync mode exits — recalculates lastSeen for buffers
// that have unread messages but haven't had lastSeen calculated yet.
let onSyncExit: (() => void) | null = null;
export function registerSyncExitCallback(cb: () => void) {
    onSyncExit = cb;
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

export function getLastLineCount(bufferId: string): number | undefined {
    return get(bufferLineCounts)[bufferId];
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
        prev.active = false;
        // Save line count when leaving this buffer (for lastSeen fallback on return).
        // Do NOT modify prev.lastSeen — let handleHotlistInfo / handleLineInfo manage it.
        const bufCopy = { ...prev };
        bufCopy.lines = [...prev.lines];
        bufferLineCounts.update(counts => ({ ...counts, [prevId]: bufCopy.lines.length }));
        previousBufferId.set(prevId);
    } else if (prevId) {
        console.log('[buffer switch]', '(none)', '→', buffer.shortName || buffer.fullName);
    }

    // Save total unread count from WeeChat hotlist before clearing.
    // This is used to calculate the correct lastSeen position (read marker).
    const totalUnread = (buffer.unread || 0) + (buffer.notification || 0);

    // Calculate lastSeen only if not already set. Existing lastSeen represents the
    // user's actual reading position and should be preserved on return.
    if (buffer.lastSeen < 0 && totalUnread > 0 && buffer.lines.length > 0) {
        buffer.lastSeen = Math.max(0, buffer.lines.length - totalUnread - 1);
    }

    buffer.active = true;
    buffer.unread = 0;
    buffer.notification = 0;
    buffer.localUnread = 0;

    activeBufferId.set(bufferId);
    activeBufferChanged.update(n => n + 1);
    buffers.set({ ...currentBuffers });
    return true;
}

export function clearAllUnread() {
    const currentBuffers = get(buffers);
    for (const id in currentBuffers) {
        const buf = currentBuffers[id];
        if (buf) {
            buf.unread = 0;
            buf.notification = 0;
        }
    }
    buffers.set({ ...currentBuffers });
    const currentServers = get(servers);
    for (const key in currentServers) {
        const srv = currentServers[key];
        if (srv) srv.unread = 0;
    }
    servers.set({ ...currentServers });
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
