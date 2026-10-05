// API-backed store reducers (phase 7): implement the ApiReducers contract
// against the live models.ts stores.
//
// Identity rules (advisor-reviewed):
// - BufferData.id is String(apiBufferId); the branded numeric id stays
//   authoritative on BufferData.apiBufferId. Conversion happens ONLY here —
//   callers must never Number(buffer.id) or mix the two.
// - Buffer line identity is `weechat:<apiLineId>` via createBufferLine.
// - A clear epoch per buffer prevents delayed history from repopulating a
//   buffer that was cleared (or closed) after the request started.
//
// Hotlist rule: a baseline is authoritative for server counts; locally
// tracked unread (localUnread) is modeled separately and preserved.
//

import { get } from 'svelte/store';
import {
    buffers, servers, activeBufferId, previousBufferId, localUnreadBuffers,
    createBuffer, createBufferLine, createNick, createNickGroup,
    parseRichText, removeBuffer, isSyncing, isRelayStatusBuffer,
    maxBufferLines, setReadBoundary, setReadBoundaryUnknown,
    injectDateChangeMessageIfNeeded, pendingBufferSwitch, setActiveBuffer,
} from '#lib/stores/models.ts';
import { shouldResume } from '#lib/stores/bufferResume.ts';
import { createHighlight, playNotificationSound, updateTitle, updateFavico } from '#lib/notifications.ts';
import { isWindowFocused } from '#lib/windowFocus.ts';
import type { BufferData, BufferType, Nick, NickGroup } from '#lib/types.ts';
import type {
    ApiReducers, BufferSnapshot, LineSnapshot, NickSnapshot, NickGroupSnapshot,
    HotlistSnapshot,
} from '#lib/api/api-contracts.ts';
import type { ApiBufferId } from '#lib/api/api-ids.ts';
import { isServerHiddenLine } from '#lib/api/api-mapping.ts';

/** Central conversion: store key for an API buffer id. */
export function storeKeyForBufferId(bufferId: ApiBufferId): string {
    return String(bufferId);
}

// Group display keys follow the legacy contract: group name, root group is
// 'root'. The id→key mapping lets lifecycle events address groups by API id.
const groupKeys = new Map<string, Map<number, string>>();
function groupKey(bufferKey: string, groupId: number, name = ''): string {
    const map = groupKeys.get(bufferKey);
    return map?.get(groupId) ?? (name || 'root');
}
function registerGroupKey(bufferKey: string, groupId: number, name: string): string {
    const key = name || 'root';
    let map = groupKeys.get(bufferKey);
    if (!map) { map = new Map(); groupKeys.set(bufferKey, map); }
    map.set(groupId, key);
    return key;
}

function serverKey(buffer: BufferData): string {
    return `${buffer.plugin}.${buffer.server}`;
}

function addServerUnread(serverKey: string, delta: number): void {
    servers.update((current) => {
        const copy = { ...current };
        const entry = copy[serverKey];
        if (entry) copy[serverKey] = { ...entry, unread: entry.unread + delta };
        else copy[serverKey] = { id: serverKey, unread: delta };
        return copy;
    });
}

function snapshotToBuffer(snap: BufferSnapshot): BufferData {
    const buffer = createBuffer({
        // Central id assignment: the store key is the stringified API id.
        pointers: [storeKeyForBufferId(snap.id)],
        full_name: snap.name,
        short_name: snap.shortName,
        title: snap.title,
        hidden: snap.hidden ? 1 : 0,
        number: snap.number,
        // API content type: 'free' maps to the legacy numeric 1.
        type: snap.contentType === 'free' ? 1 : 0,
        local_variables: snap.localVariables,
    });
    buffer.apiBufferId = snap.id;
    if (snap.notify !== undefined) buffer.notify = snap.notify;
    buffer.clearEpoch = 0;
    applyReadMarker(buffer, snap.lastReadLineId);
    return buffer;
}

/**
 * last_read_line_id → read boundary. -1 (NO_READ_LINE) means WeeChat has no
 * read marker: every retained line is unread (boundary known, id null).
 * An id for a line outside retained history leaves the boundary unknown —
 * pendingReadBoundaryUnread carries the hotlist count until history resolves
 * it (set by the hotlist reducer).
 */
