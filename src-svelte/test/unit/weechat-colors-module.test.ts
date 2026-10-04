import { describe, it, expect } from 'vitest';

// Phase 3 boundary test: the color/format engine must stand alone in
// weechat-colors.ts with no dependency on the legacy protocol module.
import { rawText2Rich, richText2Str, convertIrcCodes } from '#lib/weechat-colors.ts';
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

    describe('parseWeechatNickColor (new API colors=weechat encoding)', () => {
        it('maps a 16-color foreground spec to a cwf- class', () => {
            expect(parseWeechatNickColor('\x19F06')).toEqual(['cwf-lightgreen']);
            expect(parseWeechatNickColor('\x19F10')).toEqual(['cwf-lightblue']);
        });

        it('maps a bare F/B to default fg/bg', () => {
            expect(parseWeechatNickColor('\x19F')).toEqual(['cwf-default']);
            expect(parseWeechatNickColor('\x19B')).toEqual(['cwb-default']);
        });

        it('maps extended colors to cef- classes', () => {
            expect(parseWeechatNickColor('\x19@12345')).toEqual(['cef-12345']);
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

        it('returns null for non-internal and unparseable strings', () => {
            expect(parseWeechatNickColor('')).toBeNull();
            expect(parseWeechatNickColor('lightgreen')).toBeNull();
            expect(parseWeechatNickColor('bar_fg')).toBeNull();
            expect(parseWeechatNickColor('\x19bF')).toBeNull();
        });
    });
});
