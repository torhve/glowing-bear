import { describe, it, expect } from 'vitest';
import { shortnameToUnicode, emojifyInput } from '$lib/emojify';

describe('shortnameToUnicode', () => {
    it('converts :smile: to smile emoji', () => {
        expect(shortnameToUnicode(':smile:')).toBe('\u{1F604}');
    });

    it('converts :heart: to heart symbol', () => {
        expect(shortnameToUnicode(':heart:')).toBe('\u2764\uFE0F');
    });

    it('converts :thumbsup: to thumbs up', () => {
        expect(shortnameToUnicode(':thumbsup:')).toBe('\u{1F44D}');
    });

    it('returns original text for unknown shortcode', () => {
        expect(shortnameToUnicode(':unknown_code:')).toBe(':unknown_code:');
    });

    it('returns original text for text without colons', () => {
        expect(shortnameToUnicode('hello')).toBe('hello');
    });

    it('returns original text for empty string', () => {
        expect(shortnameToUnicode('')).toBe('');
    });

    it('returns original text for partially wrapped text', () => {
        expect(shortnameToUnicode(':smile')).toBe(':smile');
        expect(shortnameToUnicode('smile:')).toBe('smile:');
    });
});

describe('emojifyInput', () => {
    it('converts :smile: to emoji in input', () => {
        const result = emojifyInput('hello :smile:', 12);
        expect(result.text).toBe('hello \u{1F604}');
        // :smile: (7 UTF-16 units) → 😄 (2 UTF-16 units, surrogate pair). diff = -5
        expect(result.caretPos).toBe(7);
    });

    it('does not convert shortcode mixed with text', () => {
        const result = emojifyInput(':smile:foo', 0);
        expect(result.text).toBe(':smile:foo');
    });

    it('does not convert standalone text', () => {
        const result = emojifyInput('hello world', 5);
        expect(result.text).toBe('hello world');
        expect(result.caretPos).toBe(5);
    });

    it('converts multiple emoji shortcodes', () => {
        const result = emojifyInput(':smile: :heart:', 15);
        expect(result.text).toBe('\u{1F604} \u2764\uFE0F');
        // Caret 15 is past both segments (7+1+7=15), not inside either → no adjustment
        expect(result.caretPos).toBe(15);
    });

    it('preserves caret position when caret is before replacement', () => {
        // Caret at "hello " (6) is right before ":smile:" (position 6)
        // AngularJS condition: position < caret → 6 < 6 is false → no adjustment
        const result = emojifyInput('hello :smile: world', 6);
        expect(result.text).toBe('hello \u{1F604} world');
        expect(result.caretPos).toBe(6);
    });

    it('adjusts caret position inside replacement', () => {
        // Caret at "hello :s" (8), within ":smile:" (position 6, length 7)
        // 😄 is 2 UTF-16 units, diff = -5 → newCaret = 8-5 = 3
        const result = emojifyInput('hello :smile:', 8);
        expect(result.text).toBe('hello \u{1F604}');
        expect(result.caretPos).toBe(3);
    });

    it('adjusts caret position after replacement', () => {
        // Caret at "hello :smile: w" (13), ":smile:" ends at 12
        // diff = -5 → newCaret = 13-5 = 8
        const result = emojifyInput('hello :smile: world', 13);
        expect(result.text).toBe('hello \u{1F604} world');
        expect(result.caretPos).toBe(8);
    });

    it('handles empty input', () => {
        const result = emojifyInput('', 0);
        expect(result.text).toBe('');
        expect(result.caretPos).toBe(0);
    });

    it('handles whitespace-only input', () => {
        const result = emojifyInput('   ', 2);
        expect(result.text).toBe('   ');
        expect(result.caretPos).toBe(2);
    });
});
