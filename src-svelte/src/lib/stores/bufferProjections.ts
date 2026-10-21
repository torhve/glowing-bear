/**
 * Compact sidebar projections over the buffer map.
 *
 * The sidebar renders names, ordering keys and counts. It does not render lines
 * or nicklists. Publishing `BufferData` to it means the most frequent change in
 * the app — a new message in some buffer nobody is looking at — hands every row
 * a brand-new object and every row re-renders.
 *
 * Two separate goals, and they have to be measured separately:
 *
 *   - **avoid the work**: the filter+sort is memoised behind an ordering
 *     signature, so message traffic does not re-sort the sidebar;
 *   - **avoid the publication**: rows are compared by value and reused by
 *     reference, so a hotlist poll that clones every background buffer without
 *     changing any visible value publishes nothing.
 *
 * A row is a `BufferPresentation`, never a cached `BufferData`: caching the
 * whole buffer would keep a stale `lines` array next to a row that claims to be
 * current.
 */
import { get } from 'svelte/store';
import {
    activeBufferId,
    buffers,
    compareBuffersHotlist,
    getEffectiveUnread,
    sortBuffers,
} from '#lib/stores/models.ts';
import { settings } from '#lib/stores/settings.ts';
import type { BufferData, BufferPresentation } from '#lib/types.ts';
import { sameArrayByReference, selectiveDerived } from '#lib/stores/selectiveDerived.ts';
import { pruneRowMemo, rowFor } from '#lib/stores/bufferRow.ts';


/**
 * Ordering signature: everything that can change the sidebar's *structure*.
 *
 * Counts are deliberately absent — an unread badge changing must not reorder or
 * rebuild the list. Membership under `onlyUnread` is the one exception (a count
 * can add or remove a row), so the filter is applied after this signature and
 * its effect is caught by the row comparison instead.
 */
function orderingSignature(visible: BufferData[], orderByServer: boolean): string {
    let signature = orderByServer ? 's' : 'n';
    for (const buffer of visible) {
        signature += `|${buffer.id}:${buffer.pinned ? 1 : 0}:${buffer.number}:${buffer.plugin}:${buffer.server}:${buffer.serverSortKey}`;
    }
    return signature;
}

let lastSignature = '';
/** The sorted ids, memoised separately from the buffers and rows they name. */
let lastOrderedIds: string[] = [];

/**
 * Visible buffers in sidebar order, as rows.
 *
 * The memo covers the *sort*, and only the ids survive it. Memoising the sorted
 * buffer objects (or rows) instead would hide a changed unread count behind an
 * unchanged ordering — a stale projection sitting beside a live store.
 * Re-projecting from the current map is cheap because `rowFor` hands back the
 * previous row object whenever the values match, so message traffic re-projects
 * without re-sorting and without re-rendering.
 */
function orderedVisibleBuffers(): BufferPresentation[] {
    const map = get(buffers);
    const orderByServer = get(settings).orderbyserver;

    const visible: BufferData[] = [];
    for (const key in map) {
        const buffer = map[key];
        if (buffer && !buffer.hidden) visible.push(buffer);
    }

    // The id memo is bounded by the buffers that exist right now. Rows enter it only
    // through `rowFor`, which only this projection calls, so pruning here is what
    // stops it holding a row for every buffer id ever seen — after a wipe, a
    // `/buffer close`, or a server part. Bounding it in the projection rather than
    // wiring a connection-reset hook means every removal path bounds it, and the
    // connection layer does not have to know what the sidebar renders.
    pruneRowMemo(Object.keys(map));

    const signature = orderingSignature(visible, orderByServer);
    if (signature !== lastSignature) {
        lastSignature = signature;
        lastOrderedIds = sortBuffers(visible, orderByServer).map((buffer) => buffer.id);
    }

    const rows: BufferPresentation[] = [];
    for (const id of lastOrderedIds) {
        const buffer = map[id];
        // A buffer can disappear between the sort and the projection; a row for
        // a buffer that no longer exists must not be published.
        if (buffer && !buffer.hidden) rows.push(rowFor(buffer));
    }
    return rows;
}


/**
 * Visible buffers in sidebar display order, before the `onlyUnread` filter.
 *
 * This is the structural projection: a quick key is defined as "position in the
 * sorted buffer list", which is exactly this sequence and must not shift when
 * `onlyUnread` hides rows.
 */
export const sidebarOrder = selectiveDerived(
    [buffers, settings] as never,
    () => orderedVisibleBuffers().map((row) => row.id),
    (a: string[], b: string[]) => a.length === b.length && a.every((id, i) => id === b[i]),
);

/**
 * Sidebar rows in display order, with `onlyUnread` membership applied.
 *
 * `onlyUnread` keeps a row for the active buffer and for pinned buffers, which
 * is why the active id is read here rather than left to the component: the
 * membership rule is part of what the list *is*, not how it is painted.
 *
 * `activeBufferId` is read imperatively, not as a dependency, for the same
 * reason `currentBuffer` reads it that way — `setActiveBuffer` publishes the id
 * before the buffer map, and a dependency on both would recompute in between,
 * against a map where the buffer being entered still has its old `active` flag.
 */
export const sidebarRows = selectiveDerived(
    [buffers, settings] as never,
    () => {
        const onlyUnread = get(settings).onlyUnread;
        const activeId = get(activeBufferId);
        const ordered = orderedVisibleBuffers();
        if (!onlyUnread) return ordered;
        return ordered.filter(
            (row) => getEffectiveUnread(row) > 0 || row.id === activeId || row.pinned,
        );
    },
    sameArrayByReference,
);


/**
 * Hotlist entries: buffers with unread activity, ordered by `compareBuffersHotlist`
 * (highlight → unread → number).
 *
 * A separate projection rather than a filter over `sidebarRows`, because the
 * hotlist deliberately uses the raw `notification`/`unread` counts while the
 * sidebar uses `getEffectiveUnread`. Unifying them here would change what the
 * hotlist shows, and that is a behaviour change, not a performance one.
 *
 * `activeBufferId` is read imperatively for the same reason as in `sidebarRows`:
 * the hotlist excludes the active buffer, and `setActiveBuffer` publishes the id
 * before the buffer map.
 */
export const hotlistEntries = selectiveDerived(
    [buffers] as never,
    () => {
        const activeId = get(activeBufferId);
        const entries: BufferPresentation[] = [];
        for (const key in get(buffers)) {
            const buffer = get(buffers)[key]!;
            if (buffer.hidden || buffer.id === activeId) continue;
            if (buffer.notification > 0 || buffer.unread > 0) entries.push(rowFor(buffer));
        }
        return entries.sort(compareBuffersHotlist);
    },
    sameArrayByReference,
);
