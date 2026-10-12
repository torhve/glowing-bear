// Retained chat presentation — the read-only view of a session that ended.
//
// A relay outage currently unmounts the chat and replaces it with the
// connection form, because every transport wipe clears `buffers` and the page
// renders the form whenever `connected` is false. Keeping the shell mounted
// needs a place to hold what the user had already loaded that is *not* the
// protocol state: canonical stores must keep resetting exactly as they do
// today, or generation guards, pending-request rejection and unread
// bookkeeping all start depending on stale content.
//
// This module is that place. It is a presentation store, not a cache:
//
//   - It is captured once, at the live-to-offline boundary, from stores that
//     have already drained their queued line batch.
//   - It is deep-copied. Nothing in it aliases a live `BufferData`, so a late
//     callback from the dead session cannot edit the view the user is reading.
//   - It never holds sockets, request callbacks, credentials, session objects,
//     or plugin metadata (whose `content` may be a function — executable state
//     the plan explicitly excludes).
//   - It is keyed by the connection profile, so a snapshot can never be shown
//     as some other relay's content.
//
// Why the handoff has to seed lines rather than just replace them: the API
// bootstrap requests `/api/buffers?lines=0` (api-orchestrator.ts), so a new
// generation arrives with buffer *metadata* and no message lines at all. A
// reconnect that only installs the new snapshot therefore shows an empty
// transcript. Preserving what the user had read means handing the retained
// lines to the new buffer, and that is only sound when the buffer instance is
// provably the same one — see `planRetainedHandoff`.
//
// Line identity is the subtle part. On WeeChat 4.10.1 line ids are small
// per-buffer counters that restart from a low value when WeeChat restarts; on
// 5.0 they are sparse globally-unique timestamps (api-dossier README, "Line
// identifiers are timestamps now"). So a lineId merge is only trustworthy when
// the buffer's *store key* survives the reconnect: the API key is
// `String(apiBufferId)` (a creation timestamp) and the legacy key is WeeChat's
// buffer pointer. Both survive a reconnect to the same running WeeChat and
// both change when the buffer is recreated or the process restarts. Key
// equality is therefore the runtime proof that retained ids and live ids
// describe the same buffer; without it the retained lines are dropped rather
// than risk deduping a genuinely new line against a recycled id.

import { get, readable, writable } from 'svelte/store';
import { getActiveConnectionProfile } from '#lib/connectionProfile.ts';
import { conversationKeyFor } from '#lib/stores/conversationDrafts.ts';
import { activeBufferId, buffers } from '#lib/stores/models.ts';
import { shouldResume } from '#lib/stores/bufferResume.ts';
import type { BufferData, BufferLine, Nick, NickGroup, RichTextPart } from '#lib/types.ts';

/** Why a retained view stopped being displayed. Each is a distinct product
 *  event, and the difference matters for tests: a handoff releases because the
 *  content moved into live stores, a leave releases because the user asked. */
export type RetainedReleaseReason = 'handoff' | 'explicit-leave' | 'profile-change';

/** Why a capture was refused. Capturing an empty or profile-less state would
 *  produce a snapshot that looks like a preserved session and shows nothing. */
export type RetainedRejectReason = 'no-profile' | 'no-buffers' | 'already-captured';

export interface CaptureOutcome {
    captured: boolean;
    reason?: RetainedRejectReason;
    token?: number;
}

/** One retained conversation. `key` is the canonical store key at capture
 *  time; `conversationKey` is the stable identity that survives a reconnect
 *  and is what drafts are keyed by. */
export interface RetainedBuffer {
    key: string;
    conversationKey: string | null;
    fullName: string;
    shortName: string;
    server: string;
    number: number;
    pinned: boolean;
    type: BufferData['type'];
    presentation: RetainedPresentation;
    lines: BufferLine[];
    /** Ids of the retained lines, plus any ids the transport had recorded as
     *  already on screen but had since trimmed. Seeding this into a new live
     *  buffer is what stops a replayed line rendering twice. */
    lineIdsSeen: Set<string>;
    nicklist: Record<string, NickGroup>;
    readBoundaryKnown: boolean;
    readBoundaryId: string | null;
    allLinesFetched: boolean;
}

/** The sidebar/chat-facing fields, copied so no retained row shares an array
 *  with a live buffer. `metadata` is deliberately absent: plugin metadata can
 *  carry a function, and a snapshot must not outlive the session that made it. */
