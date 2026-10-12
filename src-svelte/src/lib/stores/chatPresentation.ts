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
import { currentBuffer } from '#lib/stores/models.ts';
import { retainedSnapshot, retainedBufferData } from '#lib/stores/retainedChat.ts';
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
 * The retained snapshot stores full `BufferData` copies, so the retained view
 * renders through the same components as live data rather than a parallel
 * read-only renderer with its own virtualization and scroll logic.
 *
 * `activeKey` is the conversation the user was reading when the session was lost.
 * Falling back to the first buffer is deliberate: if that conversation is gone, an
 * empty chat is worse than some chat.
 */
export const chatDisplay = derived(
    [currentBuffer, retainedSnapshot, connectionState],
    ([$currentBuffer, $retained, $connection]): ChatDisplay => {
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
        // lost. Falling back to any retained buffer is deliberate: if that
        // conversation is gone, some chat is better than an empty one.
        const active =
            ($retained.activeKey ? $retained.buffers.get($retained.activeKey) : undefined) ??
            $retained.buffers.values().next().value ??
            null;

        return {
            buffer: active ? retainedBufferData(active) : null,
            live: false,
        };
    },
);

/**
 * The sidebar's rows for the same view `chatDisplay` renders.
 *
 * Kept beside `chatDisplay` rather than inside `bufferProjections` on purpose:
 * the live projection is memoised against the live buffer map, and mixing a
 * frozen snapshot into that memo would let a retained row survive a live change.
 * The retained list is re-projected each time, which is cheap — it is bounded by
 * the snapshot, not by the session.
 *
 * Ordered by buffer number so the retained list reads like the live one instead
 * of like capture order.
 */
export const retainedRows = derived(
    [retainedSnapshot],
    ([$retained]): BufferPresentation[] => {
        if (!$retained) return [];
        return Array.from($retained.buffers.values())
            .filter((buffer) => !buffer.presentation.hidden)
            .map((buffer) => retainedBufferData(buffer))
            .sort((a, b) => a.number - b.number);
    },
);
