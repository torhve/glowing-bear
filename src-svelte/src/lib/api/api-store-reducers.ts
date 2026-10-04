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
// NOTE: injectDateChangeMessageIfNeeded currently lives in handlers.ts
// (legacy). It is pure model logic and moves to models.ts at cutover; the
// import here is temporary and will invert.

import { get } from 'svelte/store';
import {
    buffers, servers, activeBufferId, previousBufferId, localUnreadBuffers,
    createBuffer, createBufferLine, createNick, createNickGroup,
    parseRichText, removeBuffer, isSyncing, isRelayStatusBuffer,
} from '#lib/stores/models.ts';
import { injectDateChangeMessageIfNeeded } from '#lib/stores/handlers.ts';
import { createHighlight, playNotificationSound, updateTitle, updateFavico } from '#lib/notifications.ts';
import { isWindowFocused } from '#lib/windowFocus.ts';
import type { BufferData, Nick, NickGroup } from '#lib/types.ts';
import type {
    ApiReducers, BufferSnapshot, LineSnapshot, NickSnapshot, NickGroupSnapshot,
    HotlistSnapshot,
} from '#lib/api/api-contracts.ts';
import type { ApiBufferId } from '#lib/api/api-ids.ts';

/** Central conversion: store key for an API buffer id. */
export function storeKeyForBufferId(bufferId: ApiBufferId): string {
    return String(bufferId);
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
    existing.hideBufferLineTimes = snap.contentType === 'free';
    return existing;
}

