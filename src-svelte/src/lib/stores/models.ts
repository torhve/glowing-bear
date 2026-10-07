import { writable, get, derived } from "svelte/store";

export const activeBufferChanged = writable(0);
import { recordLastBuffer } from "#lib/stores/bufferResume.ts";
import { settings } from "#lib/stores/settings.ts";
import type {
    BufferData,
    BufferLine,
    BufferType,
    Nick,
    NickGroup,
    PendingQuery,
    RichTextPart,
} from "#lib/types.ts";
import { rawText2Rich, parseWeechatNickColor } from "#lib/weechat-colors.ts";
import { DEBUG_BUFFERS } from "#lib/debug.ts";

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

// ---- Utility: parse rich text (delegates to the standalone color parser) ----
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
    const rawParts = rawText2Rich(text);
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

/**
 * WeeChat's relay plugin re-renders its own status buffers (relay.list) whenever a
 * relay client connects or disconnects, and drops them into the hotlist while doing
 * so (relay_buffer_refresh). That is bookkeeping, not unread activity, so these
 * buffers must never carry unread/notification state in Glowing Bear. The relay
 * plugin only ever creates relay.list and relay.raw, so matching its plugin is the
 * same criterion WeeChat applies internally (relay_buffer_is_relay); the type check
 * is a fallback for buffers that report a relay type without the plugin variable.
 */
export function isRelayStatusBuffer(buffer: BufferData): boolean {
    return buffer.plugin === 'relay' || buffer.type === 'relay';
}

/** Classify display lines independently from notification eligibility. */
export function isUserMessageLine(line: BufferLine): boolean {
    if (line.isDateSeparator) return false;
    if (line.isUserMessage !== undefined) return line.isUserMessage;
    const tags = line.tags || [];
    if (tags.some((tag) => ['irc_privmsg', 'irc_action', 'irc_notice'].includes(tag))) return true;
    if (tags.some((tag) => ['notify_message', 'notify_private', 'notify_highlight'].includes(tag))) return true;
    if (tags.includes('notify_none')) return false;
    // Non-IRC conversational buffers can contain real messages without IRC tags.
    if (!tags.some((tag) => tag.startsWith('irc_'))) return (line.notifyLevel ?? 1) > 0;
    return false;
}

/** Infer the last read row from an initial hotlist count when no saved boundary exists. */
function inferReadBoundaryFromHotlist(buffer: BufferData, unreadCount: number): number | null {
    // No lines means nothing to anchor: stay unknown until history loads, because
    // a boundary pinned before the first line would make every later line unread.
    if (buffer.lines.length === 0) return null;
    if (unreadCount <= 0) return buffer.lines.length - 1;

    let remaining = unreadCount;
    for (let index = buffer.lines.length - 1; index >= 0; index--) {
        const line = buffer.lines[index]!;
        const hotlistEligible = (line.notifyLevel ?? (isUserMessageLine(line) ? 1 : 0)) > 0;
        if (!hotlistEligible) continue;
        remaining--;
        if (remaining !== 0) continue;

        // Include status/date rows immediately preceding the oldest counted message.
        let boundary = index - 1;
        while (boundary >= 0 && !isUserMessageLine(buffer.lines[boundary]!)) boundary--;
        return boundary;
    }

    // Insufficient history cannot establish where the unread region starts.
    return null;
}

/** Find a unique line anchor; duplicate legacy fallback IDs are ambiguous. */
function findUniqueLineIndex(lines: BufferLine[], lineId: string): number | null {
    let found = -1;
    let matches = 0;
    lines.forEach((line, index) => {
        if (line.lineId === lineId) {
            found = index;
            matches++;
        }
    });
    return matches === 1 ? found : matches === 0 ? -1 : null;
}

/** Return the current boundary index, or null when reconnect made it uncertain. */
export function getReadBoundaryIndex(buffer: BufferData): number | null {
    if (buffer.readBoundaryKnown === false) return null;
    if (buffer.readBoundaryId === null) return -1;
    if (buffer.readBoundaryId !== undefined) {
        const index = findUniqueLineIndex(buffer.lines, buffer.readBoundaryId);
        if (index !== null && index >= 0) return index;
        return buffer.lines.length === 0 ? -1 : null;
    }
    // Compatibility for test fixtures and state written before line identities existed.
    return buffer.lastSeen >= 0
        ? Math.min(buffer.lastSeen, buffer.lines.length - 1)
        : null;
}

