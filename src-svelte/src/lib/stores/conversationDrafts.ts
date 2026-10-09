// Per-conversation composer drafts.
//
// The composer used to hold one module-level string for the whole application,
// which meant the text you were typing followed you into every other
// conversation and into the next relay you connected to. This store keys a
// draft by (profile, conversation) so a draft belongs to exactly one chat.
//
// Two rules the rest of the plan depends on:
//
//   - A draft is never keyed on a runtime buffer id. `BufferData.id` is
//     `String(apiBufferId)` and is reused across connections, so it identifies a
//     slot in one relay's live table, not a conversation.
//   - Writes carry a revision. An asynchronous operation captures the revision
//     it was computed from and refuses to apply once it has moved. A timestamp
//     cannot decide which of two writes is stale; a counter the writer must
//     acknowledge can.
//
// Nothing here is persisted yet, and nothing here migrates `inputHistory`'s
// keys — that map is keyed by runtime id and is not a draft store.

import { get } from 'svelte/store';
import { activeConnectionProfile } from '#lib/connectionProfile.ts';
import type { BufferPresentation } from '#lib/types.ts';

/** Which conversation a draft belongs to. Both halves are required: two relays
 *  can each carry a buffer named `irc.libera.#foo`, and one relay can carry the
 *  same short name on two servers. */
export interface DraftRef {
    profileKey: string;
    conversationKey: string;
}

export interface ConversationDraft {
    text: string;
    selectionStart: number;
    selectionEnd: number;
    /** Monotonic per-entry counter, bumped by every accepted write. */
    revision: number;
}

/** A captured claim on a draft. An async operation holds one of these instead of
 *  holding `message`, and only the entry still matching it may be written. */
export interface DraftClaim {
    ref: DraftRef;
    revision: number;
    text: string;
}

/**
 * Stable conversation identity for a buffer.
 *
 * `fullName` is documented as stable across connections and is the primary key.
 * When a buffer exposes no usable `fullName`, the server plus short name is the
 * next thing that survives a reconnect. When neither is usable the buffer has no
 * conversation identity at all and the caller must leave its draft unkeyed —
 * inventing a key from a runtime id is exactly the collision this module exists
 * to prevent.
 */
export function conversationKeyFor(
    buffer: Pick<BufferPresentation, 'fullName' | 'server' | 'shortName'> | null | undefined,
): string | null {
    if (!buffer) return null;
    const fullName = buffer.fullName?.trim();
    if (fullName) return fullName;
    const server = buffer.server?.trim();
    const shortName = buffer.shortName?.trim();
    if (server && shortName) return `${server}/${shortName}`;
    return null;
}

/** profileKey -> conversationKey -> draft. */
const drafts = new Map<string, Map<string, ConversationDraft>>();

function clampCaret(value: string, raw: number | undefined, fallback: number): number {
    const candidate = Number.isFinite(raw) ? Math.trunc(raw as number) : fallback;
    return Math.min(Math.max(candidate, 0), value.length);
}

/** Read one conversation's draft, or null when it has none. */
export function readDraft(ref: DraftRef): ConversationDraft | null {
    return drafts.get(ref.profileKey)?.get(ref.conversationKey) ?? null;
}

/**
 * Record what the composer currently holds for one conversation.
 *
 * Text is stored verbatim: whitespace-only input is a draft the user typed, not
 * noise to trim. An empty draft is dropped instead, so a later mount restores
 * nothing rather than restoring a phantom empty entry.
 *
 * Returns the stored entry (with its new revision) or null when there is nothing
 * to store. A write that would change nothing returns the existing entry without
 * bumping its revision: the composer persists from more than one place (the input
 * event and a mirror effect), and a redundant save must not look like the draft
 * moved to whoever holds a claim on it.
 */
