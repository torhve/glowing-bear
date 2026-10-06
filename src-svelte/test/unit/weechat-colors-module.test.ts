import { describe, it, expect } from 'vitest';

// Phase 3 boundary test: the color/format engine must stand alone in
// weechat-colors.ts with no dependency on the legacy protocol module.
import { rawText2Rich, richText2Str, convertIrcCodes, toPlainText } from '#lib/weechat-colors.ts';
import { parseWeechatNickColor } from '#lib/weechat-colors.ts';

describe('weechat-colors (standalone formatting module)', () => {
    it('parses plain text and serializes it back to rich format', () => {
        const parts = rawText2Rich('plain text');
        expect(parts.length).toBe(1);
        expect(parts[0]!.text).toBe('plain text');
        expect(parts[0]!.fgColor).toEqual({ type: 'weechat', name: 'default' });
        expect(richText2Str(parts)).toBe('%00,00:plain text');
    });

    it('converts IRC formatting codes to WeeChat rich format', () => {
        const converted = convertIrcCodes('\x02bold\x02');
        const parts = rawText2Rich(converted);
        expect(parts.some((p) => p.text.includes('bold'))).toBe(true);
    });

    it('has no import dependency on the legacy protocol module', async () => {
        // Guard the extraction: weechat-colors must not import weechat.ts.
        const fs = await import('node:fs');
        const path = await import('node:path');
        const file = path.resolve(__dirname, '../../src/lib/weechat-colors.ts');
        const src = fs.readFileSync(file, 'utf8');
        expect(src).not.toMatch(/from\s+['"]#lib\/weechat\.ts['"]/);
    });

    describe('toPlainText (notification body rendering)', () => {
        it('drops WeeChat color and attribute controls, keeping the text', () => {
            expect(toPlainText('\x19F06alice\x19')).toBe('alice');
            expect(toPlainText('\x19F03hello \x1a\x02bold')).toBe('hello bold');
            expect(toPlainText('\x19F|04nick: \x19F09msg')).toBe('nick: msg');
        });

        it('drops mIRC controls mixed into relay text', () => {
            expect(toPlainText('\x02bold\x03,10mirc')).toBe('boldmirc');
        });

        it('passes plain text through and tolerates empty input', () => {
            expect(toPlainText('plain text')).toBe('plain text');
            expect(toPlainText('')).toBe('');
            expect(toPlainText(null)).toBe('');
        });

        it('never leaves control bytes in the output', () => {
            const out = toPlainText('\x19F10\x1a\x02\x1b\x01\x03stray\x1c');
            expect(out).not.toMatch(/[\x01-\x1f]/);
        });
    });

    describe('parseWeechatNickColor (new API colors=weechat encoding)', () => {
        it('maps a 16-color foreground spec to a cwf- class', () => {
            expect(parseWeechatNickColor('\x19F06')).toEqual(['cwf-lightgreen', 'cwb-default']);
            expect(parseWeechatNickColor('\x19F10')).toEqual(['cwf-lightblue', 'cwb-default']);
        });

        it('maps a bare F/B to default fg/bg', () => {
            // A truncated payload is consumed without changing the style, so both
            // stay at the chat default.
            expect(parseWeechatNickColor('\x19F')).toEqual(['cwf-default', 'cwb-default']);
            expect(parseWeechatNickColor('\x19B')).toEqual(['cwf-default', 'cwb-default']);
        });

        it('maps a bare pair number to default colors', () => {
            // \x19@NNNNN selects a curses color pair, which has no DOM equivalent;
            // WeeChat leaves the style untouched, so the classes stay default.
            expect(parseWeechatNickColor('\x19@12345')).toEqual(['cwf-default', 'cwb-default']);
        });

        it('maps fg+bg specs to both classes', () => {
            const classes = parseWeechatNickColor('\x19*03,05');
            expect(classes).toContain('cwf-red');
            expect(classes).toContain('cwb-green');
        });

        it('turns embedded attribute chars into a- classes', () => {
            const classes = parseWeechatNickColor('\x19F*06');
            expect(classes).toContain('a-b');
            expect(classes).toContain('cwf-lightgreen');
        });

        it('maps a theme color reference to cof-/cob- classes', () => {
            expect(parseWeechatNickColor('\x1914')).toEqual(['cof-chat_nick', 'cob-chat_nick']);
            expect(parseWeechatNickColor('\x1915')).toEqual(['cof-chat_nick_self', 'cob-chat_nick_self']);
        });

        it('renders the removed chat_nick1..chat_nick10 slots as the default color', () => {
            // Slots 17-26 survive in WeeChat's theme enum; the app has no CSS for
            // them, so they resolve to the default text color.
            expect(parseWeechatNickColor('\x1917')).toEqual(['cwf-default', 'cwb-default']);
        });

        it('maps bar references to the default colors', () => {
            expect(parseWeechatNickColor('\x19bF')).toEqual(['cwf-default', 'cwb-default']);
        });

        it('returns null for names that are not internal codes', () => {
            expect(parseWeechatNickColor('')).toBeNull();
            expect(parseWeechatNickColor('lightgreen')).toBeNull();
            expect(parseWeechatNickColor('bar_fg')).toBeNull();
        });
    });
});