function applyReadMarker(buffer: BufferData, lastReadLineId: number): void {
    if (lastReadLineId === -1) {
        buffer.readBoundaryKnown = true;
        buffer.readBoundaryId = null;
    } else {
        const boundaryId = `weechat:${lastReadLineId}`;
        const found = buffer.lines.some((l) => l.lineId === boundaryId);
        buffer.readBoundaryKnown = found;
        buffer.readBoundaryId = found ? boundaryId : null;
    }
}

function upsertBuffer(map: Record<string, BufferData>, snap: BufferSnapshot): BufferData {
    const key = storeKeyForBufferId(snap.id);
    const existing = map[key];
    if (!existing) {
        const created = snapshotToBuffer(snap);
        map[key] = created;
        return created;
    }
    // Update in place on the (already copied) object; identity and lines are
    // preserved, metadata is refreshed from the authoritative snapshot.
    existing.fullName = snap.name;
    existing.shortName = snap.shortName;
    existing.hidden = snap.hidden;
    existing.number = snap.number;
    existing.title = parseRichText(snap.title);
    existing.rtitle = existing.title.map((t) => t.text).join('');
    existing.localVariables = Object.keys(snap.localVariables).length ? { ...snap.localVariables } : undefined;
    existing.pinned = snap.localVariables.pinned === 'true';
    // Content type (formatted/free) is the legacy numeric bufferType; the
    // semantic BufferType ('channel'…) lives in local_variables, exactly as
    // the legacy buffer handlers derive it.
    existing.bufferType = snap.contentType === 'free' ? 1 : 0;
    existing.hideBufferLineTimes = snap.contentType === 'free';
    if (snap.localVariables.type) existing.type = snap.localVariables.type as BufferType;
    if (snap.localVariables.plugin) existing.plugin = snap.localVariables.plugin;
    if (snap.localVariables.server) existing.server = snap.localVariables.server;
    if (snap.notify !== undefined) existing.notify = snap.notify;
    return existing;
}

function appendLines(buffer: BufferData, lines: LineSnapshot[]): void {
    for (const line of lines) {
        if (isServerHiddenLine(line)) continue; // smart-filtered: WeeChat hides it
        injectDateChangeMessageIfNeeded(buffer, false, new Date(buffer.lines.length ? buffer.lines[buffer.lines.length - 1]!.date : line.epochMs), new Date(line.epochMs));
        buffer.lines.push(createBufferLine({
            buffer: buffer.id,
            date: line.epochMs,
            prefix: line.prefix,
            message: line.message,
            tags_array: line.tags,
            displayed: line.displayed ? 1 : 0,
            notify_level: line.notifyLevel,
            highlight: line.highlight ? 1 : 0,
            id: line.id, // → lineId `weechat:<id>`
            bufferType: buffer.type,
        }));
    }
}

/** Drop oldest lines beyond the dynamic memory limit, mirroring the legacy
 *  buffer-info/line-add trim: localUnread, requestedLines, and the read
 *  boundary are all re-anchored for the removed prefix. */
export function trimBufferLines(buffer: BufferData, limit: number): void {
    if (buffer.lines.length <= limit) return;
    const linesToRemove = buffer.lines.length - limit;
    // Adjust localUnread for removed lines — it tracks real-time messages
    // received while this buffer was inactive.
    if (buffer.localUnread > 0) {
        const unreadStartIndex = Math.max(0, buffer.lines.length - buffer.localUnread);
        const overlap = Math.max(0, Math.min(linesToRemove, unreadStartIndex));
        buffer.localUnread = Math.max(0, buffer.localUnread - overlap);
    }
    const boundaryId = buffer.readBoundaryId;
    const wasKnown = buffer.readBoundaryKnown !== false;
    const oldLastSeen = buffer.lastSeen;
    buffer.lines.splice(0, linesToRemove);
    buffer.requestedLines -= linesToRemove;
    if (wasKnown) {
        if (boundaryId === null) {
            setReadBoundary(buffer, -1);
        } else if (boundaryId !== undefined) {
            const matches = buffer.lines.reduce<number[]>((found, line, index) => {
                if (line.lineId === boundaryId) found.push(index);
                return found;
            }, []);
            if (matches.length > 1) setReadBoundaryUnknown(buffer);
            else setReadBoundary(buffer, matches.length === 1 ? matches[0]! : -1);
        } else {
            setReadBoundary(buffer, oldLastSeen - linesToRemove);
        }
    }
    buffer.allLinesFetched = false;
}