/** Set a known read boundary without using a synthetic date row as an anchor. */
export function setReadBoundary(buffer: BufferData, index: number): void {
    // An empty buffer has nothing to anchor to. Pinning a boundary before its
    // first line would make every line that later loads — history paging or
    // replayed lines — count as unread, so an empty buffer stays unknown.
    if (buffer.lines.length === 0) {
        setReadBoundaryUnknown(buffer);
        return;
    }
    const clamped = Math.max(-1, Math.min(index, buffer.lines.length - 1));
    const boundaryLineId = clamped >= 0 ? buffer.lines[clamped]?.lineId : undefined;
    if (boundaryLineId !== undefined && findUniqueLineIndex(buffer.lines, boundaryLineId) === null) {
        setReadBoundaryUnknown(buffer);
        return;
    }
    buffer.readBoundaryKnown = true;
    buffer.readBoundaryId = clamped >= 0 ? boundaryLineId : null;
    buffer.lastSeen = clamped;
    buffer.pendingReadBoundaryUnread = 0;
}

/** Mark a buffer as having no trustworthy positional boundary after replacement. */
export function setReadBoundaryUnknown(buffer: BufferData): void {
    buffer.readBoundaryKnown = false;
    buffer.readBoundaryId = null;
    buffer.lastSeen = -1;
}

/** Retry a deferred hotlist boundary once enough history is available. */
export function resolvePendingReadBoundary(buffer: BufferData): boolean {
    const pendingUnread = buffer.pendingReadBoundaryUnread || 0;
    if (pendingUnread <= 0) return false;
    const inferredBoundary = inferReadBoundaryFromHotlist(buffer, pendingUnread);
    if (inferredBoundary === null) return false;
    setReadBoundary(buffer, inferredBoundary);
    return buffer.readBoundaryKnown !== false;
}

/**
 * Index of WeeChat's own read marker among the retained lines, or null when the
 * transport never reported one, reported none (-1), or the marked line is not
 * in the retained window.
 */
export function findServerReadBoundaryIndex(buffer: BufferData): number | null {
    const marker = buffer.serverReadLineId;
    if (marker === undefined || marker < 0) return null;
    const index = findUniqueLineIndex(buffer.lines, `weechat:${marker}`);
    return index !== null && index >= 0 ? index : null;
}

/** Anchor the boundary to WeeChat's marker when the retained history contains it. */
export function reanchorReadBoundaryFromServer(buffer: BufferData): boolean {
    const index = findServerReadBoundaryIndex(buffer);
    if (index === null) return false;
    setReadBoundary(buffer, index);
    return true;
}

/**
 * Resolve an unresolved boundary once the buffer actually has lines.
 *
 * Priority: WeeChat's own marker (exact), then the hotlist count, and finally
 * "the retained history is read" — a buffer with no hotlist entry is read as far
 * as WeeChat is concerned, and leaving its boundary unresolved would make the
 * chat view count every retained line as new.
 *
 * The count-based half is skipped while the sync phase is open: until this
 * connection's hotlist baseline has been applied, a zero count is not yet
 * evidence of "read", and establishing the boundary then would lock out the real
 * counts that arrive moments later (the hotlist reducer only defers a boundary
 * that is still unresolved).
 */
export function resolveReadBoundaryAfterHistory(buffer: BufferData): boolean {
    // Tri-state: true is established, false is explicitly uncertain, undefined is
    // "never established". Only an established boundary is left alone.
    if (buffer.readBoundaryKnown === true) return false;
    if (reanchorReadBoundaryFromServer(buffer)) return true;
    if (isSyncing()) return false;
    const index = inferReadBoundaryFromHotlist(
        buffer,
        Math.max(buffer.pendingReadBoundaryUnread || 0, getEffectiveUnread(buffer)),
    );
    if (index === null) return false;
    setReadBoundary(buffer, index);
    return true;
}