export interface RetainedPresentation {
    id: string;
    fullName: string;
    shortName: string;
    trimmedName: string | null;
    nameClasses: string[];
    prefix: string;
    number: number;
    title: RichTextPart[];
    rtitle: string;
    hidden: boolean;
    localUnread: number;
    unread: number;
    notification: number;
    notify: number;
    serverSortKey: string;
    indent: boolean;
    bufferType: number;
    type: BufferData['type'];
    plugin: string;
    server: string;
    hideBufferLineTimes: boolean;
    pinned: boolean;
    active: boolean;
    localVariables?: Record<string, string>;
}

export interface RetainedSnapshot {
    /** Monotonic for the app lifetime. A capture is only ever replaced by an
     *  explicit release, never by a second capture, so a duplicate wipe cannot
     *  quietly swap in an emptier view. */
    token: number;
    profileKey: string;
    /** The transport generation this session belonged to, or null when the wipe
     *  that captured it had no generation to report. The handoff's staleness
     *  check must treat null as "no information" rather than as generation 0,
     *  which is a value a real counter can also reach. */
    generation: number | null;
    capturedAt: number;
    buffers: Map<string, RetainedBuffer>;
    /** Store key of the conversation the user was viewing, or null. */
    activeKey: string | null;
}

/** What a new authoritative buffer list means for the retained view. */
export interface HandoffPlan {
    /** Retained buffers whose store key survived: their lines and seen-ids are
     *  safe to hand to the live buffer. */
    seed: Map<string, RetainedBuffer>;
    /** Retained buffers the new generation no longer has. Their conversation
     *  may still exist under a different key, but a different buffer instance
     *  has no proven relationship to the retained lines. */
    closedOnServer: RetainedBuffer[];
    /** Key the view should show after handoff, resolved against the live list. */
    activeKey: string | null;
    /** True when `activeKey` came from the fallback chain rather than being
     *  the conversation the user was reading — the banner has to say so. */
    activeFellBack: boolean;
}

let nextToken = 1;
let current: RetainedSnapshot | null = null;
let lastRelease: { reason: RetainedReleaseReason; token: number } | null = null;
const snapshotStore = writable<RetainedSnapshot | null>(null);

/** The retained view, for presentation code. Null means "render live state". */
export const retainedSnapshot = readable<RetainedSnapshot | null>(null, (set) => {
    const unsub = snapshotStore.subscribe(set);
    return () => unsub();
});

export function getRetainedSnapshot(): RetainedSnapshot | null {
    return current;
}

/** True when a retained view exists for exactly this profile key. Used by the
 *  page to decide whether the shell stays mounted: a snapshot belonging to a
 *  different relay is never a reason to keep the shell. */
export function hasRetainedViewFor(profileKey: string | null | undefined): boolean {
    return !!current && !!profileKey && current.profileKey === profileKey;
}

/**
 * True when a retained view exists for the profile the facade currently owns.
 *
 * Both the banner and the transports' connection toasts read this. A state the
 * banner already shows must not also arrive as a toast: the toast stack sits at
 * the top-right of the window, exactly where the banner's actions are, so an
 * unowned duplicate does not merely repeat information — it covers the controls
 * that dismiss it.
 */
export function hasRetainedViewForActiveProfile(): boolean {
    return hasRetainedViewFor(getActiveConnectionProfile()?.key);
}

// ---- Loss intent ----
//
// A transport wipe cannot tell an unexpected loss from an explicit disconnect.
// On the API path `userDisconnect` is still false and `wasEverConnected` is
// still true when `resetAllState()` runs inside `disconnect()` — both are reset
// later, inside `disconnectStore()`. A predicate evaluated at wipe time therefore
// cannot classify the event. So the call site declares intent and the wipe
// consumes it: only unexpected-loss branches mark it, and neither `disconnect()`
// path does, which is what makes the facade's double wipe capture nothing.

let captureIntent = false;

/** Declare that the next wipe should retain the session it is about to destroy.
 *  Set at unexpected-loss call sites only, immediately before the wipe. */
export function markCaptureIntent(): void {
    captureIntent = true;
}

/** Read and clear the intent. True at most once per mark, so a second wipe from
 *  the same loss — the facade's double disconnect, a legacy retry timer —
 *  captures nothing. */
export function consumeCaptureIntent(): boolean {
    const marked = captureIntent;
    captureIntent = false;
    return marked;
}

/** Drop a pending intent without capturing. Explicit departure uses this so an
 *  intent left by an earlier loss can never leak into a later wipe. */
export function clearCaptureIntent(): void {
    captureIntent = false;
}

export function hasCaptureIntent(): boolean {
    return captureIntent;
}

// ---- Deep copy ----
// Every mutable container reachable from a rendered row is rebuilt. Strings,
// numbers and booleans are shared because they cannot be mutated in place.

