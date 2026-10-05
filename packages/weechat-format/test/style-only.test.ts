/**
 * Style-only parser tests: `parseWeeChatStyle` accepts formatting-only payloads
 * and rejects unexpected text rather than guessing which segment matters.
 */

import { describe, expect, it } from 'vitest';
import { parseWeeChatStyle } from '../src/parse.js';
import type { ParseDiagnostic } from '../src/types.js';
import { CTL, summarize } from './helpers/ctl.js';

function styleOf(input: string): string {
    const result = parseWeeChatStyle(input);
    if (!result.ok) {
        throw new Error(`expected a style, got ${JSON.stringify(result)}`);
    }
    return summarize(result.style);
}

describe('accepted payloads', () => {
    it('parses a single foreground control', () => {
        expect(styleOf(`${CTL.color}F03`)).toContain('fg=red');
    });

    it('parses a combined control', () => {
        expect(styleOf(`${CTL.color}*03~04`)).toContain('bg=lightred');
    });

    it('parses several controls as one cumulative payload', () => {
        const style = styleOf(`${CTL.color}F03${CTL.setAttr}${CTL.attrBold}${CTL.color}B04`);
        expect(style).toContain('fg=red');
        expect(style).toContain('bg=lightred');
        expect(style).toContain('bold+');
    });

    it('parses a reset chain', () => {
        expect(styleOf(`${CTL.color}F03${CTL.color}${CTL.reset}`)).toBe(
            'fg=default bg=default attrs=blink-,bold-,dim-,italic-,reverse-,underline- theme=- emphasis=-',
        );
        expect(styleOf(`${CTL.color}F03${CTL.reset}`)).toBe('fg=default bg=default attrs=- theme=- emphasis=-');
    });

    it('parses emphasis toggles', () => {
        expect(styleOf(`${CTL.color}E`)).toContain('emphasis');
        expect(styleOf(`${CTL.color}E${CTL.color}E`)).toContain('emphasis=-');
    });

    it('accepts recognized-but-nonrendering bar references', () => {
        expect(styleOf(`${CTL.color}bF`)).toBe('fg=default bg=default attrs=- theme=- emphasis=-');
    });

    it('accepts a malformed payload as no change and reports it', () => {
        const diagnostics: ParseDiagnostic[] = [];
        const result = parseWeeChatStyle(`${CTL.color}F0x`, { onDiagnostic: (d) => diagnostics.push(d) });
        expect(result.ok).toBe(true);
        expect(diagnostics).toEqual([{ reason: 'invalid-numeric', offset: 0, consumed: 4 }]);
    });
});

describe('rejected payloads', () => {
    it('rejects an empty payload', () => {
        expect(parseWeeChatStyle('')).toEqual({ ok: false, reason: 'empty-input', offset: 0 });
    });

    it('rejects plain text', () => {
        expect(parseWeeChatStyle('nick')).toEqual({ ok: false, reason: 'unexpected-text', offset: 0 });
    });

    it('rejects text mixed into a formatting payload', () => {
        expect(parseWeeChatStyle(`${CTL.color}F03nick`)).toEqual({
            ok: false,
            reason: 'unexpected-text',
            offset: 4,
        });
    });

    it('rejects a printable attribute marker after a set-attribute control', () => {
        // Upstream consumes only `\x1a` here, leaving `*` as text.
        expect(parseWeeChatStyle(`${CTL.setAttr}*`)).toEqual({
            ok: false,
            reason: 'unexpected-text',
            offset: 1,
        });
    });

    it('rejects a truncated combined payload remainder', () => {
        expect(parseWeeChatStyle(`${CTL.color}*03,@12`)).toEqual({
            ok: false,
            reason: 'unexpected-text',
            offset: 5,
        });
    });
});

describe('independence', () => {
    it('returns a fresh style object per call', () => {
        const first = parseWeeChatStyle(`${CTL.color}F03`);
        const second = parseWeeChatStyle(`${CTL.color}F03`);
        expect(first.ok && second.ok).toBe(true);
        if (first.ok && second.ok) {
            expect(first.style).not.toBe(second.style);
            expect(first.style).toEqual(second.style);
            (first.style.attrs as Record<string, string>).bold = 'enabled';
            expect(second.style.attrs.bold).toBe('disabled');
        }
    });
});
