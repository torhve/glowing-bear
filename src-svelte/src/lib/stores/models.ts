import { writable, get, derived } from "svelte/store";

export const activeBufferChanged = writable(0);
import { recordBuffer } from "$lib/stores/bufferResume";
import { settings } from "$lib/stores/settings";
import type {
    BufferData,
    BufferLine,
    Nick,
    NickGroup,
    RichTextPart,
} from "$lib/types";
import { Protocol } from "$lib/weechat";
import { DEBUG_BUFFERS } from "$lib/debug";

/**
 * Deep clone a BufferLine so that nested arrays (prefix, content) and their
 * classes sub-arrays are not shared with the original. Svelte 5 skips
 * re-rendering when array identity hasn't changed, so shallow clones break
 * reactivity for color classes.
 */
export function deepCloneBufferLine(l: BufferLine): BufferLine {
    return {
        ...l,
        prefix: l.prefix.map((p) => ({
            ...p,
            classes: p.classes ? [...p.classes] : undefined,
        })),
        content: l.content.map((p) => ({
            ...p,
            classes: p.classes ? [...p.classes] : undefined,
        })),
        metadata: l.metadata ? [...l.metadata] : undefined,
    };
}

// ---- Utility: convert rich text parts to HTML ----
export function richTextToHtml(parts: RichTextPart[]): string {
    if (!parts || parts.length === 0) return "";
    return parts
        .map((part) => {
            const escaped = part.text
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;");
            const classes = part.classes ? part.classes.join(" ") : "";
            return classes ? `<span class="${classes}">${escaped}</span>` : escaped;
        })
        .join("");
}

// ---- Utility: parse rich text (delegates to Protocol.rawText2Rich) ----
function buildClasses(part: {
  fgColor: { type: string; name: string };
  bgColor: { type: string; name: string };
  attrs: { name: string | null; override: Record<string, boolean> };
}): string[] {
    const classes: string[] = [];
    const prefixFg =
      part.fgColor.type === "option"
          ? "cof-"
          : part.fgColor.type === "weechat"
              ? "cwf-"
              : "cef-";
    const prefixBg =
      part.bgColor.type === "option"
          ? "cob-"
          : part.bgColor.type === "weechat"
              ? "cwb-"
              : "ceb-";
    classes.push(prefixFg + part.fgColor.name);
    classes.push(prefixBg + part.bgColor.name);
    if (part.attrs.name) {
        classes.push("coa-" + part.attrs.name);
    }
    for (const attr in part.attrs.override) {
        if (part.attrs.override[attr]) {
            classes.push("a-" + attr);
        } else {
            classes.push("a-no-" + attr);
        }
    }
    return classes;
}

export function parseRichText(text: string | undefined | null): RichTextPart[] {
    if (!text) {
        return [
            {
                text: text || "",
                fgColor: { type: "option", name: "default" },
                bgColor: { type: "option", name: "default" },
                attrs: { name: null, override: {} },
            },
        ];
    }
    const rawParts = Protocol.rawText2Rich(text);
    return rawParts.map((p) => ({
        text: p.text,
        fgColor: p.fgColor,
        bgColor: p.bgColor,
        attrs: p.attrs,
        classes: buildClasses(p),
    }));
}

/**
 * Calculate effective unread count for a buffer without double-counting.
 * handleBufferLineAdded increments both WeeChat counts (unread/notification)
 * AND localUnread for inactive buffers, so we must avoid summing all three.
 * Returns the maximum of (weechat counts + excess local unreads) vs just local.
 */
export function getEffectiveUnread(buffer: BufferData): number {
    const weechatUnread = (buffer.unread || 0) + (buffer.notification || 0);
    const localUnread = buffer.localUnread || 0;
    return Math.max(
        weechatUnread + Math.max(0, localUnread - weechatUnread),
        localUnread,
    );
}

