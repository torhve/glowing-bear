import { describe, it, expect } from 'vitest';
import { joinMultilineToSingle, MULTILINE_PASTE_THRESHOLD } from '$lib/utils';

describe('joinMultilineToSingle', () => {
    it('joins normal multi-line text with single spaces', () => {
        expect(joinMultilineToSingle('line1\nline2\nline3')).toBe('line1 line2 line3');
    });

    it('handles CRLF line endings', () => {
        expect(joinMultilineToSingle('line1\r\nline2\r\nline3')).toBe('line1 line2 line3');
    });

    it('trims leading and trailing whitespace on each line', () => {
        expect(joinMultilineToSingle('  line1  \n\tline2 \nline3  ')).toBe('line1 line2 line3');
    });

    it('drops empty and blank lines', () => {
        expect(joinMultilineToSingle('line1\n\nline2\n   \nline3')).toBe('line1 line2 line3');
    });

    it('ignores trailing newline', () => {
        expect(joinMultilineToSingle('line1\nline2\n')).toBe('line1 line2');
    });

    it('passes through single-line text unchanged (trimmed)', () => {
        expect(joinMultilineToSingle('hello world')).toBe('hello world');
    });

    it('collapses multiple internal newlines into a single space', () => {
        expect(joinMultilineToSingle('a\n\n\nb')).toBe('a b');
    });

    it('returns empty string for all-blank input', () => {
        expect(joinMultilineToSingle('\n\n  \n')).toBe('');
    });
});

describe('MULTILINE_PASTE_THRESHOLD', () => {
    it('is 3 (pastes of 3+ lines trigger the confirmation dialog)', () => {
        expect(MULTILINE_PASTE_THRESHOLD).toBe(3);
    });

    it('line counting via split matches the threshold semantics', () => {
        expect('line1\nline2'.split(/\r?\n/).length).toBeLessThan(MULTILINE_PASTE_THRESHOLD);
        expect('line1\nline2\nline3'.split(/\r?\n/).length).toBeGreaterThanOrEqual(MULTILINE_PASTE_THRESHOLD);
    });
});