/** Apply the memory-limit trim after any append (history, live, opened). */
function trimToLimit(buffer: BufferData): void {
    trimBufferLines(buffer, get(maxBufferLines));
}

/** Flatten the API nick tree into the legacy flat group map, depth-first so
 *  group display order matches the server tree. */
function buildNicklist(buffer: BufferData, groups: NickGroupSnapshot[], nicks: NickSnapshot[]): void {
    buffer.nicklist = {};
    // Groups arrive depth-first from the tree walk; keep that display order.
    for (const group of groups) {
        const key = registerGroupKey(buffer.id, group.id, group.name);
        const entry: NickGroup = createNickGroup({ name: group.name, visible: group.visible ? '1' : '0' });
        for (const snap of nicks) {
            if (snap.parentGroupId === group.id) entry.nicks.push(createNickFromApi(buffer, snap));
        }
        buffer.nicklist[key] = entry;
    }
}

function createNickFromApi(buffer: BufferData, snap: NickSnapshot): Nick {
    const nick = createNick({
        pointers: [buffer.id],
        prefix: snap.prefix,
        visible: snap.visible ? '1' : '0',
        name: snap.name,
        color: snap.color || snap.colorName,
        prefix_color: snap.prefixColor || snap.prefixColorName,
    });
    nick.nickId = snap.id;
    return nick;
}

function findNickLocation(buffer: BufferData, nickId: number): { group: NickGroup; index: number } | null {
    for (const key in buffer.nicklist) {
        const group = buffer.nicklist[key]!;
        const index = group.nicks.findIndex((n) => n.nickId === nickId);
        if (index >= 0) return { group, index };
    }
    return null;
}

/**
 * Ported tally rules from the legacy line handler (behavior, not wire code):
 * - relay status buffers never tally;
 * - the active buffer never tallies (the user is looking at it);
 * - notify_level ≥ 1 → localUnread (badge bookkeeping);
 * - notify_level = 1 with buffer.notify > 1 → unread;
 * - notify_level ≥ 2 with highlight/private → notification.
 * The server-count counters (unread/notification) are gated while syncing
 * with an unknown boundary: they are the input to read-boundary resolution,
 * and the hotlist baseline is authoritative for the sync snapshot. The badge
 * counter is never gated — alertForLine rings for these lines even while
 * syncing, and getEffectiveUnread max-merges server counts with the local
 * tally, so baseline-covered lines cannot inflate the badge while lines that
 * raced past the baseline still badge (alert ⇒ badge invariant).
 * buffer.notify defaults to 3 ('all'). WeeChat >= 5.0.0 reports the per-buffer
 * notify level in buffers and buffer_notify_changed events, which sets it; on
 * 4.10.1 it stays 'all' and hotlist baselines correct the counts.
 */
function tallyLine(buffer: BufferData, line: LineSnapshot, activeId: string): void {
    if (isRelayStatusBuffer(buffer)) return;
    if (buffer.id === activeId) return;

    if (line.notifyLevel >= 1) {
        buffer.localUnread = (buffer.localUnread || 0) + 1;
        localUnreadBuffers.update((s) => new Set(s).add(buffer.id));
    }

    // Boundary-resolution counters stay deferred to the hotlist baseline
    // while the boundary is unknown (see comment above).
    if (isSyncing() && buffer.readBoundaryKnown === false) return;

    if (buffer.notify > 1 && line.notifyLevel === 1) {
        buffer.unread++;
        addServerUnread(serverKey(buffer), 1);
    }
    if (line.notifyLevel >= 2) {
        const isPrivate = buffer.type === 'private' || buffer.type === 'query';
        if (buffer.notify !== 0 && (line.highlight || isPrivate)) {
            buffer.notification++;
            addServerUnread(serverKey(buffer), 1);
        }
    }
}

