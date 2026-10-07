// Request/response feature layer (phases 8–10): history, input, completion.
//
// All three are request-correlated (not event-driven): they run through the
// generation-scoped ApiSession and re-check buffer clear epochs after every
// await, so a delayed response cannot repopulate a cleared/closed buffer or
// overwrite newer state.
//
// G1 (documented gate): POST /api/input returning 204 means *accepted for
// later execution*, not executed. It is a sufficient failure signal for draft
// retention (4xx → keep draft) but must never be used as an execution barrier
// for dependent operations.

import { get } from 'svelte/store';
import type { ApiSession, ApiSessionResponse } from '#lib/api/api-session.ts';
import { validateCompletionResponse, validateLineArray } from '#lib/api/api-validation.ts';
import { mapLine, isServerHiddenLine } from '#lib/api/api-mapping.ts';
import { storeKeyForBufferId, trimBufferLines, flushApiLineBatch, noteLineId } from '#lib/api/api-store-reducers.ts';
import { buffers, maxBufferLines, resolveReadBoundaryAfterHistory } from '#lib/stores/models.ts';
import type { CompletionResponse } from '#lib/weechat-rest-types.ts';
import type { LineSnapshot } from '#lib/api/api-contracts.ts';
import type { ApiBufferId, ApiLineId } from '#lib/api/api-ids.ts';
import { createBufferLine } from '#lib/stores/models.ts';
import type { BufferData } from '#lib/types.ts';

// ---- UTF-8 byte-offset conversion ----
// The completion request `position` is a UTF-8 code-point offset; the
// response `position_replace`/length are BYTE offsets into the command.
// Convert once, correctly, instead of scattering off-by-N slicing.

export function utf8Length(str: string): number {
    return new TextEncoder().encode(str).length;
}

/** Byte offset → JS string index. Returns null if the byte offset falls
 *  inside a multi-byte sequence (malformed boundary — caller must reject). */
export function byteOffsetToCharIndex(str: string, byteOffset: number): number | null {
    if (byteOffset < 0) return null;
    const encoder = new TextEncoder();
    let bytes = 0;
    for (let i = 0; i < str.length; i++) {
        if (bytes === byteOffset) return i;
        // Advance one code point (handling surrogate pairs).
        const code = str.codePointAt(i)!;
        const ch = code > 0xFFFF ? String.fromCodePoint(code) : str[i]!;
        bytes += encoder.encode(ch).length;
        if (bytes > byteOffset) return null; // offset landed mid-code-point
        if (code > 0xFFFF) i++; // skip low surrogate
    }
    return bytes === byteOffset ? str.length : null;
}

/** Code-point offset (client cursor) → the same offset counted in UTF-8
 *  bytes is NOT what the request wants: the request takes code points, the
 *  response answers in bytes. This helper converts a JS (UTF-16 index)
 *  cursor to the code-point offset the request expects. */
export function charIndexToCodePointOffset(str: string, charIndex: number): number {
    return Array.from(str.slice(0, charIndex)).length;
}

// ---- Phase 8: history ----

export interface HistoryRequest {
    bufferId: ApiBufferId;
    /** Newest N lines when `after` is omitted (negative `lines` in the API). */
    count: number;
    /** Exclusive lower bound: fetch `count` lines older than this line. */
    after?: ApiLineId;
}

export interface HistoryResult {
    lines: LineSnapshot[];
    /** False when the buffer was cleared/closed while the request was in flight. */
    applied: boolean;
    /** True when the server returned fewer lines than requested (start reached). */
    complete: boolean;
}

/**
 * Fetch older history for a buffer and prepend it oldest-first.
 * The clear epoch is captured before the request and re-checked after the
 * await; a bumped epoch means the response is stale and must be dropped.
 */
export async function fetchHistory(session: ApiSession, req: HistoryRequest): Promise<HistoryResult> {
    const key = storeKeyForBufferId(req.bufferId);
    const epochBefore = get(buffers)[key]?.clearEpoch ?? 0;

    const params = new URLSearchParams();
    // Negative lines = newest N; `after` pages older than a line id.
    params.set('lines', String(-Math.abs(req.count)));
    if (req.after !== undefined) params.set('after', String(req.after));
    // WeeChat-internal color codes: the renderer's rich-text engine parses
    // them; the default `ansi` encoding has no client-side parser.
    params.set('colors', 'weechat');

    const empty: HistoryResult = { lines: [], applied: false, complete: true };
    let res: ApiSessionResponse;
    try {
        res = await session.request({ method: 'GET', path: `/api/buffers/${req.bufferId}/lines?${params}` });
    } catch {
        return empty; // session closed/superseded mid-request: stale by definition
    }
    if (res.code !== 200) return empty;
    const v = validateLineArray(res.body);
    if (!v.value) {
        console.warn(`[api] invalid history payload: ${v.issues.join('; ')}`);
        return empty;
    }
    const mapped = v.value.map(mapLine).filter((l): l is LineSnapshot => l !== null);

    // Live lines queued in the current frame belong to the buffer this history
    // response is being merged into; apply them before reading and mutating it.
    flushApiLineBatch();
    const buffer = get(buffers)[key];
    if (!buffer || (buffer.clearEpoch ?? 0) !== epochBefore) {
        return { lines: mapped, applied: false, complete: mapped.length < req.count };
    }

    applyHistory(buffer, mapped);
    return { lines: mapped, applied: true, complete: mapped.length < req.count };
}
// Smart-filtered lines never land in buffer.lines, so overlapping history
// windows would re-count them in requestedLines. Remember their ids per
// buffer, reset when the buffer is cleared (epoch bump) so a refetch after
// /clear starts from a clean slate.
const hiddenLineIds = new Map<string, { epoch: number; ids: Set<number> }>();

