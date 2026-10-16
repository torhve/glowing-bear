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
    maxBufferLines, lineLimitFor, lineLimitWith, setReadBoundary, setReadBoundaryUnknown, applyServerReadMarker, markHotlistBaselineApplied,
    injectDateChangeMessageIfNeeded, pendingBufferSwitch, setActiveBuffer, matchesPendingSwitch,
} from '#lib/stores/models.ts';
import { shouldResume } from '#lib/stores/bufferResume.ts';
import { renameConversationDraft } from '#lib/stores/conversationDrafts.ts';
import { addToast } from '#lib/toast.ts';
import { createHighlight, playNotificationSound } from '#lib/notifications.ts';
import { toPlainText } from '#lib/weechat-colors.ts';
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

/*
 * Frame-aligned batching of `buffer_line_added` events.
 *
 * The API relay delivers one event per line, and each event used to run its own
 * `buffers.update` with a whole-map copy plus a whole `lines` array copy. On a
 * 2000-line flood that is 2000 map copies and 2000 array copies of up to
 * maxBufferLines entries — measured as 38% of the API flood's self time, and the
 * reason the API path ran ~5x slower than the legacy handler on the same
 * workload. The legacy transport already solves this with the
 * `pendingLineMessages` queue in handlers.ts; this is the same design, with the
 * same rAF alignment and the same timer fallback for paused background tabs.
 *
 * Ordering rule: every other reducer flushes the queue before it runs, so a
 * queued line can never be reordered behind a buffer_opened / hotlist /
 * line_data_changed event. `lineAdded` itself must NOT flush, or nothing would
 * ever batch.
 *
 * The per-line sequence inside a batch (append, trim, tally, alert) is
 * unchanged; only the number of store writes changes. The active buffer is
 * captured when the line arrives, so a switch during the batch cannot
 * re-attribute a line that arrived before it.
 */
const pendingLines: { bufferId: ApiBufferId; line: LineSnapshot; activeId: string }[] = [];
let flushScheduled = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/** rAF-aligned flush, with a timer fallback for contexts where rAF is paused. */
function scheduleLineFlush(): void {
    if (!flushScheduled) {
        flushScheduled = true;
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flushApiLineBatch);
        else queueMicrotask(flushApiLineBatch);
    }
    if (flushTimer === null) {
        flushTimer = setTimeout(() => {
            flushTimer = null;
            flushApiLineBatch();
        }, 100);
    }
}

/**
 * The per-line work `lineAdded` used to do inline, unchanged. Line identity is
 * idempotent: a live line that raced with a concurrent history response updates
 * the existing row in place instead of duplicating it, and is not tallied twice.
 */
function applyLineAdded(target: BufferData, line: LineSnapshot, activeId: string, limit: number, effects: LineBatchEffects): void {
    const lineId = `weechat:${line.id}`;
    // The id scan is the expensive half of a live line: it walks every retained
    // line to answer "has history already inserted this one?". The answer is
    // almost always no, and lineIdsSeen answers that in O(1) — the scan measured
    // as ~60% of the API flood's store time. A stale id in the set only costs one
    // scan that finds nothing and appends, which is the safe direction.
    if (target.lineIdsSeen?.has(lineId)) {
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
            return;
        }
    }
    appendLines(target, [line], limit);
    trimToLimit(target, limit);
    if (line.displayed) {
        tallyLine(target, line, activeId, effects);
        alertForLine(target, line, activeId);
    }
}

/** Apply every queued line as one store update per affected buffer. */
export function flushApiLineBatch(): void {
    if (pendingLines.length === 0) return;
    const batch = pendingLines.splice(0);
    flushScheduled = false;
    if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
    }

    // One map copy + one lines-array copy per affected buffer, not per line.
    // One map copy + one lines-array copy per affected buffer, not per line.
    // Read the screen cap once per batch. `get()` on a Svelte store subscribes
    // and unsubscribes, and doing it twice per line measured 26% of the API
    // flood's store time — the cap cannot move inside one synchronous flush.
    // A buffer that has been paged deeper carries its own cap on the buffer.
    const screenCap = get(maxBufferLines);
    // One accumulator for the whole flush, not per buffer: several buffers can
    // be flooded in one frame and the Set and servers map are global.
    const effects: LineBatchEffects = { localUnreadIds: new Set(), serverDeltas: {} };
    const byBuffer = new Map<string, { items: { line: LineSnapshot; activeId: string }[] }>();
    for (const item of batch) {
        const key = storeKeyForBufferId(item.bufferId);
        const group = byBuffer.get(key);
        if (group) group.items.push({ line: item.line, activeId: item.activeId });
        else byBuffer.set(key, { items: [{ line: item.line, activeId: item.activeId }] });
    }

    for (const [key, group] of byBuffer) {
        buffers.update((current) => {
            const buffer = current[key];
            if (!buffer) return current; // buffer not synced yet; history fetch covers it
            const copy = { ...current, [key]: { ...buffer, lines: [...buffer.lines] } };
            const target = copy[key]!;
            const lineLimit = lineLimitWith(target, screenCap);
            for (const item of group.items) applyLineAdded(target, item.line, item.activeId, lineLimit, effects);
            return copy;
        });
    }

    applyLineBatchEffects(effects);
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

