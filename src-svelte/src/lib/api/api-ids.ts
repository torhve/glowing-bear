// Branded WeeChat Relay API identifiers and sentinel handling.
//
// Buffer/nick/nick-group IDs are creation timestamps in microseconds
// (~1.79e15 today); line IDs are small per-buffer counters that legitimately
// include 0. All arrive as JSON numbers. We brand them so domain code cannot
// mix pointer strings (legacy) with numeric IDs, and we validate the numeric
// boundary at the network edge instead of trusting the wire.

export type ApiBufferId = number & { readonly __apiBufferId: unique symbol };
export type ApiLineId = number & { readonly __apiLineId: unique symbol };
export type ApiNickId = number & { readonly __apiNickId: unique symbol };
export type ApiGroupId = number & { readonly __apiGroupId: unique symbol };

/** Root nick group is a fixed synthetic node, not a timestamp. */
export const ROOT_GROUP_ID = 0 as ApiGroupId;
/** "No parent group" for the root node. */
export const NO_PARENT_GROUP = -1;
/** "No read marker" — every retained line may be unread. */
export const NO_READ_LINE = -1;

/* All wire IDs must be safe integers; buffer/nick/group IDs are positive
 * timestamps, line IDs are >= 0 counters. Validate — do not assume. */
export function asBufferId(value: unknown): ApiBufferId | null {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
        ? (value as ApiBufferId)
        : null;
}

export function asLineId(value: unknown): ApiLineId | null {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
        ? (value as ApiLineId)
        : null;
}

export function asNickId(value: unknown): ApiNickId | null {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
        ? (value as ApiNickId)
        : null;
}

/* Group IDs include the synthetic root (0) and NO_PARENT_GROUP (-1) when used
 * as a parent reference; as a node identity only >= 0 is valid. */
export function asGroupId(value: unknown): ApiGroupId | null {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
        ? (value as ApiGroupId)
        : null;
}

/* Parent references additionally allow -1. Never test existence with
 * truthiness: 0 (root) and -1 (no parent) are meaningful values. */
export function asParentGroupId(value: unknown): ApiGroupId | typeof NO_PARENT_GROUP | null {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= NO_PARENT_GROUP
        ? (value as ApiGroupId)
        : null;
}

/* Read markers additionally allow -1 (no marker). */
export function asReadLineId(value: unknown): ApiLineId | typeof NO_READ_LINE | null {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= NO_READ_LINE
        ? (value as ApiLineId)
        : null;
}

/** Stable map-key form of any numeric ID (domain stores key on strings). */
export function idKey(id: number): string {
    return String(id);
}
