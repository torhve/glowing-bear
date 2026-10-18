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

/**
 * Row identity is value identity for the fields a row renders.
 *
 * `title` and `nameClasses` are compared by reference on purpose: every writer
 * that changes the topic or the name builds a new array, while a shallow clone
 * of a buffer shares the old one. Comparing their contents instead would turn
 * "nothing changed" into an O(topic length) comparison on every publication.
 */
function sameRow(a: BufferPresentation, b: BufferPresentation): boolean {
    return a.id === b.id
        && a.fullName === b.fullName
        && a.shortName === b.shortName
        && a.trimmedName === b.trimmedName
        && a.nameClasses === b.nameClasses
        && a.prefix === b.prefix
        && a.number === b.number
        && a.title === b.title
        && a.rtitle === b.rtitle
        && a.hidden === b.hidden
        && a.localUnread === b.localUnread
        && a.unread === b.unread
        && a.notification === b.notification
        && a.notify === b.notify
        && a.serverSortKey === b.serverSortKey
        && a.indent === b.indent
        && a.bufferType === b.bufferType
        && a.type === b.type
        && a.plugin === b.plugin
        && a.server === b.server
        && a.hideBufferLineTimes === b.hideBufferLineTimes
        && a.pinned === b.pinned
        && a.active === b.active
        && a.localVariables === b.localVariables;
}

/** Buffer object -> row, so an unchanged buffer never rebuilds its row. */
const rowByBuffer = new WeakMap<BufferData, BufferPresentation>();
/** Buffer id -> its most recent row, so an equivalent clone reuses it. */
const latestRowById = new Map<string, BufferPresentation>();

/**
 * Project one published buffer into a sidebar row.
 *
 * The second lookup is the point: the legacy hotlist poll re-references every
 * background buffer every 15 s. Those are new objects with identical values, so
 * the freshly built row is thrown away in favour of the previous one — the row
 * object a rendered row is already holding stays valid, and the array containing
 * it compares equal.
 */
function rowFor(buffer: BufferData): BufferPresentation {
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

/** Drop memoised state between connections so a new session cannot inherit rows. */
export function resetBufferProjections(): void {
    lastSignature = '';
    lastOrderedIds = [];
    latestRowById.clear();
}

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