/**
 * Apply WeeChat's authoritative read marker (API transport `last_read_line_id`).
 *
 * A marker that is not among the retained lines is NOT evidence that every line
 * is unread: the bootstrap snapshot requests `lines=0`, so "not found" is the
 * normal first response, and -1 simply means WeeChat has no marker. In both
 * cases the id is remembered so a later history fetch can anchor it exactly, and
 * the boundary is left as it is: unknown until something establishes it, or the
 * boundary this session already committed. Unread counts stay with the hotlist,
 * which is the authoritative source for them.
 *
 * Re-anchoring is limited to an unresolved boundary for the same reason
 * `applyHistory` limits it: a snapshot that arrives after the user has read to
 * the bottom carries WeeChat's older marker, and honouring it would resurrect
 * unread the user has already seen.
 */
export function applyServerReadMarker(buffer: BufferData, lastReadLineId: number): void {
    buffer.serverReadLineId = lastReadLineId;
    if (buffer.readBoundaryKnown !== true) reanchorReadBoundaryFromServer(buffer);
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
        readBoundaryKnown: false,
        readBoundaryId: null,
        pendingReadBoundaryUnread: 0,
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

/**
 * Short (HH:MM) timestamp formatter used for every buffer line.
 *
 * `date.toLocaleTimeString("en-US", {hour, minute, hour12})` re-resolves the whole
 * locale + options bag on every call: measured 29.6 µs/call in Node 26 / V8 on an
 * M1 Pro, versus 0.67 µs for `format()` on a formatter built once — a ~45x
 * difference on a per-line hot path. Per ECMA-413, toLocaleTimeString(locale,
 * options) is exactly GetOrCreateDateTimeFormat(locale, options).format(this), so
 * the two produce the same string.
 *
 * The formatter itself is still 12% of the flood workload, so the common case
 * bypasses it: when the formatter resolves to the h23 hour cycle its output is
 * exactly `zero-padded local hour : zero-padded local minute`, which is two
 * Date accessors and a string concat (68 ns versus 672 ns, verified identical
 * over 401k dates). If a platform ever resolved en-US + hour12:false to a
 * different hour cycle the Intl formatter is used instead, so the produced
 * string cannot differ from the original expression.
 *
 * Invalid dates keep the built-in behaviour: format() throws RangeError where
 * toLocaleTimeString returns "Invalid Date".
 */
const SHORT_TIME_OPTIONS: Intl.DateTimeFormatOptions = {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
};
const SHORT_TIME_FORMAT = new Intl.DateTimeFormat("en-US", SHORT_TIME_OPTIONS);
const SHORT_TIME_IS_H23 = SHORT_TIME_FORMAT.resolvedOptions().hourCycle === "h23";

const pad2 = (n: number): string => (n < 10 ? "0" : "") + n;

/** HH:MM in en-US, identical to date.toLocaleTimeString("en-US", SHORT_TIME_OPTIONS). */
export function formatShortTime(date: Date, time: number): string {
    if (Number.isNaN(time)) {
        return date.toLocaleTimeString("en-US", SHORT_TIME_OPTIONS);
    }
    if (SHORT_TIME_IS_H23) {
        return pad2(date.getHours()) + ":" + pad2(date.getMinutes());
    }
    return SHORT_TIME_FORMAT.format(date);
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
  notify_level?: number;
  highlight: number;
  id?: string | number;
  bufferType?: BufferType;
}): BufferLine {
    const date = new Date(message.date);
    const time = date.getTime();
    const prefix = parseRichText(message.prefix);
    const content = parseRichText(message.message);
    const tags = message.tags_array || [];
    const notifyLevel = message.notify_level ?? 0;
    const isUserMessage =
        tags.some((tag) => ['irc_privmsg', 'irc_action', 'irc_notice', 'notify_message', 'notify_private', 'notify_highlight'].includes(tag)) ||
        (!tags.some((tag) => tag.startsWith('irc_')) && !tags.includes('notify_none') &&
            (message.bufferType ? message.bufferType !== 'server' : notifyLevel > 0));
    // Prefer WeeChat's optional id; the deterministic fallback lets older relays remap
    // a boundary across a history refresh when the line content is unchanged.
    const lineId = message.id !== undefined
        ? `weechat:${String(message.id)}`
        : `line:${message.buffer}:${message.date}:${message.prefix || ''}:${message.message}:${tags.join(',')}`;

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
        date: time,
        shortTime: formatShortTime(date, time),
        buffer: message.buffer,
        tags,
        highlight: !!message.highlight,
        displayed: !!message.displayed,
        prefixtext,
        text: content.map((c) => c.text).join(""),
        showHiddenBrackets,
        lineId,
        notifyLevel,
        isUserMessage,
        isDateSeparator: false,
    };
}