function appendLines(buffer: BufferData, lines: LineSnapshot[]): void {
    for (const line of lines) {
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

/** Flatten the API nick tree into the legacy flat group map, depth-first so
 *  group display order matches the server tree. */
function buildNicklist(buffer: BufferData, groups: NickGroupSnapshot[], nicks: NickSnapshot[]): void {
    buffer.nicklist = {};
    // Groups arrive depth-first from the tree walk; keep that display order.
    for (const group of groups) {
        const key = String(group.id);
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
        color: snap.colorName || snap.color,
        prefix_color: snap.prefixColorName || snap.prefixColor,
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
 * - while syncing with an unknown boundary, live rows belong to the sync
 *   snapshot and must not inflate counters;
 * - the active buffer never tallies (the user is looking at it);
 * - notify_level ≥ 1 → localUnread (badge bookkeeping);
 * - notify_level = 1 with buffer.notify > 1 → unread;
 * - notify_level ≥ 2 with highlight/private → notification.
 * buffer.notify defaults to 3 ('all'); the API does not expose the per-buffer
 * notify setting (open gate G4) — hotlist baselines correct the counts.
 */
function tallyLine(buffer: BufferData, line: LineSnapshot, activeId: string): void {
    if (isRelayStatusBuffer(buffer)) return;
    if (isSyncing() && buffer.readBoundaryKnown === false) return;
    if (buffer.id === activeId) return;

    if (line.notifyLevel >= 1) {
        buffer.localUnread = (buffer.localUnread || 0) + 1;
        localUnreadBuffers.update((s) => new Set(s).add(buffer.id));
    }
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
    if (buffer.notify < line.notifyLevel || line.notifyLevel < 1) return;
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
        },

        bufferOpened(snap, lines, groups, nicks): void {
            const current = get(buffers);
            const copy: Record<string, BufferData> = { ...current };
            const buffer = upsertBuffer(copy, snap);
            if (lines && lines.length) appendLines(buffer, lines);
            if (groups && groups.length) buildNicklist(buffer, groups, nicks ?? []);
            if (lines && lines.length) applyReadMarker(buffer, snap.lastReadLineId);
            buffers.set(copy);
        },

        bufferClosing(bufferId): void {
            // Keep the buffer until buffer_closed; closing is advisory.
            void bufferId;
        },

        bufferClosed(bufferId): void {
            const key = storeKeyForBufferId(bufferId);
            const buffer = get(buffers)[key];
            if (!buffer) return;
            removeBuffer(key, buffer.active);
        },

        bufferTitleChanged(bufferId, title): void {
            const key = storeKeyForBufferId(bufferId);
            buffers.update((current) => {
                const buffer = current[key];
                if (!buffer) return current;
                const copy = { ...current, [key]: { ...buffer } };
                copy[key]!.title = parseRichText(title);
                copy[key]!.rtitle = copy[key]!.title.map((t) => t.text).join('');
                return copy;
            });
        },

        bufferLocalvarSet(bufferId, name, value): void {
            const key = storeKeyForBufferId(bufferId);
            buffers.update((current) => {
                const buffer = current[key];
                if (!buffer) return current;
                const copy = { ...current, [key]: { ...buffer } };
                const target = copy[key]!;
                target.localVariables = { ...(target.localVariables ?? {}), [name]: value };
                if (name === 'pinned') target.pinned = value === 'true';
                return copy;
            });
        },

        bufferLocalvarRemoved(bufferId, name): void {
            const key = storeKeyForBufferId(bufferId);
            buffers.update((current) => {
                const buffer = current[key];
                if (!buffer) return current;
                const copy = { ...current, [key]: { ...buffer } };
                const target = copy[key]!;
                const vars = { ...(target.localVariables ?? {}) };
                delete vars[name];
                target.localVariables = Object.keys(vars).length ? vars : undefined;
                if (name === 'pinned') target.pinned = false;
                return copy;
            });
        },

        bufferModesChanged(bufferId, modes): void {
            // BufferData has no dedicated modes field; keep the authoritative
            // string on localVariables so consumers can read it.
            const key = storeKeyForBufferId(bufferId);
            buffers.update((current) => {
                const buffer = current[key];
                if (!buffer) return current;
                const copy = { ...current, [key]: { ...buffer } };
                copy[key]!.localVariables = { ...(copy[key]!.localVariables ?? {}), modes };
                return copy;
            });
        },

        bufferInputChanged(): void {
            // Input state is client-owned; the API echo is not authoritative
            // for our InputBar. Intentional no-op.
        },

        lineAdded(bufferId, line): void {
            const key = storeKeyForBufferId(bufferId);
            const activeId = get(activeBufferId);
            buffers.update((current) => {
                const buffer = current[key];
                if (!buffer) return current; // buffer not synced yet; history fetch covers it
                const copy = { ...current, [key]: { ...buffer, lines: [...buffer.lines] } };
                const target = copy[key]!;
                const epoch = target.clearEpoch ?? 0;
                appendLines(target, [line]);
                // Clear-epoch guard: a line that arrives for a buffer cleared
                // mid-request still appends (it is live), but history
                // responses captured under an older epoch are rejected in
                // phase 8; the epoch bump is what makes that check possible.
                void epoch;
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
                const existing = target.nicklist[String(group.id)];
                const entry = existing ?? createNickGroup({ name: group.name, visible: group.visible ? '1' : '0' });
                target.nicklist[String(group.id)] = { ...entry, name: group.name, visible: group.visible ? '1' : '0' };
                return copy;
            });
        },

        nickGroupRemoved(bufferId, groupId): void {
            const key = storeKeyForBufferId(bufferId);
            buffers.update((current) => {
                const buffer = current[key];
                if (!buffer) return current;
                const copy = { ...current, [key]: { ...buffer, nicklist: { ...buffer.nicklist } } };
                delete copy[key]!.nicklist[String(groupId)];
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
                const groupKey = String(nick.parentGroupId);
                const group = target.nicklist[groupKey] ?? createNickGroup({ name: '', visible: '1' });
                const existingIndex = group.nicks.findIndex((n) => n.nickId === nick.id);
                const created = createNickFromApi(target, nick);
                const nicks = existingIndex >= 0
                    ? group.nicks.map((n, i) => (i === existingIndex ? created : n))
                    : [...group.nicks, created];
                target.nicklist[groupKey] = { ...group, nicks };
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
                    target.unread = entry.counts.message + entry.counts.low;
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

        unhandled(detail): void {
            console.warn(`[api-store] unhandled payload: ${detail}`);
        },
    };
}
