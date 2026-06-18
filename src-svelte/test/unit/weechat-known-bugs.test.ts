// Known bug regression tests for weechat.ts
// Uses it.fails() to document known broken behavior. When a bug is fixed,
// vitest will report the test as FAILING (because it expected failure but
// got success). Remove .fails at that point to lock in the fix permanently.

import { describe, it, expect } from 'vitest';
import { rawText2Rich, convertIrcCodes } from '$lib/weechat';

// -----------------------------------------------------------------------
// Bug A: convertIrcCodes does not pad single-digit mIRC color codes
// -----------------------------------------------------------------------
// When \x03 is followed by a single digit (e.g. \x031), the parser
// outputs \x191 instead of \x1901. The downstream style matcher (^\d{2})
// requires exactly 2 digits, so the digit leaks as plain text.
// Same issue for the background component in \x03N,M combined codes.
// File: src/lib/weechat.ts, lines 311-337

describe('Bug A: convertIrcCodes single-digit mIRC color codes', () => {

    it.fails('pads single-digit foreground to 2 digits', () => {
        expect(convertIrcCodes('\x031text')).toBe('\x1901text');
    });

    it.fails('pads single-digit fg and single-digit bg to 2 digits each', () => {
        expect(convertIrcCodes('\x031,5text')).toBe('\x19*01,05text');
    });

    it.fails('pads single-digit bg with 2-digit foreground', () => {
        expect(convertIrcCodes('\x0301,5text')).toBe('\x19*01,05text');
    });

    it.fails('pads single-digit fg with 2-digit background', () => {
        expect(convertIrcCodes('\x031,05text')).toBe('\x19*01,05text');
    });

    it.fails('applies correct option color via rawText2Rich for single-digit code', () => {
        // \x031 → \x1901 after fix → option index 1 → 'chat'
        const result = rawText2Rich('\x031colored text');
        const part = result.find(p => p.text === 'colored text');
        expect(part).toBeDefined();
        // The digit '1' should NOT leak into the text
        expect(part!.text).toBe('colored text');
        expect(part!.fgColor.type).toBe('option');
        expect(part!.fgColor.name).toBe('chat');
    });

    it.fails('applies correct fg+bg colors for single-digit combined code', () => {
        // \x031,5 → \x19*01,05 → fg=option[1]='chat', bg=weechat[5]='lightred'
        const result = rawText2Rich('\x031,5text');
        const part = result.find(p => p.text === 'text');
        expect(part).toBeDefined();
        expect(part!.fgColor.type).toBe('option');
        expect(part!.fgColor.name).toBe('chat');
        expect(part!.bgColor.type).toBe('weechat');
        expect(part!.bgColor.name).toBe('lightred');
    });

});

// -----------------------------------------------------------------------
// Bug B: getColorObj strips leading digit from EXT codes in F@ format
// -----------------------------------------------------------------------
// Pattern 3 regex (F foreground) captures EXT code as (\d{5}) without the
// @ prefix, but getColorObj() unconditionally does str.substring(1),
// stripping the leading digit. F@12345 → captured "12345" →
// getColorObj("12345") returns ext:2345 instead of ext:12345.
//
// Pattern 6 (* combined fg,bg) has the same issue for the foreground EXT
// group (second alternative captures \d{5} without @).
//
// Patterns 5 (B background), 6 bg group, and 7 (fallback *) capture the
// full @\d{5} and work correctly — documented as passing guards below.
// File: src/lib/weechat.ts, lines 169-179

describe('Bug B: getColorObj EXT code handling', () => {

    describe('F@ format (pattern 3) — foreground EXT code', () => {

        it.fails('preserves all 5 digits of EXT color code', () => {
            const result = rawText2Rich('\x19F@12345ext text');
            const part = result.find(p => p.text === 'ext text');
            expect(part).toBeDefined();
            expect(part!.fgColor.type).toBe('ext');
            expect(part!.fgColor.name).toBe('12345');
        });

        it.fails('preserves EXT code with attribute prefix', () => {
            const result = rawText2Rich('\x19F\x02@12345bold ext');
            const part = result.find(p => p.text === 'bold ext');
            expect(part).toBeDefined();
            expect(part!.fgColor.type).toBe('ext');
            expect(part!.fgColor.name).toBe('12345');
        });

    });

    describe('* combined format (pattern 6) — fg EXT + bg STD/BG', () => {

        it.fails('preserves EXT foreground + STD background', () => {
            const result = rawText2Rich('\x19*@12345,07fg ext');
            const part = result.find(p => p.text === 'fg ext');
            expect(part).toBeDefined();
            expect(part!.fgColor.type).toBe('ext');
            expect(part!.fgColor.name).toBe('12345');
        });

        it.fails('preserves EXT foreground + EXT background', () => {
            const result = rawText2Rich('\x19*@12345,@067890fg ext');
            const part = result.find(p => p.text === 'fg ext');
            expect(part).toBeDefined();
            expect(part!.fgColor.type).toBe('ext');
            expect(part!.fgColor.name).toBe('12345');
            expect(part!.bgColor.type).toBe('ext');
            expect(part!.bgColor.name).toBe('67890');
        });

    });

});

// -----------------------------------------------------------------------
// Passing regression guards: working edge cases that should not regress
// -----------------------------------------------------------------------

describe('Bug guards: working EXT code paths', () => {

    it('B@ format (pattern 5) preserves EXT background code', () => {
        // Pattern 5 captures @\d{5} with @ prefix → getColorObj strips @ correctly
        const result = rawText2Rich('\x19B@12345bg only');
        const part = result.find(p => p.text === 'bg only');
        expect(part).toBeDefined();
        expect(part!.bgColor.type).toBe('ext');
        expect(part!.bgColor.name).toBe('12345');
        expect(part!.fgColor.type).toBe('weechat'); // unchanged default
    });

    it('* fallback format (pattern 7) preserves EXT foreground', () => {
        // Pattern 7 captures @\d{5} with @ prefix → getColorObj strips @ correctly
        const result = rawText2Rich('\x19*@12345fg only');
        const part = result.find(p => p.text === 'fg only');
        expect(part).toBeDefined();
        expect(part!.fgColor.type).toBe('ext');
        expect(part!.fgColor.name).toBe('12345');
    });

    it('2-digit STD codes still work correctly (no regression)', () => {
        expect(convertIrcCodes('\x0304red')).toBe('\x1904red');
        const result = rawText2Rich('\x1903red');
        const part = result.find(p => p.text === 'red');
        expect(part).toBeDefined();
        // \x19XX maps to option index XX via styleMatcher[0]
        expect(part!.fgColor.type).toBe('option');
        expect(part!.fgColor.name).toBe('chat_time_delimiters');
    });

    it('2-digit fg + 2-digit bg works (no regression)', () => {
        expect(convertIrcCodes('\x0312,04text')).toBe('\x19*12,04text');
        const result = rawText2Rich('\x19*03,07fg bg');
        const part = result.find(p => p.text === 'fg bg');
        expect(part).toBeDefined();
        // \x19* uses getColorObj, so type is 'weechat' not 'option'
        expect(part!.fgColor.type).toBe('weechat');
        expect(part!.fgColor.name).toBe('red');
        expect(part!.bgColor.type).toBe('weechat');
        expect(part!.bgColor.name).toBe('brown');
    });

});

