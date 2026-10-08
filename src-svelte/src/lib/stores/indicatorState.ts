/**
 * The single source of truth behind the document title and the badge.
 *
 * Before this, three places called `updateTitle()`/`updateFavico()` — the page
 * effect (on every publication of the whole buffer map), the legacy line flush,
 * and the API store reducer. Each recomputed the totals from scratch and wrote
 * the DOM, so the same title was assigned two or three times per batch and the
 * badge re-resolved the theme palette on batches where the badge had not changed.
 *
 * Now the transports publish state and never touch the indicators. These three
 * stores are the only path to the title and the badge, and each one publishes
 * only when its *output* changed:
 *
 *   - `unreadSummary`  — the totals, compared by value;
 *   - `documentTitle`  — the exact string the tab will show;
 *   - `badgeState`     — what the badge should depict, or `null` for "no badge".
 *
 * `documentTitle` is a string, so Svelte's own equality already suppresses a
 * no-op; the other two are objects and need the explicit comparison.
 *
 * Event notifications stay where they are. A desktop alert and a sound are
 * per-message behaviour, and two messages that happen to produce the same badge
 * total are still two highlights.
 *
 * Writer contract: `documentTitle` reads the active buffer's name and topic
 * through the selective `currentBuffer`, so any writer that changes
 * `shortName`, `fullName`, or `rtitle` on the buffer being viewed MUST publish a
 * new buffer object. Mutating those fields in place on the published object
 * leaves the tab title stale with no error anywhere. The publication-invariant
 * tests in `test/unit/buffer-identity-contracts.test.ts` guard the writers that
 * exist today; a new writer is covered only when it is added to that test.
 */
import { get } from 'svelte/store';
import { buffers, currentBuffer } from '#lib/stores/models.ts';
import { settings } from '#lib/stores/settings.ts';
import { selectiveDerived } from '#lib/stores/selectiveDerived.ts';

/**
 * What the badge depicts.
 *
 * `kind` is part of the value, not a detail of rendering: the same total drawn
 * as a notification badge and as an unread badge are different pictures, so a
 * priority change with an unchanged number must still publish.
 */
export interface BadgeState {
    count: number;
    kind: 'notification' | 'unread';
}

/** Total unread and notification counts across every buffer. */
export const unreadSummary = selectiveDerived<{ unread: number; notifications: number }>(
    [buffers] as never,
    () => {
        let unread = 0;
        let notifications = 0;
        for (const key in get(buffers)) {
            const buffer = get(buffers)[key]!;
            unread += buffer.unread;
            notifications += buffer.notification;
        }
        return { unread, notifications };
    },
    (a, b) => a.unread === b.unread && a.notifications === b.notifications,
);

/**
 * The exact `document.title` the tab should show.
 *
 * Depends on `currentBuffer` rather than the buffer map: the name and topic in
 * the title belong to the buffer on screen, and `currentBuffer` is selective, so
 * traffic in a background buffer cannot recompute this part.
 */
export const documentTitle = selectiveDerived<string>(
    [unreadSummary, currentBuffer] as never,
    () => {
        const active = get(currentBuffer);
        const bufferName = active?.shortName || active?.fullName || '';
        const topic = active?.rtitle || '';
        const totals = get(unreadSummary);
        const totalUnread = totals.unread + totals.notifications;
        const prefix = totalUnread > 0 ? `(${totalUnread}) ` : '';
        return `${prefix}Glowing Bear - ${bufferName}${topic ? ` - ${topic}` : ''}`;
    },
    (a, b) => a === b,
);

/**
 * What the badge should depict, or `null` when there is no badge to draw.
 *
 * `useFavico` is an input rather than a check inside the renderer: when the
 * setting is off the store publishes `null`, which is what makes the owner clear
 * an existing badge instead of leaving a stale one behind.
 */
export const badgeState = selectiveDerived<BadgeState | null>(
    [unreadSummary, settings] as never,
    () => {
        if (!get(settings).useFavico) return null;
        const totals = get(unreadSummary);
        // Notification priority wins the badge even when the unread total is
        // larger, which is the existing rule; changing it would change what
        // users see for the same numbers.
        if (totals.notifications > 0) return { count: totals.notifications, kind: 'notification' };
        if (totals.unread > 0) return { count: totals.unread, kind: 'unread' };
        return null;
    },
    (a, b) => a === b || (a !== null && b !== null && a.count === b.count && a.kind === b.kind),
);
