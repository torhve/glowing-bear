import { describe, it, expect } from 'vitest';

// Phase 3 boundary test: the color/format engine must stand alone in
// weechat-colors.ts with no dependency on the legacy protocol module.
import { rawText2Rich, richText2Str, convertIrcCodes } from '#lib/weechat-colors.ts';

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
});