/**
 * Store writes a line batch can coalesce.
 *
 * Every one of these used to run per line: a full Set copy for the local
 * unread ids, a full servers-map copy for the unread delta, and a title and
 * favicon pass per alerting line. None of the stores they write is read inside
 * the batch loop, so accumulating and applying once leaves the final state
 * identical. The legacy transport already batches this way (flushLineBatch);
 * this is the same contract on the API path.
 */
interface LineBatchEffects {
    localUnreadIds: Set<string>;
    serverDeltas: Record<string, number>;

}

function noteServerUnread(effects: LineBatchEffects, key: string, delta: number): void {
    effects.serverDeltas[key] = (effects.serverDeltas[key] || 0) + delta;
}

/**
 * Apply the accumulated effects once. Order matters: the title and the favicon
 * badge are computed from the unread stores, so both stores must be published
 * before the indicators run.
 */
function applyLineBatchEffects(effects: LineBatchEffects): void {
    if (effects.localUnreadIds.size > 0) {
        localUnreadBuffers.update((current) => {
            const next = new Set(current);
            for (const id of effects.localUnreadIds) next.add(id);
            return next;
        });
    }
    const keys = Object.keys(effects.serverDeltas);
    if (keys.length > 0) {
        servers.update((current) => {
            const copy = { ...current };
            for (const key of keys) {
                const delta = effects.serverDeltas[key]!;
                const entry = copy[key];
                if (entry) copy[key] = { ...entry, unread: entry.unread + delta };
                else copy[key] = { id: key, unread: delta };
            }
            return copy;
        });
    }
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
    applyServerReadMarker(buffer, snap.lastReadLineId);
    return buffer;
}

function upsertBuffer(map: Record<string, BufferData>, snap: BufferSnapshot): BufferData {
    const key = storeKeyForBufferId(snap.id);
    const existing = map[key];
    if (!existing) {
        const created = snapshotToBuffer(snap);
        map[key] = created;
        return created;
    }
    // Publish a fresh object rather than mutating the one already handed to
    // subscribers. A selective current-buffer selector decides "did the buffer I
    // am looking at change?" by reference, and same-reference-changed-content is
    // indistinguishable from nothing-happened: the topic would visibly change in
    // WeeChat while every subscriber was told the buffer was untouched.
    // Pinned by buffer-identity-contracts.test.ts (publication invariant).
    const updated: BufferData = { ...existing };
    updated.fullName = snap.name;
    updated.shortName = snap.shortName;
    updated.hidden = snap.hidden;
    updated.number = snap.number;
    updated.title = parseRichText(snap.title);
    updated.rtitle = updated.title.map((t) => t.text).join('');
    updated.localVariables = Object.keys(snap.localVariables).length ? { ...snap.localVariables } : undefined;
    updated.pinned = snap.localVariables.pinned === 'true';
    // Content type (formatted/free) is the legacy numeric bufferType; the
    // semantic BufferType ('channel'…) lives in local_variables, exactly as
    // the legacy buffer handlers derive it.
    updated.bufferType = snap.contentType === 'free' ? 1 : 0;
    updated.hideBufferLineTimes = snap.contentType === 'free';
    if (snap.localVariables.type) updated.type = snap.localVariables.type as BufferType;
    if (snap.localVariables.plugin) updated.plugin = snap.localVariables.plugin;
    if (snap.localVariables.server) updated.server = snap.localVariables.server;
    if (snap.notify !== undefined) updated.notify = snap.notify;
    map[key] = updated;
    return updated;
}

/**
 * Remember that a line id has been inserted into `buffer.lines`.
 *
 * `lineIdsSeen` is a deliberate SUPERSET: ids are added on insert and are not
 * removed by a trim, so it can hold ids no longer on screen. That is the safe
 * direction of error — a stale id costs one scan that finds nothing and then
 * appends, while a missing id would render a duplicate row. It is rebuilt from
 * the visible lines when it drifts far past the memory cap.
 */
export function noteLineId(buffer: BufferData, lineId: string | undefined, limit: number): void {
    if (!lineId) return;
    let seen = buffer.lineIdsSeen;
    if (!seen) {
        seen = new Set();
        buffer.lineIdsSeen = seen;
    }
    seen.add(lineId);
    const bound = 4 * limit;
    if (seen.size > bound) {
        seen.clear();
        for (const l of buffer.lines) if (l.lineId) seen.add(l.lineId);
    }
}