function copyRichTextPart(part: RichTextPart): RichTextPart {
    return {
        text: part.text,
        fgColor: { type: part.fgColor.type, name: part.fgColor.name },
        bgColor: { type: part.bgColor.type, name: part.bgColor.name },
        attrs: { name: part.attrs.name, override: { ...part.attrs.override } },
        classes: part.classes ? [...part.classes] : part.classes,
        $$hashKey: part.$$hashKey,
    };
}

function copyRichTextParts(parts: RichTextPart[] | undefined): RichTextPart[] {
    return (parts ?? []).map(copyRichTextPart);
}

/** Copy a rendered line. `metadata` is dropped on purpose — see the header. */
function copyBufferLine(line: BufferLine): BufferLine {
    const copy: BufferLine = {
        prefix: copyRichTextParts(line.prefix),
        content: copyRichTextParts(line.content),
        date: line.date,
        shortTime: line.shortTime,
        buffer: line.buffer,
        tags: [...line.tags],
        highlight: line.highlight,
        displayed: line.displayed,
        prefixtext: line.prefixtext,
        text: line.text,
        showHiddenBrackets: line.showHiddenBrackets,
        lineId: line.lineId,
        notifyLevel: line.notifyLevel,
        isUserMessage: line.isUserMessage,
        isDateSeparator: line.isDateSeparator,
    };
    return copy;
}

function copyNick(nick: Nick): Nick {
    return {
        nickId: nick.nickId,
        prefix: nick.prefix,
        visible: nick.visible,
        name: nick.name,
        prefixClasses: [...nick.prefixClasses],
        nameClasses: [...nick.nameClasses],
        buffer: nick.buffer,
        spokeAt: nick.spokeAt,
    };
}

function copyNicklist(nicklist: Record<string, NickGroup>): Record<string, NickGroup> {
    const copy: Record<string, NickGroup> = {};
    for (const [groupKey, group] of Object.entries(nicklist)) {
        copy[groupKey] = {
            name: group.name,
            visible: group.visible,
            nicks: (group.nicks ?? []).map(copyNick),
        };
    }
    return copy;
}

function copyPresentation(buffer: BufferData): RetainedPresentation {
    return {
        id: buffer.id,
        fullName: buffer.fullName,
        shortName: buffer.shortName,
        trimmedName: buffer.trimmedName,
        nameClasses: [...buffer.nameClasses],
        prefix: buffer.prefix,
        number: buffer.number,
        title: copyRichTextParts(buffer.title),
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
        localVariables: buffer.localVariables ? { ...buffer.localVariables } : buffer.localVariables,
    };
}

function copyRetainedBuffer(key: string, buffer: BufferData): RetainedBuffer {
    return {
        key,
        conversationKey: conversationKeyFor(buffer),
        fullName: buffer.fullName,
        shortName: buffer.shortName,
        server: buffer.server,
        number: buffer.number,
        pinned: buffer.pinned,
        type: buffer.type,
        presentation: copyPresentation(buffer),
        lines: buffer.lines.map(copyBufferLine),
        // A fresh Set, never the live one: `lineIdsSeen` is mutated by every
        // later insert and rebuilt when it drifts past its cap.
        lineIdsSeen: buffer.lineIdsSeen ? new Set(buffer.lineIdsSeen) : new Set<string>(),
        nicklist: copyNicklist(buffer.nicklist ?? {}),
        readBoundaryKnown: buffer.readBoundaryKnown === true,
        readBoundaryId: buffer.readBoundaryId ?? null,
        allLinesFetched: buffer.allLinesFetched,
    };
}

// ---- Capture ----

/**
 * Freeze what the user currently has, for the profile that is connected.
 *
 * Call this from a transport's wipe, *after* it has flushed its queued line
 * batch and *before* it clears `buffers` — that is the only moment the stores
 * hold the complete session. The caller decides whether this runs at all: a
 * wipe cannot tell an unexpected loss from an explicit disconnect, and an
 * explicit disconnect must not capture.
 *
 * A capture is never replaced by another capture. Repeated failed reconnect
 * attempts each wipe, and each would otherwise overwrite a useful snapshot
 * with an emptier one, which is the failure mode the plan calls out.
 */
