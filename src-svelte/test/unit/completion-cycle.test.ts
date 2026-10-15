import { describe, expect, it } from 'vitest';
import { cycleKey, entryIndex, stepIndex, type CompletionCycle } from '#lib/completionCycle.ts';

/**
 * The arithmetic that lets Tab and Shift-Tab walk one completion list.
 *
 * `index` records the candidate that was applied, so a step in either direction
 * is one move and the list wraps both ways. The transports differ in where the
 * candidates come from; they must agree on how they are walked.
 */

function cycle(candidates: string[], index: number): CompletionCycle {
    return { key: cycleKey('/zzz', 'buf1'), candidates, addSpace: true, index, start: 1, end: 4, context: 'command' };
}

describe('cycleKey', () => {
    it('separates the same text in different buffers', () => {
        expect(cycleKey('/zzz', 'buf1')).not.toBe(cycleKey('/zzz', 'buf2'));
    });

    it('separates different texts in the same buffer', () => {
        expect(cycleKey('/zzz', 'buf1')).not.toBe(cycleKey('/zzza ', 'buf1'));
    });
});

describe('entryIndex', () => {
    it('starts a fresh list at the first candidate going forward', () => {
        expect(entryIndex(3, 'forward')).toBe(0);
    });

    it('starts a fresh list at the last candidate going backward', () => {
        expect(entryIndex(3, 'backward')).toBe(2);
    });
});

describe('stepIndex', () => {
    it('moves to the next candidate', () => {
        expect(stepIndex(cycle(['a', 'b', 'c'], 0), 'forward')).toBe(1);
        expect(stepIndex(cycle(['a', 'b', 'c'], 1), 'forward')).toBe(2);
    });

    it('moves to the previous candidate', () => {
        expect(stepIndex(cycle(['a', 'b', 'c'], 2), 'backward')).toBe(1);
        expect(stepIndex(cycle(['a', 'b', 'c'], 1), 'backward')).toBe(0);
    });

    it('wraps past the end going forward', () => {
        expect(stepIndex(cycle(['a', 'b', 'c'], 2), 'forward')).toBe(0);
    });

    it('wraps past the start going backward', () => {
        expect(stepIndex(cycle(['a', 'b', 'c'], 0), 'backward')).toBe(2);
    });

    it('walks a whole cycle in one direction and lands back where it started', () => {
        const c = cycle(['a', 'b', 'c', 'd'], 0);
        let index = c.index;
        for (let i = 0; i < 4; i++) {
            index = stepIndex({ ...c, index }, 'forward');
        }
        expect(index).toBe(c.index);
    });

    it('returns to the same candidate after stepping forward then backward', () => {
        const c = cycle(['a', 'b', 'c'], 0);
        const forward = stepIndex(c, 'forward');
        expect(stepIndex({ ...c, index: forward }, 'backward')).toBe(0);
    });

    it('reverses a walk back to the entry candidate', () => {
        // Tab, Tab, Shift-Tab, Shift-Tab on a three-candidate list: the walk
        // returns to the first candidate and then wraps to the last one.
        const c = cycle(['a', 'b', 'c'], 0);
        const second = stepIndex(c, 'forward');
        const third = stepIndex({ ...c, index: second }, 'forward');
        const back = stepIndex({ ...c, index: third }, 'backward');
        const wrapped = stepIndex({ ...c, index: back }, 'backward');
        expect([c.candidates[second], c.candidates[third], c.candidates[back], c.candidates[wrapped]])
            .toEqual(['b', 'c', 'b', 'a']);
    });
});