/** User-facing alert path — deliberately independent of sync/boundary state
 *  (a real-time PM must ring even in a boundary-unknown buffer). */
function alertForLine(buffer: BufferData, line: LineSnapshot, activeId: string): void {
    if (isRelayStatusBuffer(buffer)) return;
    // WeeChat hotlist policy maps line priority to a minimum buffer notify
    // level: message (1) requires 'message' (2); private/highlight (2-3)
    // require at least 'highlight' (1). The legacy client compared the two
    // scales directly, which muted 'highlight' buffers entirely — corrected
    // now that the API reports the buffer notify level.
    if (line.notifyLevel < 1) return;
    if (buffer.notify < (line.notifyLevel === 1 ? 2 : 1)) return;
    if (buffer.id === activeId) return;
    updateTitle();
    updateFavico();
    const isPrivateMessage = line.tags.includes('notify_private');
    const isPrivate = buffer.type === 'private' || buffer.type === 'query';
    if (buffer.notify !== 0 && (line.highlight || isPrivateMessage || isPrivate)) {
        playNotificationSound();
        if (!isWindowFocused()) {
            createHighlight(buffer, `${line.prefix} ${line.message}`.trim());
        }
    }
}

/** Create the ApiReducers bound to the live stores for one connection.
 *  The orchestrator already gates generations for events; the clear epoch
 *  guards delayed request responses against clears/closes. */