export function captureRetainedState(generation: number | null): CaptureOutcome {
    const profile = getActiveConnectionProfile();
    if (!profile) return { captured: false, reason: 'no-profile' };

    if (current) {
        // Same relay, already retained: keep the first, more complete capture.
        if (current.profileKey === profile.key) return { captured: false, reason: 'already-captured', token: current.token };
        // A different relay owns the retained view. It is released before a new
        // session can be retained, so reaching here means the caller did not
        // release on departure — refuse rather than silently swap profiles.
        return { captured: false, reason: 'already-captured', token: current.token };
    }

    const live = get(buffers);
    const keys = Object.keys(live);
    if (keys.length === 0) return { captured: false, reason: 'no-buffers' };

    const snapshot: RetainedSnapshot = {
        token: nextToken++,
        profileKey: profile.key,
        generation,
        capturedAt: Date.now(),
        buffers: new Map(),
        activeKey: get(activeBufferId) || null,
    };
    for (const key of keys) {
        const buffer = live[key];
        if (!buffer) continue;
        snapshot.buffers.set(key, copyRetainedBuffer(key, buffer));
    }
    if (snapshot.buffers.size === 0) return { captured: false, reason: 'no-buffers' };

    current = snapshot;
    snapshotStore.set(snapshot);
    return { captured: true, token: snapshot.token };
}

/**
 * Release the retained view. Idempotent: a second release is a no-op, which is
 * what makes the facade's double disconnect harmless.
 */
/**
 * Move the retained view to another retained conversation.
 *
 * This is the retained view's OWN selection. It deliberately does not write
 * `activeBufferId`: that store is live transport authority, and putting a frozen
 * key in it would let every live path resolve a buffer the relay is not serving.
 * The consequence is that URL/Deep-link state, which is derived from the live
 * selection, does NOT follow a retained selection. That is deliberate for a
 * transient offline window — a link is a claim about a conversation the relay can
 * still address. A handoff that wants to land where the reader was must read
 * `activeKey` from the snapshot, not the URL.
 * buffer's key into it would make the retained view addressable by every path
 * that resolves a live buffer — which is the exact confusion this module exists
 * to prevent. Returns false when the snapshot does not hold that conversation,
 * so a click on a row that has gone cannot leave the view pointing at nothing.
 */
export function selectRetainedBuffer(key: string): boolean {
    if (!current) return false;
    if (!current.buffers.has(key)) return false;
    current = { ...current, activeKey: key };
    snapshotStore.set(current);
    return true;
}

export function releaseRetainedSnapshot(reason: RetainedReleaseReason): void {
    // A release ends the session it belonged to, so a capture intent marked for
    // that session must not survive into a later wipe — including a wipe by the
    // OTHER transport after a profile change, which is the one path where mark
    // and consume are not adjacent. Cleared before the early return: an intent
    // with no snapshot yet is still an intent belonging to a finished session.
    clearCaptureIntent();
    if (!current) return;
    lastRelease = { reason, token: current.token };
    current = null;
    snapshotStore.set(null);
}

/** Which release last cleared the view, and the snapshot it cleared. Each
 *  reason is a distinct product event, so a test can tell a handoff from a
 *  Leave from a profile change instead of just seeing "nothing there". */
export function getLastRelease(): { reason: RetainedReleaseReason; token: number } | null {
    return lastRelease;
}

/**
 * Release the retained view if it belongs to a relay other than the one now
 * marked active. Call this right after `setActiveConnectionProfile` so the
 * comparison uses the canonical key builder rather than a hand-assembled one.
 *
 * An attempt for the SAME relay keeps the view: that attempt is a retry, and
 * its successful bootstrap is where the retained window gets handed off.
 */
export function releaseIfProfileChanged(): boolean {
    if (!current) return false;
    const profile = getActiveConnectionProfile();
    if (profile && current.profileKey === profile.key) return false;
    releaseRetainedSnapshot('profile-change');
    return true;
}

// ---- Handoff ----

/**
 * Decide what a new authoritative buffer list means for the retained view.
 *
 * Pure: it reads the live keys and reports a plan, it does not write to any
 * store. Wiring the plan into the stores is the transport's job.
 *
 * The classification is by **store key**, not by name. Key equality is the only
 * runtime evidence that the live buffer is the same buffer instance the
 * retained lines came from, and therefore that its line ids are comparable.
 * A buffer that reappears under a new key is a different instance: its
 * retained lines are dropped rather than merged, because on 4.10.1 line ids
 * restart from a low counter and a recycled id would silently delete a real
 * line from the merged view.
 */
