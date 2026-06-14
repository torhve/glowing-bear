import { describe, it, expect } from 'vitest';
import { buildMentionText } from '$lib/utils';
import type { Nick } from '$lib/types';

describe('buildMentionText', () => {
    it('adds colon suffix for empty input', () => {
        const result = buildMentionText('', 'Alice');
        expect(result.text).toBe('Alice: ');
        expect(result.caretPos).toBe(7);
    });

    it('adds space and nick without colon for non-empty input', () => {
        const result = buildMentionText('hello ', 'Bob');
        expect(result.text).toBe('hello Bob');
        expect(result.caretPos).toBe(9);
    });

    it('adds space before nick when input does not end with space', () => {
        const result = buildMentionText('hello', 'Charlie');
        expect(result.text).toBe('hello Charlie');
        expect(result.caretPos).toBe(13);
    });

    it('replaces trailing colon with space when nick matches, adds new nick with colon', () => {
        // AngularJS: "Alice:" → replace ":" with " " → "Alice " → append "Bob: " → "Alice Bob: "
        const nicks: Nick[] = [
            { prefix: '@', visible: 'Alice', name: 'Alice', prefixClasses: [], nameClasses: [] },
        ];
        const result = buildMentionText('Alice:', 'Bob', nicks);
        expect(result.text).toBe('Alice Bob: ');
        expect(result.caretPos).toBe(11);
    });

    it('does not replace trailing colon if nick not in nicklist', () => {
        const nicks: Nick[] = [
            { prefix: '@', visible: 'Alice', name: 'Alice', prefixClasses: [], nameClasses: [] },
        ];
        const result = buildMentionText('Charlie:', 'Bob', nicks);
        expect(result.text).toBe('Charlie: Bob');
        expect(result.caretPos).toBe(12);
    });

    it('handles multi-word input ending with colon matching nick', () => {
        // "hello Alice:" → replace ":" with " " → "hello Alice " → append "Bob: "
        const nicks: Nick[] = [
            { prefix: '@', visible: 'Alice', name: 'Alice', prefixClasses: [], nameClasses: [] },
        ];
        const result = buildMentionText('hello Alice:', 'Bob', nicks);
        expect(result.text).toBe('hello Alice Bob: ');
        expect(result.caretPos).toBe(17);
    });

    it('trims trailing whitespace before checking colon suffix', () => {
        // "Alice:  " → trimEnd → "Alice:" → replace ":" with " " → "Alice " → append "Bob: "
        const nicks: Nick[] = [
            { prefix: '@', visible: 'Alice', name: 'Alice', prefixClasses: [], nameClasses: [] },
        ];
        const result = buildMentionText('Alice:  ', 'Bob', nicks);
        expect(result.text).toBe('Alice Bob: ');
        expect(result.caretPos).toBe(11);
    });

    it('appends nick without colon for non-first mention', () => {
        const result = buildMentionText('Alice: ', 'Bob');
        expect(result.text).toBe('Alice: Bob');
        expect(result.caretPos).toBe(10);
    });
});