// Drop all per-buffer tracking. Called on disconnect (resetAllState) so a
// new session's line ids — which restart from a low counter — are never
// treated as already seen from a previous session.
export function clearHiddenLineIdTracking(): void {
    hiddenLineIds.clear();
}

// Return the seen-hidden-id set for a buffer, recreating it on epoch change.
function hiddenIdsFor(buffer: BufferData): Set<number> {
    const epoch = buffer.clearEpoch ?? 0;
    let entry = hiddenLineIds.get(buffer.id);
    if (!entry || entry.epoch !== epoch) {
        entry = { epoch, ids: new Set() };
        hiddenLineIds.set(buffer.id, entry);
    }
    return entry.ids;
}

/** Prepend oldest-first, dedupe by stable lineId, keep display order. */
function applyHistory(buffer: BufferData, lines: LineSnapshot[]): void {
    const hiddenSeen = hiddenIdsFor(buffer);
    const existing = new Set(buffer.lines.map((l) => l.lineId));
    const unseen = lines
        .slice()
        .sort((a, b) => a.id - b.id)
        .filter((l) => !existing.has(`weechat:${l.id}`) && !hiddenSeen.has(l.id));
    // Count every received server line — smart-filtered joins/parts included —
    // so the requested window (requestedLines * 2) advances past hidden-line
    // regions; only displayed lines are rendered. Counting only displayed
    // lines stalls the window: a fetch of newest-N raw lines where all N are
    // hidden keeps requestedLines at 0 and the same N lines refetch forever.
    buffer.requestedLines += unseen.length;
    const fresh = unseen
        .filter((l) => !isServerHiddenLine(l))
        .map((l) => lineSnapshotToBufferLine(buffer, l));
    for (const l of unseen) if (isServerHiddenLine(l)) hiddenSeen.add(l.id);
    if (!fresh.length) return;
    buffer.lines = [...fresh, ...buffer.lines];
    // History rows are live-line candidates for the idempotence check in
    // applyLineAdded, so they must be in the buffer's id superset.
    const lineLimit = get(maxBufferLines);
    for (const l of fresh) noteLineId(buffer, l.lineId, lineLimit);
    // A capped buffer trims the oldest prepended lines right away, exactly
    // like the legacy history pass (trimmed lines still count in
    // requestedLines so scroll-up paging knows it is exhausted).
    trimBufferLines(buffer, lineLimit);
    // Bootstrap snapshots carry no lines, so WeeChat's read marker was almost
    // always outside the retained window when the buffer first appeared and the
    // boundary stayed unresolved. This is the moment it can be resolved: from the
    // marker if the window now contains it, otherwise from the hotlist count (no
    // unread means the retained history is read). Only an unresolved boundary is
    // touched — re-applying an older state would resurrect unread the user has
    // already seen.
    resolveReadBoundaryAfterHistory(buffer);
}

function lineSnapshotToBufferLine(buffer: BufferData, l: LineSnapshot) {
    // Local import cycle avoidance: models.createBufferLine is the single
    // BufferLine constructor used by every path.
    return createBufferLineForBuffer(buffer, l);
}

function createBufferLineForBuffer(buffer: BufferData, l: LineSnapshot) {
    return createBufferLine({
        buffer: buffer.id,
        date: l.epochMs,
        prefix: l.prefix,
        message: l.message,
        tags_array: l.tags,
        displayed: l.displayed ? 1 : 0,
        notify_level: l.notifyLevel,
        highlight: l.highlight ? 1 : 0,
        id: l.id,
        bufferType: buffer.type,
    });
}

// ---- Phase 9: input ----

export interface InputOutcome {
    accepted: boolean;
    status: number;
    error?: string;
}