// Sort buffers: pinned first, then by number. Optionally groups by server when orderByServer is true.
export function sortBuffers(
    buffersList: BufferData[],
    orderByServer: boolean,
): BufferData[] {
    const sorted = [...buffersList];
    sorted.sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        if (orderByServer) {
            const serverCmp =
              a.plugin.localeCompare(b.plugin) || a.server.localeCompare(b.server);
            if (serverCmp !== 0) return serverCmp;
        }
        return a.number - b.number;
    });
    return sorted;
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
  local_variables?: Record<string, string>;
}): BufferData {
    const id = (message.pointers && message.pointers[0]) || "";
    const fullName = message.full_name;
    const shortName = message.short_name;
    const trimmedName =
      shortName.replace(/^[#&+]/, "") || (shortName ? " " : null);
    const prefix = ["#", "&", "+"].includes(shortName.charAt(0))
        ? shortName.charAt(0)
        : "";
    const title = Array.isArray(message.title)
        ? message.title
        : message.title
            ? parseRichText(message.title)
            : [];
    const localVars = message.local_variables || {};
    const type = (localVars.type as BufferData["type"]) || "other";
    const indent = ["channel", "private", "query"].includes(type);
    const plugin = localVars.plugin || "";
    const server = localVars.server || "";
    const pinned = localVars.pinned === "true";
    const hideBufferLineTimes = message.type === 1;
    const serverSortKey =
      `${plugin}.${server}${type === "server" ? "" : "." + shortName}`.toLowerCase();

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
        rtitle: title.map((t) => t.text).join(""),
        lines: [],
        requestedLines: 0,
        allLinesFetched: false,
        lastSeen: -1,
        localUnread: 0,
        unread: 0,
        notification: 0,
        notify: message.notify ?? 3,
        nicklist: {},
        localVariables:
          Object.keys(localVars).length > 0 ? { ...localVars } : undefined,
        serverSortKey,
        indent,
        bufferType: message.type ?? 0,
        type,
        plugin,
        server,
        hideBufferLineTimes,
        pinned,
        active: false,
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

    const showHiddenBrackets =
      message.tags_array.includes("irc_privmsg") &&
      !message.tags_array.includes("irc_action");

    const prefixtext = prefix.map((p) => p.text).join("");

    // Add highlight class to prefix and content parts without mutating shared classes from parseRichText.
    // Each BufferLine must own its own classes array to avoid cross-line corruption.
    if (message.highlight) {
        prefix.forEach((p) => {
            p.classes = [...(p.classes || []), "highlight"];
        });
        content.forEach((p) => {
            p.classes = [...(p.classes || []), "highlight"];
        });
    }

    return {
        prefix,
        content,
        date: date.getTime(),
        shortTime: date.toLocaleTimeString("en-US", {
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
        }),
        formattedTime: date.toLocaleTimeString(),
        buffer: message.buffer,
        tags: message.tags_array,
        highlight: !!message.highlight,
        displayed: !!message.displayed,
        prefixtext,
        text: content.map((c) => c.text).join(""),
        showHiddenBrackets,
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
        const classes: string[] = ["cwf-default"];
        if (!colorStr) return classes;

        if (colorStr.startsWith("weechat")) {
            const match = colorStr.match(/[a-zA-Z0-9_]+$/);
            if (match) {
                return ["cof-" + match[0], "cob-" + match[0], "coa-" + match[0]];
            }
        } else if (/^[a-zA-Z]+(:|$)/.test(colorStr)) {
            const match = colorStr.match(/^[a-zA-Z]+/);
            if (match) classes[0] = "cwf-" + match[0];
        } else if (/^[0-9]+(:|$)/.test(colorStr)) {
            const match = colorStr.match(/^[0-9]+/);
            if (match) classes[0] = "cef-" + match[0];
        }

        if (/:([a-zA-Z]+)$/.test(colorStr)) {
            const match = colorStr.match(/:([a-zA-Z]+)$/);
            if (match) classes.push("cwb-" + match[1]);
        } else if (/:([0-9]+)$/.test(colorStr)) {
            const match = colorStr.match(/:([0-9]+)$/);
            if (match) classes.push("ceb-" + match[1]);
        }

        return classes;
    };

    return {
        prefix: message.prefix,
        visible: message.visible,
        name: message.name,
        prefixClasses: getNickColorClasses(message.prefix_color),
        nameClasses: getNickColorClasses(message.color),
        buffer: message.pointers[0] || "",
        spokeAt: Date.now(),
    };
}

// ---- NickGroup creation ----
export function createNickGroup(message: {
  name: string;
  visible: string;
}): NickGroup {
    return {
        name: message.name,
        visible: message.visible,
        nicks: [],
    };
}

// ---- Svelte Stores ----

export const buffers = writable<Record<string, BufferData>>({});

export const servers = writable<Record<string, { id: string; unread: number }>>(
    {},
);

export const activeBufferId = writable<string>("");

export const weechatVersion = writable<number[]>([]);

export const wconfig = writable<Record<string, string>>({});

export const connected = writable<boolean>(false);

export const reconnecting = writable<boolean>(false);

export const lastError = writable<number>(0);

// Stores the nickname of a user clicked in the nicklist so we can auto-switch to their private buffer once /query creates it; cleared on match or timeout
import { type Writable } from "svelte/store";
export const pendingBufferSwitch: Writable<string | null> = writable<
  string | null
>(null);

export const previousBufferId = writable<string>("");

// Tracks scroll Y position per buffer for read marker restoration
export const bufferScrollPositions = writable<Record<string, number>>({});

// Tracks which buffers have local-only unread messages (not reported by WeeChat).
// Used by setActiveBuffer to preserve lastSeen when switching back to buffers with unreads.
export const localUnreadBuffers = writable<Set<string>>(new Set());

// Tracks buffer IDs whose hotlist was explicitly cleared by setActiveBuffer but
// WeeChat may not have processed yet. Prevents handleHotlistInfo from restoring
// stale WeeChat counts during rapid buffer switching.
export const hotlistClearedBuffers = writable<Set<string>>(new Set());

// Tracks whether the user is scrolled to the bottom of the chat buffer.
// Used by handlers to avoid marking newly arrived lines as "unread" when
// the user is at the bottom (similar to AngularJS bufferBottom behavior).
export const bufferBottom = writable(true);

// Number of visible lines in the chat container, measured from actual DOM dimensions
// (container height / line height + 10). Default 100 used until first measurement.
export const linesPerScreen = writable(100);

// Max buffer lines for memory limiting: 2 screenfuls + 10, clamped to [200, 1000].
// Dynamic — recalculated when viewport/font changes via recalculateLinesPerScreen().
export const maxBufferLines = derived(linesPerScreen, ($lps) =>
    Math.min(1000, Math.max(200, 2 * $lps + 10)),
);

// Called by ChatView after measuring DOM dimensions on resize or font change.
export function recalculateLinesPerScreen(numLines: number) {
    linesPerScreen.set(Math.max(50, numLines));
}

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
    bufferScrollPositions.update((pos) => ({ ...pos, [bufferId]: scrollTop }));
}

// Save scroll position and line count when leaving a buffer (called before switching).
// Line count is captured at this moment to know how far the user had read.
export function saveBufferState(bufferId: string, scrollTop: number) {
    bufferScrollPositions.update((pos) => ({ ...pos, [bufferId]: scrollTop }));
}

export function getScrollPosition(bufferId: string): number | undefined {
    return get(bufferScrollPositions)[bufferId];
}

export const currentBuffer = derived(
    buffers,
    ($buffers: Record<string, BufferData>, set: (value: BufferData | null) => void) => {
        set($buffers[get(activeBufferId)] ?? null);
    },
);

// Visible buffers: filters out hidden buffers.
export const visibleBuffers = derived(buffers, ($buffers) =>
    Object.values($buffers).filter((b) => !b.hidden),
);

// Sorted visible buffers: combines filtering + sorting in a single reactive source.
export const sortedVisibleBuffers = derived(
    [buffers, settings],
    ([$buffers, $settings]) =>
        sortBuffers(
            Object.values($buffers).filter((b) => !b.hidden),
            $settings.orderbyserver,
        ),
);

// ---- Store helpers ----
export function addBuffer(buffer: BufferData) {
    // Use update() to merge with current store state, preventing overwrites
    // of concurrent changes from other handlers.
    buffers.update((current) => ({ ...current, [buffer.id]: buffer }));
}

export function getBuffer(bufferId: string): BufferData | undefined {
    return get(buffers)[bufferId];
}

/**
 * Shallow-copy a single buffer with partial field overrides.
 * Returns a new BufferData object — caller must apply via `buffers.update()` merge.
 */
/**
 * Shallow-copy a single buffer with partial field overrides.
 * Returns a new BufferData object — caller must apply via `buffers.update()` merge.
 */
export function updateBuffer(
    bufferId: string,
    overrides: Partial<BufferData>,
): BufferData | undefined {
    const buf = get(buffers)[bufferId];
    if (!buf) return undefined;
    return { ...buf, ...overrides };
}

/**
 * Deep-copy a buffer's mutable nested structures (lines, nicklist) along with field overrides.
 * Use this when handlers will mutate lines[] or nicklist[] arrays in-place after calling.
 * Returns a new BufferData object — caller must apply via `buffers.update()` merge.
 */
export function updateBufferDeep(
    bufferId: string,
    overrides: Partial<BufferData> = {},
): BufferData | undefined {
    const buf = get(buffers)[bufferId];
    if (!buf) return undefined;
    return {
        ...buf,
        lines: buf.lines.map(deepCloneBufferLine),
        nicklist: { ...buf.nicklist },
        localVariables: buf.localVariables ? { ...buf.localVariables } : undefined,
        ...overrides,
    };
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
        if (DEBUG_BUFFERS)
            console.log(
                "[buffer switch]",
                prev.shortName || prev.fullName,
                "→",
                buffer.shortName || buffer.fullName,
            );
        previousBufferId.set(prevId);
    } else if (prevId) {
        if (DEBUG_BUFFERS)
            console.log(
                "[buffer switch]",
                "(none)",
                "→",
                buffer.shortName || buffer.fullName,
            );
    }

    if (DEBUG_BUFFERS)
        console.log(
            "[setActiveBuffer] target:",
            buffer.shortName,
            "| lines:",
            buffer.lines.length,
            "| lastSeen:",
            buffer.lastSeen,
            "| localUnread:",
            buffer.localUnread,
            "| unread:",
            buffer.unread,
            "| notification:",
            buffer.notification,
        );

    // Compute effective unread count that avoids double-counting.
    const effectiveUnread = getEffectiveUnread(buffer);

    // Recalculate lastSeen from unread count whenever unread exists.
    // Use Math.max(effectiveUnread, localUnread) to handle hotlist race:
    // effectiveUnread may be 0 if hotlist hasn't synced yet, but localUnread
    // already tracks messages received while away from this buffer.
    let targetLastSeen = buffer.lastSeen;
    const pendingUnread = Math.max(effectiveUnread, buffer.localUnread ?? 0);
    if (buffer.lines.length > 0 && pendingUnread > 0) {
        targetLastSeen = Math.max(0, buffer.lines.length - pendingUnread - 1);
    } else if (targetLastSeen >= 0) {
        targetLastSeen = Math.min(targetLastSeen, buffer.lines.length - 1);
    }

    if (DEBUG_BUFFERS)
        console.log("[setActiveBuffer] targetLastSeen:", targetLastSeen);

    // Build a new buffers object with immutable updates to avoid in-place
    // mutations that can race with concurrent handler updates (e.g. hotlist).
    const updatedBuffers: Record<string, BufferData> = {};
    for (const id in currentBuffers) {
        const buf = currentBuffers[id];
        if (!buf) continue;
        if (id === prevId) {
            // Optimistically clear WeeChat-authoritative unread counts when leaving a buffer.
            // Prevents stale hotlist responses from overwriting correct local state
            // before WeeChat's clear commands have been processed.
            // Preserve localUnread — it tracks real-time messages received while this
            // buffer was active, which are NOT covered by the hotlist clear command.
            updatedBuffers[id] = {
                ...buf,
                active: false,
                lastSeen: buf.lines.length - 1,
                unread: 0,
                notification: 0,
            };
        } else if (id === bufferId) {
            updatedBuffers[id] = {
                ...buf,
                lines: buf.lines.map(deepCloneBufferLine),
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

    // Discard unread lines above dynamic limit to keep GB responsive when loading
    // buffers which have seen a lot of traffic (see issue #859). Adjust lastSeen
    // so the readmarker stays at the correct position relative to visible content.
    const maxLines = get(maxBufferLines);
    const targetLinesLength = updatedBuffers[bufferId]!.lines.length;
    if (targetLinesLength > maxLines) {
        const linesToRemove = targetLinesLength - maxLines;
      updatedBuffers[bufferId]!.lines.splice(0, linesToRemove);
      updatedBuffers[bufferId]!.requestedLines -= linesToRemove;
      targetLastSeen = Math.max(0, targetLastSeen - linesToRemove);
      // Clamp to the new buffer length so readmarker doesn't point past end.
      targetLastSeen = Math.min(
          targetLastSeen,
          updatedBuffers[bufferId]!.lines.length - 1,
      );
      updatedBuffers[bufferId]!.lastSeen = targetLastSeen;
      updatedBuffers[bufferId]!.allLinesFetched = false;
    }

    activeBufferId.set(bufferId);
    activeBufferChanged.update((n) => n + 1);
    // Use update() to merge only the changed buffers (prev and target) with
    // current store state, preventing overwrites of concurrent changes from
    // other handlers on unaffected buffers.
    buffers.update((current) => {
        const merged = { ...current };
        if (prevId && updatedBuffers[prevId]) {
            merged[prevId] = updatedBuffers[prevId];
        }
        if (updatedBuffers[bufferId]) merged[bufferId] = updatedBuffers[bufferId];
        return merged;
    });
    // Remove target buffer from localUnreadBuffers tracking since localUnread is now cleared.
    localUnreadBuffers.update((s: Set<string>) => {
        const copy = new Set(s);
        copy.delete(bufferId);
        return copy;
    });
    // Also remove the previous buffer from tracking — its localUnread was zeroed above.
    if (prevId && !currentBuffers[prevId]?.localUnread) {
        localUnreadBuffers.update((s: Set<string>) => {
            const copy = new Set(s);
            copy.delete(prevId);
            return copy;
        });
    }
    // Track the previous buffer as having been cleared — prevents handleHotlistInfo
    // from restoring stale WeeChat counts during rapid buffer switching.
    if (prevId) {
        hotlistClearedBuffers.update((s) => {
            const copy = new Set(s);
            copy.add(prevId);
            return copy;
        });
    }
    // Record the last-viewed buffer for reconnect auto-resume recovery.
    recordBuffer(bufferId, buffer.fullName);
    return true;
}

export function clearAllUnread() {
    // Clear all unread/notification counts and reset readmarkers to the end.
    // Also clear localUnread/lastSeen so readmarkers don't persist for
    // locally-tracked unreads that WeeChat's hotlist doesn't report.
    const current = get(buffers);
    const updatedBuffers: Record<string, BufferData> = {};
    for (const id in current) {
        const buf = current[id];
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
    // Use update() to merge with current store state, preventing overwrites
    // of concurrent changes from other handlers.
    buffers.update((c) => {
        const merged = { ...c };
        for (const id in updatedBuffers) {
            if (updatedBuffers[id]) merged[id] = updatedBuffers[id];
        }
        return merged;
    });
    localUnreadBuffers.update(() => new Set());
    hotlistClearedBuffers.update(() => new Set());

    const currentServers = get(servers);
    const updatedServers: Record<string, { id: string; unread: number }> = {};
    for (const key in currentServers) {
        const srv = currentServers[key];
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
    const rest = { ...current };
    delete rest[bufferId];
    // Use update() to merge with current store state, preventing overwrites
    // of concurrent changes from other handlers.
    buffers.update((c) => {
        const updated = { ...c };
        delete updated[bufferId];
        return updated;
    });

    if (wasActive) {
        const remaining = Object.keys(rest);
        if (remaining.length === 0) {
            activeBufferId.set("");
        } else {
            const firstId = remaining[0];
            if (firstId) setActiveBuffer(firstId);
        }
    }
}

export function checkAndNavigatePendingNotificationBuffer(): void {
    try {
        const pendingRaw = localStorage.getItem("gb_pendingNotificationBuffer");
        if (!pendingRaw) return;

        const pending = JSON.parse(pendingRaw) as {
          bufferId: string;
          timestamp: number;
      };
        if (DEBUG_BUFFERS)
            console.log(
                "[models] Found pending notification buffer:",
                pending.bufferId,
                "timestamp:",
                new Date(pending.timestamp).toISOString(),
            );

        const currentBuffers = get(buffers);
        if (pending.bufferId in currentBuffers) {
            if (DEBUG_BUFFERS)
                console.log("[models] Buffer exists, navigating to:", pending.bufferId);
            setActiveBuffer(pending.bufferId);
            localStorage.removeItem("gb_pendingNotificationBuffer");
        } else {
            console.warn(
                "[models] Pending buffer not found in store, clearing stale entry",
            );
            localStorage.removeItem("gb_pendingNotificationBuffer");
        }
    } catch (e) {
        console.error("[models] Error checking pending notification buffer:", e);
        try {
            localStorage.removeItem("gb_pendingNotificationBuffer");
        } catch {
            /* ignore */
        }
    }
}
