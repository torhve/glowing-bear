import { readString, writeString } from '#lib/storage.ts';

// Track which buffer was last viewed for reconnect recovery by fullName
// (stable across connections, e.g. "irc.server.#channel").
const LAST_BUFFER_KEY = 'gb-last-buffer';

export function recordLastBuffer(fullName: string) {
    writeString(LAST_BUFFER_KEY, fullName);
}

/** Check if this buffer matches the saved last-viewed buffer by fullName. */
export function shouldResume(fullName: string): boolean {
    return readString(LAST_BUFFER_KEY) === fullName;
}

/** Retrieve the saved fullName for the last-viewed buffer. */
export function getLastBuffer(): string | null {
    return readString(LAST_BUFFER_KEY);
}

/**
 * WeeChat's own `full_name` for the core buffer.
 *
 * Both relays report this buffer with `short_name` = `weechat` and the `plugin`
 * local variable = `core` — the reverse of what a rule written
 * `shortName === "core" && plugin === "weechat"` assumes, and that rule matches
 * nothing on the wire. The full name is the only field that identifies it.
 * Evidence: `test/fixtures/api-dossier/probes/probe-legacy-buffer-fields.mjs`.
 */
export const CORE_BUFFER_FULL_NAME = 'core.weechat';

/** A buffer as far as recovery is concerned: its name is the only field read. */
export interface ResumeCandidate {
    readonly fullName: string;
}

/** One candidate plus the key the caller needs back. */
export interface ResumeEntry<K> {
    readonly key: K;
    readonly buffer: ResumeCandidate;
}

/** Is this WeeChat's core buffer? */
function isCoreBuffer(buffer: ResumeCandidate): boolean {
    return buffer.fullName === CORE_BUFFER_FULL_NAME;
}

/** The buffer the last session ended on, when it is among the candidates. */
export function findResumedEntry<K>(entries: readonly ResumeEntry<K>[]): ResumeEntry<K> | undefined {
    const saved = getLastBuffer();
    return saved === null ? undefined : entries.find((entry) => shouldResume(entry.buffer.fullName));
}

/** Core buffer first, then whatever came first: the tail every recovery path ends with. */
export function findFallbackEntry<K>(entries: readonly ResumeEntry<K>[]): ResumeEntry<K> | undefined {
    return entries.find((entry) => isCoreBuffer(entry.buffer)) ?? entries[0];
}

/**
 * The order every recovery path uses: the buffer the user was last viewing, then
 * core, then whatever came first.
 *
 * `entries` must already be in the order that caller considers "first" — the
 * snapshot the relay just sent on a fresh connect, the live store on a handoff —
 * because the last resort is positional, not sorted.
 */
export function pickResumeTarget<K>(entries: readonly ResumeEntry<K>[]): K | null {
    return (findResumedEntry(entries) ?? findFallbackEntry(entries))?.key ?? null;
}