/**
 * Send a command to a buffer. 204 = accepted (NOT executed — G1). 4xx =
 * rejected; callers keep the draft (existing send-failure behavior).
 */
export async function sendInput(
    session: ApiSession,
    bufferId: ApiBufferId | null,
    command: string,
): Promise<InputOutcome> {
    const body: Record<string, unknown> = { command };
    if (bufferId !== null) body.buffer_id = bufferId;
    // Omitting the buffer falls back to WeeChat's main buffer (live-verified);
    // an unknown name/id is 404, never a silent fallback.
    let res: ApiSessionResponse;
    try {
        res = await session.request({ method: 'POST', path: '/api/input', body });
    } catch {
        // Ambiguous failure (disconnect mid-send): never auto-retry — the
        // command may already have executed (G1). Caller offers manual retry.
        return { accepted: false, status: 0, error: 'connection lost before the server answered; the command may or may not have executed' };
    }
    if (res.code === 204 || res.code === 200) return { accepted: true, status: res.code };
    const detail = typeof res.body === 'string' ? res.body : JSON.stringify(res.body ?? '');
    return { accepted: false, status: res.code, error: detail || `input rejected (code ${res.code})` };
}

// ---- Phase 10: completion ----

export interface CompletionQuery {
    bufferId: ApiBufferId | null;
    command: string;
    /** JS string index of the cursor (UTF-16). Converted to the code-point
     *  offset the API expects. */
    cursor: number;
}

export interface CompletionResult {
    ok: boolean;
    /** Replacement range as JS string indices into `command`. */
    replaceStart: number;
    replaceEnd: number;
    candidates: string[];
    addSpace: boolean;
    context: string;
    error?: string;
}

export async function requestCompletion(session: ApiSession, q: CompletionQuery): Promise<CompletionResult> {
    const failed = (error: string): CompletionResult => ({
        ok: false, replaceStart: q.cursor, replaceEnd: q.cursor, candidates: [], addSpace: false, context: '', error,
    });
    const body: Record<string, unknown> = {
        command: q.command,
        position: charIndexToCodePointOffset(q.command, q.cursor),
    };
    if (q.bufferId !== null) body.buffer_id = q.bufferId;
    let res: ApiSessionResponse;
    try {
        res = await session.request({ method: 'POST', path: '/api/completion', body });
    } catch {
        return failed('completion request failed: session closed');
    }
    if (res.code !== 200) return failed(`completion request failed (code ${res.code})`);
    const v = validateCompletionResponse(res.body);
    if (!v.value) return failed(`invalid completion payload: ${v.issues.join('; ')}`);
    const data = v.value as CompletionResponse;

    // Response offsets are BYTES into the command; convert to JS indices.
    const start = byteOffsetToCharIndex(q.command, data.position_replace);
    if (start === null) return failed('completion replacement start lands inside a multi-byte character');
    // The replaced span is exactly base_word (live-verified wire shape:
    // {context, base_word, position_replace, add_space, list}).
    const endByte = data.position_replace + utf8Length(data.base_word);
    const end = byteOffsetToCharIndex(q.command, endByte) ?? q.command.length;
    return {
        ok: true,
        replaceStart: start,
        replaceEnd: end,
        candidates: data.list,
        addSpace: data.add_space,
        context: data.context,
    };
}

/**
 * Client-side recency re-ranking (G2 default strategy): WeeChat's candidate
 * order is preserved as the base; nicks the buffer saw most recently move
 * first, stably. `spokeAt` comes from the existing nick model.
 */
export function rankCandidates(candidates: string[], spokeAt: Map<string, number> | Record<string, number>): string[] {
    const lookup = (key: string): number | undefined =>
        spokeAt instanceof Map ? spokeAt.get(key) : spokeAt[key];
    if ((spokeAt instanceof Map ? spokeAt.size : Object.keys(spokeAt).length) === 0) return candidates;
    const norm = (s: string) => s.replace(/[:,\s]+$/, '').toLowerCase();
    return candidates.slice().sort((a, b) => {
        const ta = lookup(norm(a)) ?? 0;
        const tb = lookup(norm(b)) ?? 0;
        return tb - ta;
    });
}

/**
 * Build the text inserted by a completion candidate. WeeChat bakes the
 * completer suffix into nick candidates and, on recent versions, the
 * nick_add_space trailing space as well ("gbbot2: "). Older relay API
 * versions sent bare "nick:" candidates with add_space false, leaving the
 * input stuck onto the next word ("Bear:hello"). Restore the trailing
 * space for the nick (auto) context when the candidate lacks one.
 */
export function completionInsert(candidate: string, addSpace: boolean, context: string): string {
    let insert = candidate;
    if (context === 'auto' && !/\s$/.test(insert)) insert += ' ';
    if (addSpace) insert += ' ';
    return insert;
}
