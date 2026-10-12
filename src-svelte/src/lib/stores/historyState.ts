/**
 * What a history fetch actually did, per buffer.
 *
 * The chat can already offer "fetch more lines" whenever history is incomplete,
 * so a retry control is not the missing piece. What was missing is the
 * difference between *not yet loaded* and *failed to load*: a buffer that
 * renders nothing and offers a button forever reads as slow rather than as
 * broken, and after a reconnect handoff that silence has somewhere to hide —
 * the seeded retained window is real content, so nothing on screen looks wrong.
 *
 * Outcomes are recorded per buffer id and are deliberately not derived from
 * `lines.length` or `allLinesFetched`. Those say what a buffer has; this says
 * what a request did, which is the thing the UI has to be honest about.
 */

import { writable } from 'svelte/store';
import type { Writable } from 'svelte/store';
import type { BufferData } from '#lib/types.ts';

export type HistoryOutcome = 'loading' | 'loaded' | 'failed';

/** Keyed by buffer id. Absent means "no fetch has been attempted for this buffer
 *  in this session", which is not the same as `failed` and must not render as it. */
export const historyOutcomes: Writable<Record<string, HistoryOutcome>> = writable({});

export function setHistoryOutcome(bufferId: string, outcome: HistoryOutcome): void {
    historyOutcomes.update((current) => {
        if (current[bufferId] === outcome) return current;
        return { ...current, [bufferId]: outcome };
    });
}

/**
 * The one case where the chat has to say out loud that history is missing.
 *
 * Every clause is load-bearing. A retained view is not this state (a frozen
 * window is honest about being frozen). A buffer with lines is not this state
 * (the transcript on screen is real). A buffer whose history is complete is not
 * this state (there is nothing missing). And an outcome that is `loading` or
 * merely absent is not this state either: a fetch that has not finished is not a
 * failure, and claiming one would be its own lie.
 */
export function historyUnavailable(
    buffer: BufferData | null,
    outcomes: Record<string, HistoryOutcome>,
): boolean {
    if (!buffer) return false;
    if (buffer.lines.length > 0 || buffer.allLinesFetched) return false;
    return outcomes[buffer.id] === 'failed';
}

/** A buffer id is a per-session identity, and 4.10.1 reuses them. Outcomes from
 *  a dead generation must not describe a buffer that a new session created under
 *  the same id. */
export function clearHistoryOutcomes(): void {
    historyOutcomes.set({});
}