export function planRetainedHandoff(liveKeys: Iterable<string>): HandoffPlan | null {
    if (!current) return null;

    const live = new Set(liveKeys);
    const seed = new Map<string, RetainedBuffer>();
    const closedOnServer: RetainedBuffer[] = [];

    for (const retained of current.buffers.values()) {
        if (live.has(retained.key)) seed.set(retained.key, retained);
        else closedOnServer.push(retained);
    }

    const retainedActive = current.activeKey ? current.buffers.get(current.activeKey) : undefined;
    // Both branches below assign it, so there is no intermediate null state.
    let activeKey: string | null;
    let activeFellBack = false;

    if (retainedActive && live.has(retainedActive.key)) {
        // The conversation the user was reading survived as the same instance:
        // carry the selection forward, exactly as the offline browsing policy
        // intends.
        activeKey = retainedActive.key;
    } else {
        // The old conversation is gone or is a different instance. Resolve a
        // live fallback with the same order the transports already use on a
        // fresh connect, so recovery is not a third policy. `fullName` is the
        // value `shouldResume` compares against; it is what WeeChat calls the
        // buffer's `name` in a snapshot.
        const liveBuffers = get(buffers);
        const ordered = [...live]
            .map((key) => ({ key, buffer: liveBuffers[key] }))
            .filter((entry): entry is { key: string; buffer: BufferData } => !!entry.buffer);
        const resume = ordered.find((entry) => shouldResume(entry.buffer.fullName));
        const core = ordered.find((entry) => entry.buffer.fullName === 'core.weechat');
        const fallback = resume ?? core ?? ordered[0];
        activeKey = fallback?.key ?? null;
        activeFellBack = !!activeKey;
    }

    return { seed, closedOnServer, activeKey, activeFellBack };
}

/**
 * Merge retained lines with the lines a live buffer already has.
 *
 * Returns a new array; the retained snapshot is never mutated, so a handoff
 * that is later abandoned leaves the view intact.
 *
 * Order is retained-first: the retained window is older history, and the live
 * buffer of a freshly bootstrapped session normally has no lines at all. Any
 * live line whose id is already retained is skipped, which is the duplicate
 * this merge exists to prevent. The retained window is never deduped against
 * itself: those rows are what the user is already looking at, so dropping one
 * because its id is in the seen-set would delete a line from the view.
 *
 * A line with no id at all (older relays fall back to a content hash) cannot
 * be matched, so it is kept. That errs toward a duplicate row rather than
 * toward losing a real one, which is the same direction of error `noteLineId`
 * chose for `lineIdsSeen`.
 */
export function mergeRetainedLines(retained: RetainedBuffer, liveLines: BufferLine[]): BufferLine[] {
    const merged: BufferLine[] = [];
    const seen = new Set<string>(retained.lineIdsSeen);
    for (const line of retained.lines) {
        merged.push(line);
        if (line.lineId) seen.add(line.lineId);
    }
    for (const line of liveLines) {
        if (line.lineId && seen.has(line.lineId)) continue;
        if (line.lineId) seen.add(line.lineId);
        merged.push(line);
    }
    return merged;
}

/** The ids a live buffer must start with so later inserts dedupe against the
 *  retained window. Superset semantics match `noteLineId`: extra ids cost a
 *  scan that finds nothing, a missing id renders a duplicate row. */
export function retainedLineIds(retained: RetainedBuffer): Set<string> {
    const ids = new Set<string>(retained.lineIdsSeen);
    for (const line of retained.lines) if (line.lineId) ids.add(line.lineId);
    return ids;
}

// Test/diagnostic helper: the retained view's buffer count, for the invariant
// that repeated retries do not grow or shrink the snapshot.
export function retainedBufferCount(): number {
    return current?.buffers.size ?? 0;
}

/**
 * Rebuild a `BufferData` from a retained buffer, so the chat components render a
 * retained view through the same code path as live data instead of a parallel
 * read-only renderer with its own virtualization and scroll logic.
 *
 * `RetainedPresentation` mirrors `BufferPresentation` field for field, which is
 * what makes this a total conversion rather than a lossy one.
 *
 * `apiBufferId` and `clearEpoch` are deliberately absent. They are transport
 * authority: an `apiBufferId` is what an API call addresses, and a `clearEpoch` is
 * what a delayed history response is validated against. A snapshot must not carry
 * either, or a retained buffer could be mistaken for an addressable live one.
 */
export function retainedBufferData(retained: RetainedBuffer): BufferData {
    return {
        ...retained.presentation,
        lines: retained.lines,
        // A stale `requestedLines` would make the page's history gate fetch more
        // for a buffer that is frozen. Reporting the lines actually held keeps the
        // retained view inert.
        requestedLines: retained.lines.length,
        allLinesFetched: retained.allLinesFetched,
        lastSeen: 0,
        readBoundaryKnown: retained.readBoundaryKnown,
        readBoundaryId: retained.readBoundaryId,
        lineIdsSeen: retained.lineIdsSeen,
        nicklist: retained.nicklist,
    };
}