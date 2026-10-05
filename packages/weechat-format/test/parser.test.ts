/**
 * Text parser tests: run boundaries, coalescing, empty and formatting-only
 * input, and preservation of ordinary text around controls.
 */

import { describe, expect, it } from 'vitest';
import { parseWeeChatText } from '../src/parse.js';
import type { ParseDiagnostic } from '../src/types.js';
import { CTL, summarizeRuns } from './helpers/ctl.js';

describe('empty and formatting-only input', () => {
    it('returns no runs for an empty string', () => {
        expect(parseWeeChatText('')).toEqual([]);
    });

    it('returns no runs for formatting-only input', () => {
        expect(parseWeeChatText(`${CTL.color}F03`)).toEqual([]);
        expect(parseWeeChatText(`${CTL.color}F03${CTL.color}E${CTL.reset}`)).toEqual([]);
    });

    it('returns no runs for input that is only a consumed control', () => {
        expect(parseWeeChatText(CTL.color)).toEqual([]);
        expect(parseWeeChatText(`${CTL.color}F`)).toEqual([]);
    });
});

describe('run boundaries', () => {
    it('emits one run for unformatted text', () => {
        expect(parseWeeChatText('hello')).toEqual([{ text: 'hello', style: expect.any(Object) }]);
    });

    it('splits text at a control that changes the style', () => {
        expect(summarizeRuns(parseWeeChatText(`a${CTL.color}F03b`))).toEqual([
            '"a" fg=default bg=default attrs=- theme=- emphasis=-',
            '"b" fg=red bg=default attrs=blink-,bold-,dim-,italic-,reverse-,underline- theme=- emphasis=-',
        ]);
    });

    it('never emits a consumed control as text', () => {
        // The malformed control is consumed; the surrounding text merges into
        // one run because the style never changed.
        const runs = parseWeeChatText(`a${CTL.color}F0xb`);
        expect(runs.map((run) => run.text)).toEqual(['ab']);
    });

    it('keeps text that follows a truncated payload', () => {
        // Upstream consumes `\x19F` plus the two-character window `0x` only.
        expect(parseWeeChatText(`${CTL.color}F0x tail`).map((run) => run.text)).toEqual([' tail']);
    });

    it('consumes a fixed-width extended background window even when it is not numeric', () => {
        // Upstream checks only that five characters exist after `@`, so `@12 re`
        // is consumed (11 units total) and only `st` survives as text.
        expect(parseWeeChatText(`${CTL.color}*03,@12 rest`).map((run) => run.text)).toEqual(['st']);
    });

    it('keeps a printable marker after a set-attribute control', () => {
        expect(parseWeeChatText(`${CTL.setAttr}*bold`).map((run) => run.text)).toEqual(['*bold']);
    });
});

describe('adjacent-run coalescing', () => {
    it('merges runs whose styles are equivalent', () => {
        const runs = parseWeeChatText(`a${CTL.color}F03b${CTL.color}F03c`);
        expect(runs.map((run) => run.text)).toEqual(['a', 'bc']);
    });

    it('does not split on a redundant control', () => {
        const runs = parseWeeChatText(`a${CTL.setAttr}${CTL.attrBold}b${CTL.setAttr}${CTL.attrBold}c`);
        expect(runs.map((run) => run.text)).toEqual(['a', 'bc']);
    });

    it('does not split on a recognized-but-nonrendering control', () => {
        const runs = parseWeeChatText(`a${CTL.color}bD${CTL.color}b_b`);
        expect(runs.map((run) => run.text)).toEqual(['ab']);
    });

    it('keeps runs distinct when only emphasis differs', () => {
        const runs = parseWeeChatText(`a${CTL.color}Eb`);
        expect(runs.map((run) => run.text)).toEqual(['a', 'b']);
    });
});

describe('diagnostics', () => {
    it('reports malformed instructions with offset and consumed extent', () => {
        const diagnostics: ParseDiagnostic[] = [];
        parseWeeChatText(`ok${CTL.color}F0x`, { onDiagnostic: (d) => diagnostics.push(d) });
        expect(diagnostics).toEqual([{ reason: 'invalid-numeric', offset: 2, consumed: 4 }]);
    });

    it('reports nothing for well-formed input', () => {
        const diagnostics: ParseDiagnostic[] = [];
        parseWeeChatText(`a${CTL.color}F03b${CTL.color}*01~02c${CTL.reset}d`, {
            onDiagnostic: (d) => diagnostics.push(d),
        });
        expect(diagnostics).toEqual([]);
    });

    it('is optional', () => {
        expect(() => parseWeeChatText(`${CTL.color}F0x`)).not.toThrow();
    });
});

describe('representative message shapes', () => {
    it('parses a timestamped chat line', () => {
        const input = [
            `${CTL.color}02`, // chat_time
            '12:34',
            `${CTL.color}${CTL.reset}`,
            `${CTL.color}14`, // chat_nick
            'nick',
            `${CTL.color}${CTL.reset}`,
            `${CTL.color}28`, // chat_delimiters
            '~',
            `${CTL.color}${CTL.reset}`,
            'hello world',
        ].join('');
        const runs = parseWeeChatText(input);
        expect(runs.map((run) => run.text)).toEqual(['12:34', 'nick', '~', 'hello world']);
        expect(runs.map((run) => run.style.themeAttrs)).toEqual([
            'chat_time',
            'chat_nick',
            'chat_delimiters',
            // A color-only reset restores the chat colors but keeps the
            // attributes, so the theme provenance of the attributes survives.
            'chat_delimiters',
        ]);
    });

    it('parses an extended-color message', () => {
        const runs = parseWeeChatText(`${CTL.color}F@00123fancy${CTL.color}B@00456bg`);
        expect(runs.map((run) => run.text)).toEqual(['fancy', 'bg']);
        expect(runs[0]?.style.fg).toEqual({ kind: 'extended', value: 123 });
        expect(runs[1]?.style.bg).toEqual({ kind: 'extended', value: 456 });
    });

    it('parses an emphasized message', () => {
        const runs = parseWeeChatText(`${CTL.color}Eimportant${CTL.color}E normal`);
        expect(runs.map((run) => run.text)).toEqual(['important', ' normal']);
        expect(runs.map((run) => run.style.emphasis)).toEqual([true, false]);
    });
});
