/**
 * The single question the chat UI asks: "what am I rendering right now?".
 *
 * Live data wins whenever it exists. When the transport has wiped its stores but
 * a retained snapshot survives, the snapshot is what renders — as data, not as a
 * placeholder. That is what keeps a transient interruption from replacing readable
 * chat with the connection form.
 *
 * This is a presentation accessor only. It never writes to `buffers`,
 * `activeBufferId`, or any transport state, so a retained view cannot be mistaken
 * for live authority by the code that owns them.
 */

import { derived } from 'svelte/store';
import { currentBuffer, sidebarRowQualifies } from '#lib/stores/models.ts';
import { retainedSnapshot, retainedBufferData } from '#lib/stores/retainedChat.ts';
import type { RetainedBuffer, RetainedSnapshot } from '#lib/stores/retainedChat.ts';
import { settings } from '#lib/stores/settings.ts';
import { connectionState } from '#lib/stores/connectionStore.ts';
import type { BufferData, BufferPresentation } from '#lib/types.ts';

export interface ChatDisplay {
    /** The buffer to render. Null means "there is nothing to render". */
    buffer: BufferData | null;
    /** False when `buffer` came from a retained snapshot rather than the live
     *  stores. Remote actions must key off this, not off `buffer` being present:
     *  a retained buffer looks exactly like a live one. */
    live: boolean;
}

/**
 * Retained conversations in sidebar display order: buffer number, hidden ones
 * dropped. The row list and the chat's fallback both read this, so "the first
 * retained conversation" is the same buffer to the sidebar and to the chat.
 */
function retainedInDisplayOrder(snapshot: RetainedSnapshot): RetainedBuffer[] {
    return Array.from(snapshot.buffers.values())
        .filter((buffer) => !buffer.presentation.hidden)
        .sort((a, b) => a.number - b.number);
}

/**
 * Which retained conversation to show when the one the reader was in is gone.
 *
 * `onlyUnread` hides rows, so the fallback prefers a conversation the sidebar
 * would actually list: a chat with no row beside it is not a selection the
 * reader can see or return to. A fully read conversation still beats an empty
 * chat, so the display order is the last resort and a hidden buffer the very
 * last one.
 */
function pickRetainedFallback(snapshot: RetainedSnapshot, onlyUnread: boolean): RetainedBuffer | null {
    const ordered = retainedInDisplayOrder(snapshot);
    if (onlyUnread) {
        const listed = ordered.find((buffer) => sidebarRowQualifies(buffer.presentation, ''));
        if (listed) return listed;
    }
    return ordered[0] ?? snapshot.buffers.values().next().value ?? null;
}

/**
 * The retained snapshot stores full `BufferData` copies, so the retained view
 * renders through the same components as live data rather than a parallel
 * read-only renderer with its own virtualization and scroll logic.
 *
 * `activeKey` is the conversation the user was reading when the session was lost.
 * When that conversation is gone, `pickRetainedFallback` chooses what to show: an
 * empty chat is worse than some chat.
 */
export const chatDisplay = derived(
    [currentBuffer, retainedSnapshot, settings, connectionState],
    ([$currentBuffer, $retained, $settings, $connection]): ChatDisplay => {
        // Live data is authoritative for a live connection. During a reconnect's
        // bootstrap the reducers publish buffers before the session is
        // authoritative, and switching to them then would replace a readable
        // transcript with an empty one for the length of the handshake — the
        // exact regression the retained view exists to avoid. `applyRetainedHandoff`
        // runs before the transport reports `connected`, so the switch to live
        // data and the seeding of the retained window are the same step.
        const liveAuthoritative = $connection.status === 'connected';
        if (liveAuthoritative && $currentBuffer) return { buffer: $currentBuffer, live: true };
        if (!$retained) return $currentBuffer ? { buffer: $currentBuffer, live: true } : { buffer: null, live: false };

        // activeKey is the conversation the user was reading when the session was
        // lost. When that one is gone, `pickRetainedFallback` decides what to show.
        const active =
            ($retained.activeKey ? $retained.buffers.get($retained.activeKey) : undefined) ??
            pickRetainedFallback($retained, $settings.onlyUnread) ??
            null;

        return {
            buffer: active ? retainedBufferData(active) : null,
            live: false,
        };
    },
);

/**
 * Which sidebar row is the conversation on screen.
 *
 * `chatDisplay` already answers that for both views, so the sidebar marks what
 * the chat renders. `activeBufferId` cannot answer it for a retained view: the
 * wipe clears that store along with the buffers.
 */
export const activeRowId = derived(chatDisplay, ($display): string => $display.buffer?.id ?? '');
/**
 * The sidebar's rows for the same view `chatDisplay` renders.
 *
 * Kept beside `chatDisplay` rather than inside `bufferProjections` on purpose:
 * the live projection is memoised against the live buffer map, and mixing a
 * frozen snapshot into that memo would let a retained row survive a live change.
 * The retained list is re-projected each time, which is cheap — it is bounded by
 * the snapshot, not by the session.
 *
 * Ordered by buffer number through `retainedInDisplayOrder`, so the retained
 * list reads like the live one instead of like capture order.
 *
 * The membership rule is the live sidebar's, `onlyUnread` included. The setting
 * says which rows the reader wants to see, and a lost connection does not change
 * that answer: honouring it only while connected means a dropped session silently
 * shows every channel the reader had asked to suppress. The row kept for "the
 * conversation you are in" is the one `activeRowId` names: the conversation the
 * chat is rendering, which for a retained view comes from the snapshot.
 * A conversation WeeChat marks hidden gets no row on either side, `activeRowId`
 * included: hidden is a stronger rule than `onlyUnread`.
 */
export const retainedRows = derived(
    [retainedSnapshot, settings, activeRowId],
    ([$retained, $settings, $activeRowId]): BufferPresentation[] => {
        if (!$retained) return [];
        const rows = retainedInDisplayOrder($retained).map((buffer) => retainedBufferData(buffer));
        if (!$settings.onlyUnread) return rows;
        return rows.filter((row) => sidebarRowQualifies(row, $activeRowId));
    },
);
