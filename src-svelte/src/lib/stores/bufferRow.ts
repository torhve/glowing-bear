/**
 * One buffer, projected to what the sidebar renders.
 *
 * Kept apart from `bufferProjections.ts` because the mapping and the equality rule need no
 * store. Importing them must not evaluate derived stores at import time: when
 * `retainedChat` imported this from inside the projection module, a test that mocks
 * `settings` blew up on store evaluation before any of its own code ran.
 *
 * A row is a `BufferPresentation`, never a cached `BufferData`: caching the whole buffer
 * would keep a stale `lines` array next to a row that claims to be current.
 */
import type { BufferData, BufferPresentation } from '#lib/types.ts';

/**
 * Row identity is value identity for the fields a row renders.
 *
 * `title` and `nameClasses` are compared by reference on purpose: every writer that
 * changes the topic or the name builds a new array, while a shallow clone of a buffer
 * shares the old one. Comparing their contents instead would turn "nothing changed" into
 * an O(topic length) comparison on every publication.
 *
 * The field list is a value, not a sentence. `Record<keyof BufferPresentation, true>`
 * makes a field added to the shape without an entry here a compile error; a term missing
 * from a hand-written `&&` chain is invisible until the sidebar stops repainting, because
 * the row then looks unchanged and `rowFor` hands back the previous one.
 */
const ROW_FIELDS: Record<keyof BufferPresentation, true> = {
    id: true,
    fullName: true,
    shortName: true,
    trimmedName: true,
    nameClasses: true,
    prefix: true,
    number: true,
    title: true,
    rtitle: true,
    hidden: true,
    localUnread: true,
    unread: true,
    notification: true,
    notify: true,
    serverSortKey: true,
    indent: true,
    bufferType: true,
    type: true,
    plugin: true,
    server: true,
    hideBufferLineTimes: true,
    pinned: true,
    active: true,
    localVariables: true,
};

const ROW_FIELD_KEYS = Object.keys(ROW_FIELDS) as (keyof BufferPresentation)[];

function sameRow(a: BufferPresentation, b: BufferPresentation): boolean {
    return ROW_FIELD_KEYS.every((field) => a[field] === b[field]);
}

/** Buffer object -> row, so an unchanged buffer never rebuilds its row. */
const rowByBuffer = new WeakMap<BufferData, BufferPresentation>();
/** Buffer id -> its most recent row, so an equivalent clone reuses it. */
const latestRowById = new Map<string, BufferPresentation>();

/**
 * Project one published buffer into a sidebar row.
 *
 * The second lookup is the point: the legacy hotlist poll re-references every background
 * buffer every 15 s. Those are new objects with identical values, so the freshly built row
 * is thrown away in favour of the previous one — the row object a rendered row is already
 * holding stays valid, and the array containing it compares equal.
 */
export function rowFor(buffer: BufferData): BufferPresentation {
    const cached = rowByBuffer.get(buffer);
    if (cached) return cached;

    const row: BufferPresentation = {
        id: buffer.id,
        fullName: buffer.fullName,
        shortName: buffer.shortName,
        trimmedName: buffer.trimmedName,
        nameClasses: buffer.nameClasses,
        prefix: buffer.prefix,
        number: buffer.number,
        title: buffer.title,
        rtitle: buffer.rtitle,
        hidden: buffer.hidden,
        localUnread: buffer.localUnread,
        unread: buffer.unread,
        notification: buffer.notification,
        notify: buffer.notify,
        serverSortKey: buffer.serverSortKey,
        indent: buffer.indent,
        bufferType: buffer.bufferType,
        type: buffer.type,
        plugin: buffer.plugin,
        server: buffer.server,
        hideBufferLineTimes: buffer.hideBufferLineTimes,
        pinned: buffer.pinned,
        active: buffer.active,
        localVariables: buffer.localVariables,
    };

    const previous = latestRowById.get(buffer.id);
    const reused = previous && sameRow(previous, row) ? previous : row;

    rowByBuffer.set(buffer, reused);
    latestRowById.set(buffer.id, reused);
    return reused;
}

/**
 * Drop memoised rows for buffers that no longer exist.
 *
 * The memo is bounded by the buffers present right now, and it is bounded here rather than
 * by a connection-reset hook so that every removal path bounds it — a wipe, a
 * `/buffer close`, a server part, a buffer hidden from the list.
 */
export function pruneRowMemo(liveIds: Iterable<string>): void {
    const live = new Set(liveIds);
    for (const id of latestRowById.keys()) {
        if (!live.has(id)) latestRowById.delete(id);
    }
}

/**
 * How many rows the id memo currently holds.
 *
 * A test-only view, the same kind of window `window.__chatFollowState()` is for the chat
 * viewport. The memo exists so that nothing renders from it, so its size is otherwise
 * invisible — and "this does not grow forever" is the whole claim the prune keeps true.
 */
export function memoisedRowCount(): number {
    return latestRowById.size;
}
