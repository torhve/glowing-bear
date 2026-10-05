/**
 * Unicode tests: text is preserved exactly and offsets are UTF-16 indices.
 */

import { describe, expect, it } from 'vitest';
import { parseWeeChatStyle, parseWeeChatText } from '../src/parse.js';
import type { ParseDiagnostic } from '../src/types.js';
import { CTL } from './helpers/ctl.js';

describe('text preservation', () => {
    const samples = [
        'héllo wörld',
        'naïve café',
        '日本語のテキスト',
        '한국어 텍스트',
        'עברית RTL',
        '😀 emoji 😀',
        '𝔘𝔪𝔞𝔱𝔥 math',
        'e\u0301 combining acute',
        'a\u200bzero width space',
        'tab\tand\nnewline',
        ' nbsp',
    ];

    for (const sample of samples) {
        it(`preserves ${JSON.stringify(sample)} exactly`, () => {
            const runs = parseWeeChatText(sample);
            expect(runs.length).toBe(1);
            expect(runs[0]?.text).toBe(sample);
        });
    }

    it('preserves Unicode across control boundaries', () => {
        const runs = parseWeeChatText(`😀${CTL.color}F03😀${CTL.color}${CTL.reset}😀`);
        expect(runs.map((run) => run.text)).toEqual(['😀', '😀', '😀']);
    });

    it('does not normalize decomposed sequences', () => {
        const decomposed = 'cafe\u0301';
        const runs = parseWeeChatText(`${CTL.color}F03${decomposed}`);
        expect(runs[0]?.text).toBe(decomposed);
        expect(runs[0]?.text).not.toBe('café');
    });

    it('preserves a lone surrogate pair half unchanged', () => {
        const lone = '\ud83d';
        const runs = parseWeeChatText(`a${CTL.color}F03${lone}b`);
        expect(runs[1]?.text).toBe(`${lone}b`);
    });

    it('preserves NUL as ordinary text', () => {
        // JavaScript strings are length-terminated; NUL only bounds payloads.
        const runs = parseWeeChatText('a\u0000b');
        expect(runs.map((run) => run.text)).toEqual(['a\u0000b']);
    });
});

describe('UTF-16 offsets', () => {
    it('reports diagnostic offsets as UTF-16 indices', () => {
        const input = `😀${CTL.color}F0x`;
        const diagnostics: ParseDiagnostic[] = [];
        parseWeeChatText(input, { onDiagnostic: (d) => diagnostics.push(d) });
        // The emoji occupies two UTF-16 units, so the control starts at 2.
        expect(diagnostics).toEqual([{ reason: 'invalid-numeric', offset: 2, consumed: 4 }]);
    });

    it('reports style-parse failure offsets as UTF-16 indices', () => {
        const result = parseWeeChatStyle(`${CTL.color}E😀text`);
        expect(result).toEqual({ ok: false, reason: 'unexpected-text', offset: 2 });
    });
});