export function createApiStoreReducers(): ApiReducers {
    return {
        buffers(list: BufferSnapshot[]): void {
            const current = get(buffers);
            const copy: Record<string, BufferData> = { ...current };
            for (const snap of list) upsertBuffer(copy, snap);
            buffers.set(copy);
            // Resume the last-viewed buffer (saved by fullName across
            // connections); otherwise prefer core.weechat, then the first
            // buffer — same default order as the legacy buffer-info pass.
            if (!get(activeBufferId)) {
                const resume = list.find((snap) => shouldResume(snap.name));
                const fallback = resume
                    ?? list.find((snap) => snap.name === 'core.weechat')
                    ?? list[0];
                if (fallback) setActiveBuffer(storeKeyForBufferId(fallback.id));
            }
        },

        bufferOpened(snap, lines, groups, nicks): void {
            const current = get(buffers);
            const copy: Record<string, BufferData> = { ...current };
            const buffer = upsertBuffer(copy, snap);
            if (lines && lines.length) {
                appendLines(buffer, lines);
                trimToLimit(buffer);
            }
            if (groups && groups.length) buildNicklist(buffer, groups, nicks ?? []);
            if (lines && lines.length) applyReadMarker(buffer, snap.lastReadLineId);
            // Publish the store first: setActiveBuffer resolves the buffer by id
            // from the live store, so a brand-new buffer must exist there before
            // the switch (and resume) logic runs.
            buffers.set(copy);
            // Auto-switch to a /query buffer once WeeChat opens it (pending
            // switch set by InputBar when the target buffer did not exist yet).
            const targetNick = get(pendingBufferSwitch);
            if (targetNick && buffer.shortName.toLowerCase() === targetNick.toLowerCase()) {
                setActiveBuffer(buffer.id);
                pendingBufferSwitch.set(null);
            } else if (shouldResume(buffer.fullName) && !get(activeBufferId)) {
                setActiveBuffer(buffer.id);
            }
        },

        bufferClosing(bufferId): void {
            // Keep the buffer until buffer_closed; closing is advisory.
            void bufferId;
        },

        bufferClosed(bufferId): void {
            const key = storeKeyForBufferId(bufferId);
            const buffer = get(buffers)[key];
            if (!buffer) return;
            groupKeys.delete(key);
            removeBuffer(key, buffer.active);
        },

        bufferUpdated(snap): void {
            // Any buffer_* change event delivers a full authoritative buffer
            // snapshot; merge metadata only (no lines/nicks, no switching).
            const key = storeKeyForBufferId(snap.id);
            buffers.update((current) => {
                const buffer = current[key];
                if (!buffer) return current; // opened buffers get full snapshots anyway
                const copy = { ...current, [key]: { ...buffer } };
                upsertBuffer(copy, snap);
                // Content/semantic type flips (buffer_type_changed, localvar
                // edits) are applied by upsertBuffer from the snapshot.
                // snap.modes is intentionally not stored: BufferData has no
                // modes field, no consumer needs it, and localVariables must
                // stay exactly what the server reports.
                return copy;
            });
        },


        bufferNotifyChanged(bufferId, notify): void {
            // WeeChat >= 5.0.0 sends buffer_notify_changed; the tally and
            // alert gates below read buffer.notify on every line.
            const key = storeKeyForBufferId(bufferId);
            buffers.update((current) => {
                const buffer = current[key];
                if (!buffer) return current;
                const copy = { ...current, [key]: { ...buffer } };
                copy[key]!.notify = notify;
                return copy;
            });
        },

        bufferInputChanged(): void {
            // Input state is client-owned; the API echo is not authoritative
            // for our InputBar. Intentional no-op.
        },

        lineAdded(bufferId, line): void {
            if (isServerHiddenLine(line)) return; // smart-filtered: skip render and tally
            const key = storeKeyForBufferId(bufferId);
            const activeId = get(activeBufferId);
            buffers.update((current) => {
                const buffer = current[key];
                if (!buffer) return current; // buffer not synced yet; history fetch covers it
                const copy = { ...current, [key]: { ...buffer, lines: [...buffer.lines] } };
                const target = copy[key]!;
                // Line identity is idempotent: a live line that raced with a
                // concurrent history response updates the existing row in
                // place instead of duplicating it, and is not tallied twice.
                const lineId = `weechat:${line.id}`;
                const existingIndex = target.lines.findIndex((l) => l.lineId === lineId);
                if (existingIndex >= 0) {
                    target.lines[existingIndex] = createBufferLine({
                        buffer: target.id,
                        date: line.epochMs,
                        prefix: line.prefix,
                        message: line.message,
                        tags_array: line.tags,
                        displayed: line.displayed ? 1 : 0,
                        notify_level: line.notifyLevel,
                        highlight: line.highlight ? 1 : 0,
                        id: line.id,
                        bufferType: target.type,
                    });
                    return copy;
                }
                appendLines(target, [line]);
                trimToLimit(target);
                if (line.displayed) {
                    tallyLine(target, line, activeId);
                    alertForLine(target, line, activeId);
                }
                return copy;
            });
        },

        lineDataChanged(bufferId, line): void {
            const key = storeKeyForBufferId(bufferId);
            buffers.update((current) => {
                const buffer = current[key];
                if (!buffer) return current;
                const lineId = `weechat:${line.id}`;
                const index = buffer.lines.findIndex((l) => l.lineId === lineId);
                if (index < 0) return current;
                const updated = createBufferLine({
                    buffer: buffer.id,
                    date: line.epochMs,
                    prefix: line.prefix,
                    message: line.message,
                    tags_array: line.tags,
                    displayed: line.displayed ? 1 : 0,
                    notify_level: line.notifyLevel,
                    highlight: line.highlight ? 1 : 0,
                    id: line.id,
                    bufferType: buffer.type,
                });
                const copy = { ...current, [key]: { ...buffer, lines: [...buffer.lines] } };
                copy[key]!.lines[index] = updated;
                return copy;
            });
        },

        bufferCleared(bufferId): void {
            const key = storeKeyForBufferId(bufferId);
            buffers.update((current) => {
                const buffer = current[key];
                if (!buffer) return current;
                const copy = { ...current, [key]: { ...buffer, lines: [] } };
                const target = copy[key]!;
                target.clearEpoch = (target.clearEpoch ?? 0) + 1;
                target.requestedLines = 0;
                target.allLinesFetched = false;
                target.localUnread = 0;
                target.readBoundaryKnown = true;
                target.readBoundaryId = null;
                return copy;
            });
        },

        nickGroupChanged(bufferId, group): void {
            const key = storeKeyForBufferId(bufferId);
            buffers.update((current) => {
                const buffer = current[key];
                if (!buffer) return current;
                const copy = { ...current, [key]: { ...buffer, nicklist: { ...buffer.nicklist } } };
                const target = copy[key]!;
                const key2 = registerGroupKey(target.id, group.id, group.name);
                const existing = target.nicklist[key2];
                const entry = existing ?? createNickGroup({ name: group.name, visible: group.visible ? '1' : '0' });
                target.nicklist[key2] = { ...entry, name: group.name, visible: group.visible ? '1' : '0' };
                return copy;
            });
        },

        nickGroupRemoved(bufferId, groupId): void {
            const key = storeKeyForBufferId(bufferId);
            buffers.update((current) => {
                const buffer = current[key];
                if (!buffer) return current;
                const copy = { ...current, [key]: { ...buffer, nicklist: { ...buffer.nicklist } } };
                delete copy[key]!.nicklist[groupKey(copy[key]!.id, groupId)];
                groupKeys.get(key)?.delete(groupId);
                return copy;
            });
        },

        nickChanged(bufferId, nick): void {
            const key = storeKeyForBufferId(bufferId);
            buffers.update((current) => {
                const buffer = current[key];
                if (!buffer) return current;
                const copy = { ...current, [key]: { ...buffer, nicklist: { ...buffer.nicklist } } };
                const target = copy[key]!;
                const key2 = groupKey(target.id, nick.parentGroupId);
                const group = target.nicklist[key2] ?? createNickGroup({ name: key2 === 'root' ? '' : key2, visible: '1' });
                const existingIndex = group.nicks.findIndex((n) => n.nickId === nick.id);
                const created = createNickFromApi(target, nick);
                const nicks = existingIndex >= 0
                    ? group.nicks.map((n, i) => (i === existingIndex ? created : n))
                    : [...group.nicks, created];
                target.nicklist[key2] = { ...group, nicks };
                return copy;
            });
        },

        nickRemoved(bufferId, nickId): void {
            const key = storeKeyForBufferId(bufferId);
            buffers.update((current) => {
                const buffer = current[key];
                if (!buffer) return current;
                const copy = { ...current, [key]: { ...buffer, nicklist: { ...buffer.nicklist } } };
                const target = copy[key]!;
                const location = findNickLocation(target, nickId);
                if (location) {
                    location.group.nicks = location.group.nicks.filter((n) => n.nickId !== nickId);
                }
                return copy;
            });
        },

        hotlist(map: Map<ApiBufferId, HotlistSnapshot>): void {
            const activeId = get(activeBufferId);
            const previousId = get(previousBufferId);
            buffers.update((current) => {
                const copy: Record<string, BufferData> = { ...current };
                for (const [bufferId, entry] of map) {
                    const key = storeKeyForBufferId(bufferId);
                    const buffer = copy[key];
                    if (!buffer) continue;
                    if (key === activeId || key === previousId) continue; // managed by setActiveBuffer
                    const target = { ...buffer };
                    // Server counts are authoritative at baseline; localUnread
                    // is separate state and is preserved.
                    // Legacy parity: only message-priority counts are unread;
                    // low-priority lines (joins/parts, relay refresh) are not.
                    target.unread = entry.counts.message;
                    target.notification = entry.counts.private + entry.counts.highlight;
                    if (target.readBoundaryKnown === false && target.unread + target.notification > 0) {
                        target.pendingReadBoundaryUnread = target.unread + target.notification;
                    }
                    copy[key] = target;
                }
                return copy;
            });
        },

        completion(): void {
            // Phase 9: completion results are request-correlated, not store
            // events; InputBar consumes the response directly.
        },

        inputRejected(bufferId, error): void {
            console.warn(`[api-store] input rejected for buffer ${bufferId}: ${error}`);
        },

        relayLifecycle(kind): void {
            // Log only: the orchestrator owns reconnect on upgrade, and the
            // socket close owns 'quit' (WeeChat closes clients as it exits).
            if (kind === 'quit') console.info('[api-store] WeeChat has terminated');
            else if (kind === 'upgrade') console.info('[api-store] WeeChat is upgrading — reconnect will follow');
            else console.info('[api-store] WeeChat upgrade finished');
        },

        unhandled(detail): void {
            console.warn(`[api-store] unhandled payload: ${detail}`);
        },
    };
}
