/**
 * Table integrity tests. These guard the transcription from WeeChat 4.10.1:
 * counts, index alignment and uniqueness are exactly what a consumer relies on
 * when it maps an index to a name.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
    ATTRIBUTE_CONTROL_CHARS,
    ATTRIBUTE_NAMES,
    BAR_REFERENCES,
    EXTENDED_ATTRIBUTE_CHARS,
    MAX_EXTENDED_COLOR,
    MAX_THEME_COLOR,
    MAX_WEECHAT_COLOR,
    THEME_COLORS,
    WEECHAT_PALETTE,
} from '../src/tables.js';

describe('named palette', () => {
    it('has the 17 entries GUI_CURSES_NUM_WEECHAT_COLORS defines', () => {
        expect(WEECHAT_PALETTE.length).toBe(17);
        expect(MAX_WEECHAT_COLOR).toBe(16);
    });

    it('starts with the terminal default and ends with white', () => {
        expect(WEECHAT_PALETTE[0]).toBe('default');
        expect(WEECHAT_PALETTE[16]).toBe('white');
    });

    it('has no duplicate names', () => {
        expect(new Set(WEECHAT_PALETTE).size).toBe(WEECHAT_PALETTE.length);
    });
});

describe('theme option colors', () => {
    it('has the 47 entries t_gui_color_enum defines', () => {
        expect(THEME_COLORS.length).toBe(47);
        expect(MAX_THEME_COLOR).toBe(46);
    });

    it('keeps the obsolete chat_nick1..chat_nick10 block at indices 17-26', () => {
        expect(THEME_COLORS.slice(17, 27)).toEqual([
            'chat_nick1',
            'chat_nick2',
            'chat_nick3',
            'chat_nick4',
            'chat_nick5',
            'chat_nick6',
            'chat_nick7',
            'chat_nick8',
            'chat_nick9',
            'chat_nick10',
        ]);
    });

    it('has no duplicate names', () => {
        expect(new Set(THEME_COLORS).size).toBe(THEME_COLORS.length);
    });
});

describe('attribute encodings', () => {
    it('maps exactly the six GUI_COLOR_ATTR_* control characters', () => {
        expect([...ATTRIBUTE_CONTROL_CHARS.keys()]).toEqual(['\x01', '\x02', '\x03', '\x04', '\x05', '\x06']);
        expect([...ATTRIBUTE_CONTROL_CHARS.values()]).toEqual([
            'bold',
            'reverse',
            'italic',
            'underline',
            'blink',
            'dim',
        ]);
    });

    it('maps exactly the six printable payload flags', () => {
        expect([...EXTENDED_ATTRIBUTE_CHARS.keys()]).toEqual(['%', '.', '*', '!', '/', '_']);
    });

    it('lists every attribute name once', () => {
        expect(ATTRIBUTE_NAMES.length).toBe(6);
        expect(new Set(ATTRIBUTE_NAMES).size).toBe(6);
        expect(new Set(ATTRIBUTE_CONTROL_CHARS.values())).toEqual(new Set(ATTRIBUTE_NAMES));
        expect(new Set(EXTENDED_ATTRIBUTE_CHARS.values())).toEqual(new Set(ATTRIBUTE_NAMES));
    });
});

describe('bar references', () => {
    it('covers the nine GUI_COLOR_BAR_* references', () => {
        expect(BAR_REFERENCES.size).toBe(9);
        expect(BAR_REFERENCES.get('F')).toBe('fg');
        expect(BAR_REFERENCES.get('D')).toBe('delim');
        expect(BAR_REFERENCES.get('B')).toBe('bg');
        expect(BAR_REFERENCES.get('s')).toBe('spacer');
    });
});

describe('extended colors', () => {
    it('accepts the range GUI_COLOR_EXTENDED_MAX defines', () => {
        expect(MAX_EXTENDED_COLOR).toBe(99999);
    });
});

describe('documentation', () => {
    it('states the same table sizes the code uses', () => {
        const spec = readFileSync(new URL('../docs/format.md', import.meta.url), 'utf8');
        expect(spec).toContain('index 0..16');
        expect(spec).toContain('0..46');
        expect(spec).toContain('GUI_CURSES_NUM_WEECHAT_COLORS == 17');
    });

    it('records a migration decision for every divergence the differential suite asserts', () => {
        const ledger = readFileSync(new URL('../docs/behavior-differences.md', import.meta.url), 'utf8');
        const differential = readFileSync(new URL('../test/differential.test.ts', import.meta.url), 'utf8');
        const divergingCases = [...differential.matchAll(/current: \[([^\]]*)\]/g)]
            .filter((match) => (match[1] ?? '').trim().length > 0).length;
        const decidedRows = [...ledger.matchAll(/\*\*(decide|adapter|approved|match)\*\*/g)].length;
        expect(divergingCases).toBeGreaterThan(5);
        // Every divergence the suite locks in must carry a status in the ledger.
        expect(decidedRows).toBeGreaterThanOrEqual(divergingCases);
    });
});