export function writeDraft(
    ref: DraftRef,
    text: string,
    selectionStart?: number,
    selectionEnd?: number,
): ConversationDraft | null {
    if (text.length === 0) {
        clearDraft(ref);
        return null;
    }
    const byConversation = drafts.get(ref.profileKey) ?? new Map<string, ConversationDraft>();
    const previous = byConversation.get(ref.conversationKey);
    const start = clampCaret(text, selectionStart, text.length);
    const end = clampCaret(text, selectionEnd, text.length);
    if (previous && previous.text === text && previous.selectionStart === start && previous.selectionEnd === end) {
        return previous;
    }
    const entry: ConversationDraft = {
        text,
        selectionStart: start,
        selectionEnd: end,
        revision: (previous?.revision ?? 0) + 1,
    };
    byConversation.set(ref.conversationKey, entry);
    drafts.set(ref.profileKey, byConversation);
    return entry;
}

/**
 * Capture a claim on the current entry so an async result can be rejected later.
 *
 * A conversation with nothing stored yet still yields a claim: it started from an
 * empty draft at revision 0, and that is exactly what must still be true for its
 * completion to count.
 */
export function claimDraft(ref: DraftRef): DraftClaim {
    const entry = readDraft(ref);
    return { ref, revision: entry?.revision ?? 0, text: entry?.text ?? '' };
}

/**
 * Apply a claim, but only if the draft has not moved since it was captured.
 *
 * This is the whole race rule: a completion computed from an older draft cannot
 * overwrite text the user typed in the meantime, and a completion computed for
 * one conversation cannot land in another. Both the revision and the text must
 * match — revision alone is not enough, because two writes of the same text share
 * a revision.
 */
export function applyDraftClaim(claim: DraftClaim, text: string, selectionStart?: number, selectionEnd?: number): ConversationDraft | null {
    const entry = readDraft(claim.ref);
    const currentRevision = entry?.revision ?? 0;
    const currentText = entry?.text ?? '';
    if (currentRevision !== claim.revision || currentText !== claim.text) return null;
    return writeDraft(claim.ref, text, selectionStart, selectionEnd);
}

export function clearDraft(ref: DraftRef): void {
    const byConversation = drafts.get(ref.profileKey);
    if (!byConversation) return;
    byConversation.delete(ref.conversationKey);
    if (byConversation.size === 0) drafts.delete(ref.profileKey);
}

/** Drop every draft belonging to one relay — used when a profile is gone. */
export function clearProfileDrafts(profileKey: string): void {
    drafts.delete(profileKey);
}

export type DraftRenameOutcome = 'moved' | 'conflict' | 'noop';

/**
 * Move a draft when the relay confirms that the same live buffer changed name.
 *
 * Only a confirmed rename of a buffer this connection knows about is migrated, so
 * a name that changed while nobody was watching is never guessed at: an unmatched
 * draft stays under the name the reader gave it.
 *
 * A collision is never resolved by overwriting or concatenating. Both drafts are
 * kept and the caller reports the conflict — discarding someone's unfinished
 * sentence is not a naming detail.
 */
export function renameConversationDraft(oldFullName: string, newFullName: string): DraftRenameOutcome {
    const profileKey = get(activeConnectionProfile)?.key ?? null;
    if (!profileKey) return 'noop';
    if (!oldFullName || !newFullName || oldFullName === newFullName) return 'noop';

    const byConversation = drafts.get(profileKey);
    const source = byConversation?.get(oldFullName);
    if (!byConversation || !source) return 'noop';
    if (byConversation.has(newFullName)) return 'conflict';

    // Moved whole, selection included, rather than copied: the old name is no
    // longer a conversation this connection has.
    byConversation.delete(oldFullName);
    byConversation.set(newFullName, source);
    return 'moved';
}

/** Test-only reset so a suite cannot leak drafts into the next file. */
export function resetConversationDrafts(): void {
    drafts.clear();
}

/** Diagnostic count of stored drafts across all profiles. */
export function draftEntryCount(): number {
    let total = 0;
    for (const byConversation of drafts.values()) total += byConversation.size;
    return total;
}