// ---- Date-change separator injection (moved from the legacy handlers at
// cutover; pure model logic used by both history and live line paths) ----
/**
 * Inject a "day changed" separator when the new line falls on a different local
 * day than the buffer's last line.
 *
 * Timestamps may be passed as plain numbers as well as Dates. The hot path has
 * millisecond timestamps already, and building two Date objects plus two
 * `setHours` calls per line measured 343 ns — about 5% of the flood workload —
 * to answer a question that is four number comparisons once the local day
 * window is known.
 *
 * `localDayStart`/`localDayEnd` cache the half-open window
 * [start of day, start of next day) computed from a timestamp with the same
 * `setHours(0, 0, 0, 0)` rounding the exact comparison below uses. Any two
 * timestamps inside one such window are on the same local day, so the cache can
 * only ever prove a true "same day"; a stale or partial window just falls
 * through to the exact comparison. DST days (23 or 25 hours, or a day whose
 * local midnight does not exist) stay correct for the same reason: they can
 * make the fast path miss, never guess wrong.
 */
export function injectDateChangeMessageIfNeeded(
    buffer: BufferData,
    manually: boolean,
    oldDate: Date | number,
    newDate: Date | number,
) {
    if (buffer.bufferType === 1) return; // Free buffers

    const oldMs = typeof oldDate === "number" ? oldDate : oldDate.getTime();
    const newMs = typeof newDate === "number" ? newDate : newDate.getTime();

    const cachedStart = buffer.localDayStart;
    const cachedEnd = buffer.localDayEnd;
    if (
        cachedStart !== undefined &&
        cachedEnd !== undefined &&
        oldMs >= cachedStart &&
        oldMs < cachedEnd &&
        newMs >= cachedStart &&
        newMs < cachedEnd
    ) {
        return; // Both timestamps lie in one cached local-day window.
    }

    // Rebuild the window around the older timestamp and retry. A real day
    // change happens a couple of times a day, so this is not the common path.
    const window = new Date(oldMs);
    window.setHours(0, 0, 0, 0);
    const dayStart = window.getTime();
    window.setDate(window.getDate() + 1);
    window.setHours(0, 0, 0, 0);
    const dayEnd = window.getTime();
    buffer.localDayStart = dayStart;
    buffer.localDayEnd = dayEnd;
    if (newMs >= dayStart && newMs < dayEnd) return;

    // Exact path: identical to the original comparison, on fresh Dates so the
    // caller's values are left alone.
    const oldDay = typeof oldDate === "number" ? new Date(oldDate) : oldDate;
    const newDay = typeof newDate === "number" ? new Date(newDate) : newDate;
    oldDay.setHours(0, 0, 0, 0);
    newDay.setHours(0, 0, 0, 0);

    if (oldDay.valueOf() === newDay.valueOf()) return;

    // Legacy callers without boundary metadata still receive the old index
    // update; production buffers use stable line identities instead.
    if (manually && buffer.readBoundaryKnown === undefined) buffer.lastSeen++;
    const datePlusOne = new Date(oldDay.getTime());
    datePlusOne.setDate(datePlusOne.getDate() + 1);
    datePlusOne.setHours(0, 0, 0, 0);

    let content = `\u001943\u2500`; // Day change color (code 43 = chat_day_change) + box drawing

    // Add day of week
    const weekdays = [
        "Sunday",
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
    ];
    content += weekdays[newDay.getDay()] + " (";
    content += newDay.toLocaleDateString(undefined, {
        month: "long",
        day: "numeric",
    });

    if (newDay.getFullYear() !== oldDay.getFullYear()) {
        content += `, ${newDay.getFullYear()}`;
    }

    if (datePlusOne.valueOf() !== newDay.valueOf()) {
        const diff =
          Math.round(
              (newDay.getTime() - oldDay.getTime()) / (24 * 60 * 60 * 1000),
          ) + 1;
        if (diff < 0) {
            content += `, ${Math.abs(diff)} days before`;
        } else {
            content += `, ${diff} days later`;
        }
    }

    content += ")";

    const dateLine = createBufferLine({
        buffer: buffer.id,
        date: newDay.getTime(),
        date_long: 0,
        prefix: "\u001943\u2500",
        message: content,
        tags_array: [],
        displayed: 1,
        notify_level: 0,
        highlight: 0,
    });
    dateLine.lineId = `date:${buffer.id}:${newDay.getTime()}`;
    dateLine.isDateSeparator = true;
    dateLine.isUserMessage = false;

    buffer.lines.push(dateLine);
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
        // WeeChat internal color code (new API `colors=weechat` encoding):
        // resolve through the shared color parser, keep default if unparseable.
        if (colorStr.includes("\x19")) {
            return parseWeechatNickColor(colorStr) ?? ["cwf-default"];
        }

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
// Relay API version string (e.g. "0.6.0") when connected over the new API
// transport; empty on the legacy transport or while disconnected.
export const relayApiVersion = writable<string>("");

export const wconfig = writable<Record<string, string>>({});

export const connected = writable<boolean>(false);

export const reconnecting = writable<boolean>(false);

export const lastError = writable<number>(0);

// A pending auto-switch to a private/query buffer WeeChat has not opened yet. The
// nick alone is not enough: two IRC servers can each open a query buffer for the
// same nick, so the originating server is carried along (null = context unknown).
// `requestId` identifies one request so an older click timeout cannot clear a
// newer identical request.
let pendingSwitchRequestSeq = 0;

/** Fresh pending-switch payload for `nick` inside the `server` context. */
export function newPendingSwitch(nick: string, server: string | null): PendingQuery {
    return { nick, server, requestId: ++pendingSwitchRequestSeq };
}

/** Whether a buffer that just opened is the one a pending switch asked for. */
export function matchesPendingSwitch(buffer: BufferData, pending: PendingQuery | null): boolean {
    if (!pending) return false;
    if (buffer.shortName.toLowerCase() !== pending.nick.toLowerCase()) return false;
    return pending.server === null || buffer.server === pending.server;
}

/** Clear the pending switch only while it is still the request `requestId`
 * belongs to, so an older click timeout cannot drop a newer request. */
export function clearPendingSwitchIfCurrent(requestId: number): void {
    if (get(pendingBufferSwitch)?.requestId === requestId) pendingBufferSwitch.set(null);
}

import { type Writable } from "svelte/store";
export const pendingBufferSwitch: Writable<PendingQuery | null> = writable<PendingQuery | null>(null);

export const previousBufferId = writable<string>("");

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

/*
 * Sync phase: the window in which WeeChat's hotlist counts are about to become
 * authoritative for a connection. It is owned by the connection init that actually
 * awaits both round trips: opened just before the buffer snapshot is requested and
 * closed once this connection's hotlist baseline has been applied. Both bounds are
 * protocol events the client explicitly awaits, so the phase is bounded by the round
 * trip that defines it — it cannot outlive the baseline, and it never suppresses
 * unread counters merely because history is slow.
 *
 * The phase is generation-scoped: beginSyncPhase() returns the generation it opened,
 * and endSyncPhase(generation) ignores a generation that is no longer current. A
 * superseded connect attempt that fails late therefore cannot close a newer
 * connection's phase, and the periodic hotlist poll (which holds no generation)
 * cannot close it either. endSyncPhase() without an argument is the unconditional
 * exit used by disconnect; it is also what a unit test uses to model a baseline.
 *
 * Stale responses are a separate, already-solved concern: connectionManager's
 * connectionGeneration discards messages from superseded sockets (onMessage) and
 * resetAllState() rejects their pending callbacks, so a superseded attempt can never
 * apply an old buffer or hotlist snapshot in the first place.
 *
 * Read-boundary resolution is a separate, per-buffer lifecycle and is deliberately
 * not part of this flag: a buffer stays `readBoundaryKnown === false` until history
 * or an explicit read action proves where the boundary falls (setActiveBuffer ->
 * pendingReadBoundaryUnread -> resolvePendingReadBoundary, or the post-baseline rule
 * in handleLineInfo).
 */
let syncGeneration = 0;
let baselinePending = false;
let baselineApplied = false;

/** Open the sync phase for a new connection; returns its generation token. */
export function beginSyncPhase(): number {
    syncGeneration += 1;
    baselinePending = true;
    baselineApplied = false;
    return syncGeneration;
}

/**
 * Record that a hotlist baseline has been applied, so the counts behind a read
 * boundary are authoritative. Called by both transports when they apply the
 * baseline (API hotlist reducer, legacy handleHotlistInfo).
 */
export function markHotlistBaselineApplied(): void {
    // Only an open phase can be authorized; a poll outside a phase marks nothing,
    // and a close that never saw a baseline resolves nothing from counts.
    if (baselinePending) baselineApplied = true;
}

/**
 * Closing is a protocol event: when a hotlist baseline has actually been applied,
 * buffers whose boundary could not be placed earlier can be resolved, because a
 * zero count was not evidence of "read" before the baseline and is after it. A
 * cancelled or failed attempt applied no baseline, so it must not resolve anything
 * from counts that never arrived.
 */
export function endSyncPhase(generation?: number): void {
    if (generation !== undefined && generation !== syncGeneration) return;
    baselinePending = false;
    if (!baselineApplied) return;
    baselineApplied = false;
    resolveUnresolvedReadBoundaries();
}

/** Place every still-unresolved read boundary now that the baseline is in. */
function resolveUnresolvedReadBoundaries(): void {
    buffers.update((current) => {
        const copy: Record<string, BufferData> = {};
        let changed = false;
        for (const id in current) {
            const buf = current[id];
            if (!buf) continue;
            if (buf.readBoundaryKnown === true) {
                copy[id] = buf;
                continue;
            }
            const updated = { ...buf };
            if (resolveReadBoundaryAfterHistory(updated)) {
                changed = true;
                copy[id] = updated;
            } else {
                copy[id] = buf;
            }
        }
        return changed ? copy : current;
    });
}

export function isSyncing(): boolean {
    return baselinePending;
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
 * Find a buffer by short name and type filter (case-insensitive).
 * Used for /query to locate existing PM buffers before creating new ones.
 */
export function findBufferByShortName(
    name: string,
    types?: BufferType[],
    server?: string | null,
): BufferData | undefined {
    const lower = name.toLowerCase();
    return Object.values(get(buffers)).find((b) => {
        if (b.shortName.toLowerCase() !== lower) return false;
        if (types && types.length > 0 && !types.includes(b.type as BufferType)) return false;
        // A nick can be queried on several IRC servers at once; only the one in
        // this server context is the intended target (null = context unknown).
        if (server !== undefined && server !== null && b.server !== server) return false;
        return true;
    });
}

/** Whether a buffer has no older history to ask for. Free buffers (`/exec -nf`,
 * plugin output) hold live-only rows: a history request would re-deliver the
 * current rows as duplicates rather than older content. */
export function hasNoHistoryToFetch(buffer: BufferData): boolean {
    return buffer.bufferType === 1;
}

/** Mark a buffer's history complete so no further history request is issued. */
export function markHistoryComplete(bufferId: string): void {
    buffers.update((current) => {
        const buf = current[bufferId];
        if (!buf || buf.allLinesFetched) return current;
        return { ...current, [bufferId]: { ...buf, allLinesFetched: true } };
    });
}

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
 * Copy a buffer's mutable nested structures (lines, nicklist) along with field overrides.
 * Line objects are immutable after creation, so the lines array is a fresh shallow copy
 * (callers mutate the array in-place, e.g. splice/push) while sharing line references.
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
        lines: [...buf.lines],
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

    // Preserve an exact saved boundary. On first connect, use WeeChat's hotlist count
    // to infer the oldest unread message from the loaded snapshot, including adjacent
    // status/date rows in the unread section. Keep the boundary unknown only until lines load.
    const existingBoundary = getReadBoundaryIndex(buffer);
    const pendingUnread = Math.max(buffer.pendingReadBoundaryUnread || 0, getEffectiveUnread(buffer));
    // WeeChat's own marker is exact; the hotlist count only guesses where the
    // unread region starts, so it is the fallback.
    const serverBoundary = existingBoundary === null ? findServerReadBoundaryIndex(buffer) : null;
    const inferredBoundary = existingBoundary === null && serverBoundary === null
        ? inferReadBoundaryFromHotlist(buffer, pendingUnread)
        : null;
    const targetBoundaryKnown = existingBoundary !== null || serverBoundary !== null || inferredBoundary !== null;
    const targetLastSeen = existingBoundary ?? serverBoundary ?? inferredBoundary ?? -1;

    if (DEBUG_BUFFERS)
        console.log("[setActiveBuffer] targetLastSeen:", targetLastSeen, "known:", targetBoundaryKnown);

    // Build a new buffers object with immutable updates to avoid in-place
    // mutations that can race with concurrent handler updates (e.g. hotlist).
    const updatedBuffers: Record<string, BufferData> = {};
    for (const id in currentBuffers) {
        const buf = currentBuffers[id];
        if (!buf) continue;
        if (id === prevId) {
            // Leaving a buffer means every currently displayed line has been seen.
            const updated = { ...buf, active: false };
            setReadBoundary(updated, updated.lines.length - 1);
            updated.unread = 0;
            updated.notification = 0;
            updatedBuffers[id] = updated;
        } else if (id === bufferId) {
            const updated = {
                ...buf,
                lines: [...buf.lines],
                nicklist: { ...buf.nicklist },
                active: true,
                unread: 0,
                notification: 0,
                localUnread: 0,
            };
            if (targetBoundaryKnown) {
                setReadBoundary(updated, targetLastSeen);
            } else {
                setReadBoundaryUnknown(updated);
                updated.pendingReadBoundaryUnread = pendingUnread;
            }
            updatedBuffers[id] = updated;
        } else {
            updatedBuffers[id] = buf;
        }
    }

    // Discard old lines above the dynamic limit. Re-find the stable boundary after
    // trimming; if its anchor was removed, all retained lines are known unread.
    const maxLines = get(maxBufferLines);
    const targetLinesLength = updatedBuffers[bufferId]!.lines.length;
    if (targetLinesLength > maxLines) {
        const target = updatedBuffers[bufferId]!;
        const linesToRemove = targetLinesLength - maxLines;
        const boundaryIndexBeforeTrim = getReadBoundaryIndex(target);
        const boundaryId = target.readBoundaryId;
        target.lines.splice(0, linesToRemove);
        target.requestedLines -= linesToRemove;
        if (target.readBoundaryKnown !== false) {
            if (boundaryId) {
                const matches = target.lines.reduce<number[]>((found, line, index) => {
                    if (line.lineId === boundaryId) found.push(index);
                    return found;
                }, []);
                if (matches.length > 1) setReadBoundaryUnknown(target);
                else setReadBoundary(target, matches.length === 1 ? matches[0]! : -1);
            } else {
                const boundaryIndex = boundaryIndexBeforeTrim === null ? -1 : boundaryIndexBeforeTrim - linesToRemove;
                setReadBoundary(target, boundaryIndex);
            }
        }
        target.allLinesFetched = false;
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
    recordLastBuffer(buffer.fullName);
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
                readBoundaryKnown: true,
                readBoundaryId: buf.lines.length > 0 ? buf.lines[buf.lines.length - 1]?.lineId ?? undefined : null,
                pendingReadBoundaryUnread: 0,
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