function appendLines(buffer: BufferData, lines: LineSnapshot[], limit: number): void {
    for (const line of lines) {
        if (isServerHiddenLine(line)) continue; // smart-filtered: WeeChat hides it
        // Timestamps, not Dates: this runs per line and the cached local-day
        // window answers it with number comparisons.
        injectDateChangeMessageIfNeeded(buffer, false, buffer.lines.length ? buffer.lines[buffer.lines.length - 1]!.date : line.epochMs, line.epochMs);
        const created = createBufferLine({
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
        });
        buffer.lines.push(created);
        noteLineId(buffer, created.lineId, limit);
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
    // requestedLines counts what this session ASKED the server for, not what it
    // still holds. Trimming the display window must not subtract from it: the
    // scroll-up page size is derived from it (requestedLines * 2), so cancelling
    // it here made a capped buffer request a zero-sized history page forever.
    // The clamp only floors: the legacy pass still subtracts, and a counter that
    // has gone negative can never be brought back by additions alone.
    buffer.requestedLines = Math.max(0, buffer.requestedLines);
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
function trimToLimit(buffer: BufferData, limit: number): void {
    trimBufferLines(buffer, limit);
}

// Prefix display rank for nick sorting: '@' op, '%' halfop, '+' voice,
// everything else (no prefix) last.
const NICK_PREFIX_RANK: Record<string, number> = { '@': 0, '%': 1, '+': 2 };

/** Legacy parity: the old protocol delivered pre-bucketed nick groups
 *  (operators, halfops, voices, regular); the API sends one nick tree in
 *  join order, so the client restores the expected display order:
 *  operators first, then halfops, voices, the rest — alphabetical within
 *  each rank. Nick lists are small, so a full sort after each mutation
 *  beats tracking insertion positions. */
function sortGroupNicks(nicks: Nick[]): void {
    nicks.sort((a, b) => {
        const rankA = NICK_PREFIX_RANK[a.prefix] ?? 3;
        const rankB = NICK_PREFIX_RANK[b.prefix] ?? 3;
        if (rankA !== rankB) return rankA - rankB;
        return a.name.localeCompare(b.name);
    });
}

/** Flatten the API nick tree into the legacy flat group map, depth-first so
 *  group display order matches the server tree. */
function buildNicklist(buffer: BufferData, groups: NickGroupSnapshot[], nicks: NickSnapshot[]): void {
    buffer.nicklist = {};
    // A snapshot carrying the nick tree is authoritative: the switch-time
    // fetch gate must not refetch over it.
    buffer.nicklistFetched = true;
    // Groups arrive depth-first from the tree walk; keep that display order.
    for (const group of groups) {
        const key = registerGroupKey(buffer.id, group.id, group.name);
        const entry: NickGroup = createNickGroup({ name: group.name, visible: group.visible ? '1' : '0' });
        for (const snap of nicks) {
            if (snap.parentGroupId === group.id) entry.nicks.push(createNickFromApi(buffer, snap));
        }
        sortGroupNicks(entry.nicks);
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
function tallyLine(buffer: BufferData, line: LineSnapshot, activeId: string, effects: LineBatchEffects): void {
    if (isRelayStatusBuffer(buffer)) return;
    if (buffer.id === activeId) return;

    if (line.notifyLevel >= 1) {
        buffer.localUnread = (buffer.localUnread || 0) + 1;
        effects.localUnreadIds.add(buffer.id);
    }

    // Boundary-resolution counters stay deferred to the hotlist baseline
    // while the boundary is unknown (see comment above).
    if (isSyncing() && buffer.readBoundaryKnown === false) return;

    if (buffer.notify > 1 && line.notifyLevel === 1) {
        buffer.unread++;
        noteServerUnread(effects, serverKey(buffer), 1);
    }
    if (line.notifyLevel >= 2) {
        const isPrivate = buffer.type === 'private' || buffer.type === 'query';
        if (buffer.notify !== 0 && (line.highlight || isPrivate)) {
            buffer.notification++;
            noteServerUnread(effects, serverKey(buffer), 1);
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
    const isPrivateMessage = line.tags.includes('notify_private');
    const isPrivate = buffer.type === 'private' || buffer.type === 'query';
    if (buffer.notify !== 0 && (line.highlight || isPrivateMessage || isPrivate)) {
        playNotificationSound();
        if (!isWindowFocused()) {
            // Desktop notifications render plain text: run the raw relay text
            // (WeeChat color/attr controls, same encoding the chat view parses)
            // through the shared plain-text renderer, matching the legacy path.
            createHighlight(buffer, `${toPlainText(line.prefix)} ${toPlainText(line.message)}`.trim());
        }
    }
}

/** Create the ApiReducers bound to the live stores for one connection.
 *  The orchestrator already gates generations for events; the clear epoch
 *  guards delayed request responses against clears/closes. */
export function createApiStoreReducers(): ApiReducers {
    return {
        buffers(list: BufferSnapshot[]): void {
            // Queued lines belong to the state this authoritative snapshot describes.
            flushApiLineBatch();
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
            flushApiLineBatch();
            const current = get(buffers);
            const copy: Record<string, BufferData> = { ...current };
            const buffer = upsertBuffer(copy, snap);
            if (lines && lines.length) {
                const lineLimit = lineLimitFor(buffer);
                appendLines(buffer, lines, lineLimit);
                trimToLimit(buffer, lineLimit);
            }
            if (groups && groups.length) buildNicklist(buffer, groups, nicks ?? []);
            if (lines && lines.length) applyServerReadMarker(buffer, snap.lastReadLineId);
            // Publish the store first: setActiveBuffer resolves the buffer by id
            // from the live store, so a brand-new buffer must exist there before
            // the switch (and resume) logic runs.
            buffers.set(copy);
            // Auto-switch to a /query buffer once WeeChat opens it (pending switch
            // set by InputBar or a nicklist click when the target buffer did not
            // exist yet; the server context disambiguates same-nick queries).
            const pending = get(pendingBufferSwitch);
            if (matchesPendingSwitch(buffer, pending)) {
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
            flushApiLineBatch();
            const key = storeKeyForBufferId(bufferId);
            const buffer = get(buffers)[key];
            if (!buffer) return;
            groupKeys.delete(key);
            removeBuffer(key, buffer.active);
        },

        bufferUpdated(snap): void {
            flushApiLineBatch();
            // Any buffer_* change event delivers a full authoritative buffer
            // snapshot; merge metadata only (no lines/nicks, no switching).
            const key = storeKeyForBufferId(snap.id);
            // A rename arrives as just another snapshot, so the old name has to be
            // read before the merge or the draft's own key is gone. Only this
            // confirmed rename of this live buffer is migrated.
            const previousFullName = get(buffers)[key]?.fullName ?? '';
            if (previousFullName && previousFullName !== snap.name) {
                if (renameConversationDraft(previousFullName, snap.name) === 'conflict') {
                    addToast(
                        `“${snap.name}” already had unfinished text, so the draft from “${previousFullName}” was kept under its old name.`,
                        { type: 'warning', duration: 10000 },
                    );
                }
            }
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
            flushApiLineBatch();
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
            // Queued, not applied: the frame-aligned flush turns every line
            // delivered in this frame into part of ONE store update instead of
            // one whole-map + whole-lines-array copy each.
            pendingLines.push({ bufferId, line, activeId: get(activeBufferId) });
            scheduleLineFlush();
        },

        lineDataChanged(bufferId, line): void {
            flushApiLineBatch();
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
            flushApiLineBatch();
            const key = storeKeyForBufferId(bufferId);
            buffers.update((current) => {
                const buffer = current[key];
                if (!buffer) return current;
                const copy = { ...current, [key]: { ...buffer, lines: [] } };
                const target = copy[key]!;
                target.clearEpoch = (target.clearEpoch ?? 0) + 1;
                target.requestedLines = 0;
                // Nothing is held any more, so this session has fetched nothing either.
                target.newestWindowFetched = false;
                // No lines remain, so the id superset has nothing left to protect.
                target.lineIdsSeen = undefined;
                target.allLinesFetched = false;
                target.localUnread = 0;
                target.readBoundaryKnown = true;
                target.readBoundaryId = null;
                return copy;
            });
        },

        nickGroupChanged(bufferId, group): void {
            flushApiLineBatch();
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
            flushApiLineBatch();
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
            flushApiLineBatch();
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
                // A mode change (upsert with a new prefix) must re-rank the
                // nick: ops, halfops, voices, rest — see sortGroupNicks.
                sortGroupNicks(nicks);
                target.nicklist[key2] = { ...group, nicks };
                return copy;
            });
        },

        nickRemoved(bufferId, nickId): void {
            flushApiLineBatch();
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
            flushApiLineBatch();
            // Applying counts makes them authoritative for read-boundary inference;
            // endSyncPhase uses this to decide whether it may resolve boundaries.
            markHotlistBaselineApplied();
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

        ignoredEvent(): void {
            // Deliberately silent: the mapping layer has already decided this
            // event carries nothing to apply (see dispatchEvent). Logging it
            // would re-create the noise the routing exists to remove.
        },

        unhandled(detail): void {
            console.warn(`[api-store] unhandled payload: ${detail}`);
        },
    };
}
