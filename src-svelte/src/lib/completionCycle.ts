/**
 * One completion cycle, shared by both transports.
 *
 * WeeChat answers a completion question once, and the answer belongs to the word
 * that was asked about. Asking again after a candidate has been placed asks a
 * different question: a completed command followed by a space is answered with
 * buffer names, not with the rest of the command list. So the candidate list and
 * the span it replaced are held until the composer stops matching them, which is
 * what makes Tab and Shift-Tab walk the same list in both directions.
 */

export type CompletionDirection = 'forward' | 'backward';

export interface CompletionCycle {
    /** The composer text this cycle produced, plus the buffer it belongs to. */
    key: string;
    /** Candidates in the order they are walked. */
    candidates: string[];
    /** Whether a space follows the candidate. */
    addSpace: boolean;
    /** Which candidate the last completion applied — both directions step from it. */
    index: number;
    /** Replacement span in the composer text: start inclusive, end exclusive. */
    start: number;
    /** End of the span, grown to the candidate the last completion inserted. */
    end: number;
    /** Completion context the relay reported (API path); empty when unused. */
    context: string;
}

/** A cycle belongs to one buffer's text, so a switch can never continue it. */
export function cycleKey(text: string, bufferId: string): string {
    return `${text}\u0000${bufferId}`;
}

/** Where a freshly requested list starts: forward at the top, backward at the bottom. */
export function entryIndex(count: number, direction: CompletionDirection): number {
    return direction === 'backward' ? count - 1 : 0;
}

/**
 * One step from what was applied last.
 *
 * `index` records the candidate that was applied, not the next one, so both
 * directions are a single step and the list wraps either way.
 */
export function stepIndex(cycle: CompletionCycle, direction: CompletionDirection): number {
    const n = cycle.candidates.length;
    return (cycle.index + (direction === 'backward' ? n - 1 : 1)) % n;
}
