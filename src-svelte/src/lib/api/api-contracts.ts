// Domain contracts for the Relay API migration (phase 3).
//
// These types define the normalized shape the session layer hands to feature
// reducers, and the reducer interface itself — so bootstrap orchestration
// (phase 6) can be built and tested against injected fakes before the
// concrete feature reducers (phases 7–10) exist.
//
// Contract rules (TODO.md §Identity/content rules):
// - Buffer content type (formatted/free) is separate from the semantic buffer
//   type (server/channel/private/… derived from local_variables).
// - Omitted sub-resources are modeled as absent, distinct from present-empty.
// - IDs are branded numbers; -1/0 sentinels are explicit, never truthiness.
// - Raw ISO date strings are retained; parsed epoch ms is derived, and no
//   timestamp is ever used as a line identity.

import type { ApiBufferId, ApiGroupId, ApiLineId, ApiNickId } from '#lib/api/api-ids.ts';
import type { CompletionResponse } from '#lib/weechat-rest-types.ts';

/** Wire content type — NOT the legacy semantic BufferType. */
export type BufferContentType = 'formatted' | 'free';

/** Semantic type derived from local_variables (e.g. irc → channel/private). */
export type SemanticBufferType =
    | 'server' | 'channel' | 'private' | 'query' | 'channel_temp'
    | 'relay' | 'other';

/** Hotlist counts with named slots; wire order is [low, message, private, highlight]. */
export interface HotlistCounts {
    low: number;
    message: number;
    private: number;
    highlight: number;
}

export interface HotlistSnapshot {
    priority: number; // 0..3
    date: string; // raw ISO
    counts: HotlistCounts;
}

/** Normalized buffer metadata handed to reducers (no lines/nicks embedded). */
export interface BufferSnapshot {
    id: ApiBufferId;
    name: string;
    shortName: string;
    number: number;
    contentType: BufferContentType;
    semanticType: SemanticBufferType;
    hidden: boolean;
    title: string; // raw colored wire string; formatting applied by reducers
    modes: string;
    inputPrompt: string;
    input: string;
    inputPosition: number;
    inputMultiline: boolean;
    hasNicklist: boolean;
    nicklistCaseSensitive: boolean;
    nicklistDisplayGroups: boolean;
    timeDisplayed: boolean;
    localVariables: Record<string, string>;
    /** Server-side read marker; NO_READ_LINE (-1) means "no marker". */
    lastReadLineId: ApiLineId | -1;
}

/** Normalized line; raw strings preserved, parsed time derived separately. */
export interface LineSnapshot {
    id: ApiLineId;
    y: number; // wire position hint; -1 when not meaningful
    date: string; // raw ISO
    datePrinted: string; // raw ISO
    epochMs: number; // derived from date, display-only
    displayed: boolean;
    highlight: boolean;
    notifyLevel: number; // -1 = notify_none tag; 0..3 = low/message/private/highlight
    prefix: string; // colored wire string
    message: string; // colored wire string
    tags: string[];
}

export interface NickSnapshot {
    id: ApiNickId;
    parentGroupId: ApiGroupId | -1;
    prefix: string;
    prefixColorName: string;
    prefixColor: string;
    name: string;
    colorName: string;
    color: string;
    visible: boolean;
}

export interface NickGroupSnapshot {
    id: ApiGroupId; // 0 = synthetic root
    parentGroupId: ApiGroupId | -1; // -1 for root
    name: string;
    colorName: string;
    color: string;
    visible: boolean;
}

/**
 * Session-to-reducer interface. The session layer (phase 5) parses and
 * validates wire payloads, then calls exactly these methods; feature reducers
 * (phases 7–10) implement it. Every method receives normalized snapshots —
 * never raw wire objects.
 */
export interface ApiReducers {
    /** Full authoritative buffer list from GET /api/buffers. */
    buffers(buffers: BufferSnapshot[]): void;
    /** Buffer metadata snapshot from a buffer_opened event body (may include
     *  initial lines/nicks — passed separately, omitted ≠ empty). */
    bufferOpened(snapshot: BufferSnapshot, lines: LineSnapshot[] | undefined, groups: NickGroupSnapshot[] | undefined, nicks: NickSnapshot[] | undefined): void;
    bufferClosing(bufferId: ApiBufferId): void;
    bufferClosed(bufferId: ApiBufferId): void;
    bufferTitleChanged(bufferId: ApiBufferId, title: string): void;
    bufferLocalvarSet(bufferId: ApiBufferId, name: string, value: string): void;
    bufferLocalvarRemoved(bufferId: ApiBufferId, name: string): void;
    bufferModesChanged(bufferId: ApiBufferId, modes: string): void;
    bufferInputChanged(bufferId: ApiBufferId, input: string, cursorPos: number): void;
    lineAdded(bufferId: ApiBufferId, line: LineSnapshot): void;
    lineDataChanged(bufferId: ApiBufferId, line: LineSnapshot): void;
    bufferCleared(bufferId: ApiBufferId): void;
    nickGroupChanged(bufferId: ApiBufferId, group: NickGroupSnapshot): void;
    nickGroupRemoved(bufferId: ApiBufferId, groupId: ApiGroupId): void;
    nickChanged(bufferId: ApiBufferId, nick: NickSnapshot): void;
    nickRemoved(bufferId: ApiBufferId, nickId: ApiNickId): void;
    hotlist(entries: Map<ApiBufferId, HotlistSnapshot>): void;
    completion(bufferId: ApiBufferId, response: CompletionResponse): void;
    /** Server rejected a command (400/403/404 on an input request). */
    inputRejected(requestId: string, error: string): void;
    /** Unknown event name or invalid payload: reducers must not crash; the
     *  session reports here so callers can log/ignore without state damage. */
    unhandled(reason: string): void;
}

/** Derive the semantic buffer type from local_variables (live-verified:
 *  IRC buffers carry local_variables.type = channel|private|server). */
export function deriveSemanticType(localVariables: Record<string, string>): SemanticBufferType {
    switch (localVariables.type) {
    case 'channel': return 'channel';
    case 'private': return 'private';
    case 'server': return 'server';
    case 'query': return 'query';
    case 'channel_temp': return 'channel_temp';
    default:
        if (localVariables.plugin === 'irc') {
            return localVariables.channel ? 'channel' : 'other';
        }
        return 'other';
    }
}

/** Map wire hotlist count tuple to named slots (order verified live). */
export function hotlistCounts(count: number[]): HotlistCounts {
    return {
        low: count[0] ?? 0,
        message: count[1] ?? 0,
        private: count[2] ?? 0,
        highlight: count[3] ?? 0,
    };
}
