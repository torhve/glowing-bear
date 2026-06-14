import { describe, it, expect } from 'vitest';
import { codify, inlinecolour, prefixlimit } from '$lib/filters';

describe('codify filter', () => {
    it('wraps text in backticks', () => {
        expect(codify('hello')).toBe('`hello`');
    });

    it('returns empty string for undefined input', () => {
        expect(codify(undefined)).toBe('');
    });

    it('handles empty string', () => {
        expect(codify('')).toBe('``');
    });

    it('wraps text with spaces', () => {
        expect(codify('foo bar')).toBe('`foo bar`');
    });
});

describe('inlinecolour filter', () => {
    it('converts hex color to styled span', () => {
        const result = inlinecolour('text #FF0000 more');
        expect(result).toContain('<span style="color: #FF0000">#FF0000</span>');
    });

    it('returns empty string for undefined input', () => {
        expect(inlinecolour(undefined)).toBe('');
    });

    it('handles multiple colors', () => {
        const result = inlinecolour('#FF0000 and #00FF00');
        expect(result).toContain('#FF0000</span>');
        expect(result).toContain('#00FF00</span>');
    });

    it('ignores invalid hex codes', () => {
        const result = inlinecolour('#GGG not a color');
        expect(result).toBe('#GGG not a color');
    });

    it('handles lowercase hex', () => {
        const result = inlinecolour('#aabbcc');
        expect(result).toContain('<span style="color: #aabbcc">');
    });
});

describe('prefixlimit filter', () => {
    it('returns unchanged text when within limit', () => {
        expect(prefixlimit('short', 50)).toBe('short');
    });

    it('truncates long text with ellipsis', () => {
        const longText = 'a'.repeat(100);
        const result = prefixlimit(longText, 50);
        expect(result.length).toBe(53); // 50 chars + '...'
        expect(result.endsWith('...')).toBe(true);
    });

    it('returns empty string for undefined input', () => {
        expect(prefixlimit(undefined, 50)).toBe('');
    });

    it('respects custom limit', () => {
        const text = 'hello world';
        expect(prefixlimit(text, 5)).toBe('hello...');
    });

    it('returns full text when exactly at limit', () => {
        const text = 'exact';
        expect(prefixlimit(text, 5)).toBe('exact');
    });
});
