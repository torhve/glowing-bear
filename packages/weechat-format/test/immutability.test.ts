/**
 * Immutability tests: emitted styles are independent and parser state is never
 * shared between calls (plan step 7: "later controls never mutate earlier
 * runs").
 */

import { describe, expect, it } from 'vitest';
import { INITIAL_STYLE, parseWeeChatText } from '../src/index.js';
import { CTL } from './helpers/ctl.js';

function snapshot(value: unknown): string {
    return JSON.stringify(value);
}

describe('emitted runs', () => {
    it('gives each run its own style object', () => {
        const runs = parseWeeChatText(`a${CTL.color}F03b${CTL.color}B04c`);
        expect(runs.length).toBe(3);
        const styles = runs.map((run) => run.style);
        expect(styles[0]).not.toBe(styles[1]);
        expect(styles[1]).not.toBe(styles[2]);
        expect(styles[0]?.attrs).not.toBe(styles[1]?.attrs);
    });

    it('does not change an earlier run when a later control changes attributes', () => {
        // Attribute objects are shared structurally between runs whose states
        // are identical; the parser must still never mutate a published one.
        const runs = parseWeeChatText(`a${CTL.setAttr}${CTL.attrBold}b${CTL.color}F03c`);
        expect(runs.map((run) => run.text)).toEqual(['a', 'b', 'c']);
        expect(runs[1]?.style.attrs.bold).toBe('enabled');
        expect(runs[2]?.style.attrs.bold).toBe('disabled');
        expect(runs[1]?.style.attrs.italic).toBe('inherited');
        expect(runs[2]?.style.attrs.italic).toBe('disabled');
    });

    it('keeps earlier runs unchanged when later controls are applied', () => {
        const short = `a${CTL.color}F03b`;
        const long = `${short}${CTL.color}B04c${CTL.reset}d${CTL.color}Ee`;
        const first = parseWeeChatText(short);
        const captured = snapshot(first);
        parseWeeChatText(long);
        expect(snapshot(first)).toBe(captured);
    });

    it('does not reuse color reference objects between runs', () => {
        const runs = parseWeeChatText(`a${CTL.color}F03b${CTL.color}F03${CTL.reset}c`);
        const reds = runs.filter((run) => run.style.fg.kind === 'weechat').map((run) => run.style.fg);
        expect(reds.length).toBeGreaterThan(0);
        for (const other of reds.slice(1)) {
            expect(other).not.toBe(reds[0]);
        }
    });
});

describe('parser state', () => {
    it('produces identical results for repeated parses', () => {
        const input = `${CTL.color}F03a${CTL.color}E b${CTL.reset}c`;
        expect(parseWeeChatText(input)).toEqual(parseWeeChatText(input));
    });

    it('starts each call from the initial style', () => {
        const dirty = `${CTL.color}F03${CTL.color}E${CTL.setAttr}${CTL.attrBold}${CTL.color}03`;
        parseWeeChatText(dirty);
        const fresh = parseWeeChatText('plain');
        expect(fresh[0]?.style).toEqual(INITIAL_STYLE);
    });

    it('never mutates the exported initial style', () => {
        const before = snapshot(INITIAL_STYLE);
        const inputs = [
            CTL.reset,
            `${CTL.color}${CTL.reset}`,
            `${CTL.color}03`,
            `${CTL.color}F03`,
            `${CTL.color}E`,
            `${CTL.color}@01234`,
        ];
        for (const input of inputs) {
            parseWeeChatText(input);
        }
        expect(snapshot(INITIAL_STYLE)).toBe(before);
        expect(Object.isFrozen(INITIAL_STYLE)).toBe(true);
        expect(Object.isFrozen(INITIAL_STYLE.attrs)).toBe(true);
    });

    it('does not carry emphasis between calls', () => {
        parseWeeChatText(`${CTL.color}E`);
        const runs = parseWeeChatText('text');
        expect(runs[0]?.style.emphasis).toBe(false);
    });
});
