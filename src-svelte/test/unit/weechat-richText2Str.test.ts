import { describe, it, expect } from 'vitest';
import { rawText2Rich, richText2Str } from '$lib/weechat';
import type { RichTextPart } from '$lib/types';

describe('richText2Str serialization', () => {
    it('returns empty string for empty parts array', () => {
        const result = richText2Str([]);
        expect(result).toBe('');
    });

    it('serializes plain text with default colors', () => {
        const parts: RichTextPart[] = [{
            text: 'Hello world',
            fgColor: { type: 'weechat', name: 'default' },
            bgColor: { type: 'weechat', name: 'default' },
            attrs: { name: null, override: {} }
        }];
        const result = richText2Str(parts);
        expect(result).toBe('%00,00:Hello world');
    });

    it('serializes weechat foreground color with padded index', () => {
        // cyan is index 13 in weeChatColorsNames
        const parts: RichTextPart[] = [{
            text: 'cyan text',
            fgColor: { type: 'weechat', name: 'cyan' },
            bgColor: { type: 'weechat', name: 'default' },
            attrs: { name: null, override: {} }
        }];
        const result = richText2Str(parts);
        expect(result).toContain('%13');
        expect(result).toContain(':cyan text');
    });

    it('serializes extended colors with raw name', () => {
        const parts: RichTextPart[] = [{
            text: 'ext colored',
            fgColor: { type: 'ext', name: '51' },
            bgColor: { type: 'weechat', name: 'default' },
            attrs: { name: null, override: {} }
        }];
        const result = richText2Str(parts);
        expect(result).toContain('%51');
        expect(result).toContain(':ext colored');
    });

    it('serializes option colors with caret prefix', () => {
        const parts: RichTextPart[] = [{
            text: 'styled text',
            fgColor: { type: 'option', name: 'chat_nick_self' },
            bgColor: { type: 'weechat', name: 'default' },
            attrs: { name: null, override: {} }
        }];
        const result = richText2Str(parts);
        expect(result).toContain('^chat_nick_self');
        expect(result).toContain(':styled text');
    });

    it('serializes weechat background color', () => {
        // brown is index 07 in weeChatColorsNames
        const parts: RichTextPart[] = [{
            text: 'bg test',
            fgColor: { type: 'weechat', name: 'white' },
            bgColor: { type: 'weechat', name: 'brown' },
            attrs: { name: null, override: {} }
        }];
        const result = richText2Str(parts);
        expect(result).toContain(',07');
    });

    it('serializes extended background color', () => {
        const parts: RichTextPart[] = [{
            text: 'ext bg',
            fgColor: { type: 'weechat', name: 'default' },
            bgColor: { type: 'ext', name: '100' },
            attrs: { name: null, override: {} }
        }];
        const result = richText2Str(parts);
        expect(result).toContain(',100');
    });

    it('serializes option background color', () => {
        const parts: RichTextPart[] = [{
            text: 'opt bg',
            fgColor: { type: 'weechat', name: 'default' },
            bgColor: { type: 'option', name: 'chat_prefix_join' },
            attrs: { name: null, override: {} }
        }];
        const result = richText2Str(parts);
        expect(result).toContain(',chat_prefix_join');
    });

    it('serializes bold attribute override', () => {
        const parts: RichTextPart[] = [{
            text: 'bold',
            fgColor: { type: 'weechat', name: 'default' },
            bgColor: { type: 'weechat', name: 'default' },
            attrs: { name: null, override: { b: true } }
        }];
        const result = richText2Str(parts);
        expect(result).toContain('/*');
    });

    it('serializes italic attribute override', () => {
        const parts: RichTextPart[] = [{
            text: 'italic',
            fgColor: { type: 'weechat', name: 'default' },
            bgColor: { type: 'weechat', name: 'default' },
            attrs: { name: null, override: { i: true } }
        }];
        const result = richText2Str(parts);
        expect(result).toContain('//');
    });

    it('serializes underline attribute override', () => {
        const parts: RichTextPart[] = [{
            text: 'underlined',
            fgColor: { type: 'weechat', name: 'default' },
            bgColor: { type: 'weechat', name: 'default' },
            attrs: { name: null, override: { u: true } }
        }];
        const result = richText2Str(parts);
        expect(result).toContain('/_');
    });

    it('serializes reverse attribute override', () => {
        const parts: RichTextPart[] = [{
            text: 'reversed',
            fgColor: { type: 'weechat', name: 'default' },
            bgColor: { type: 'weechat', name: 'default' },
            attrs: { name: null, override: { r: true } }
        }];
        const result = richText2Str(parts);
        expect(result).toContain('/!');
    });

    it('serializes attribute name', () => {
        const parts: RichTextPart[] = [{
            text: 'named attr',
            fgColor: { type: 'option', name: 'chat_prefix_join' },
            bgColor: { type: 'weechat', name: 'default' },
            attrs: { name: 'chat_prefix_join', override: {} }
        }];
        const result = richText2Str(parts);
        expect(result).toContain('/chat_prefix_join');
    });

    it('concatenates multiple parts without separators', () => {
        const parts: RichTextPart[] = [
            { text: 'first', fgColor: { type: 'weechat', name: 'red' }, bgColor: { type: 'weechat', name: 'default' }, attrs: { name: null, override: {} } },
            { text: 'second', fgColor: { type: 'weechat', name: 'green' }, bgColor: { type: 'weechat', name: 'default' }, attrs: { name: null, override: {} } },
        ];
        const result = richText2Str(parts);
        expect(result).toContain(':first');
        expect(result).toContain(':second');
    });

    it('silently skips unknown weechat color names', () => {
        const parts: RichTextPart[] = [{
            text: 'unknown',
            fgColor: { type: 'weechat', name: 'nonexistent' },
            bgColor: { type: 'weechat', name: 'default' },
            attrs: { name: null, override: {} }
        }];
        const result = richText2Str(parts);
        expect(result).toContain(':unknown');
    });

    describe('round-trip through rawText2Rich → richText2Str', () => {
        // STD codes 0-16: fgColor=option (serialized as ^name), bgColor=clone, attrs.name=option name
        it('round-trips STD color code 03 (option=chat_time_delimiters)', () => {
            const input = '\x1903error\x1c';
            const parts = rawText2Rich(input);
            const result = richText2Str(parts);
            // Bare STD → option type (^name) with same bgColor and attrs.name
            expect(result).toContain('^chat_time_delimiters');
            expect(result).toContain(',chat_time_delimiters');
            expect(result).toContain('/chat_time_delimiters');
            expect(result).toContain(':error');
        });

        // STD code 15: option chat_nick_self
        it('round-trips STD color code 15 (option=chat_nick_self)', () => {
            const input = '\x1915myNick';
            const parts = rawText2Rich(input);
            const result = richText2Str(parts);
            expect(result).toContain('^chat_nick_self');
            expect(result).toContain('/chat_nick_self');
            expect(result).toContain(':myNick');
        });

        // STD codes 27-43: option type (serialized as ^name)
        it('round-trips STD color code 27 (chat_host)', () => {
            const input = '\x1927hostname';
            const parts = rawText2Rich(input);
            const serialized = richText2Str(parts);
            expect(serialized).toContain('^chat_host');
            expect(serialized).toContain(':hostname');
        });

        it('round-trips STD color code 28 (chat_delimiters)', () => {
            const input = '\x1928parens';
            const parts = rawText2Rich(input);
            const serialized = richText2Str(parts);
            expect(serialized).toContain('^chat_delimiters');
            expect(serialized).toContain(':parens');
        });

        it('round-trips STD color code 29 (chat_highlight)', () => {
            const input = '\x1929highlighted';
            const parts = rawText2Rich(input);
            const serialized = richText2Str(parts);
            expect(serialized).toContain('^chat_highlight');
            expect(serialized).toContain(':highlighted');
        });

        it('round-trips out-of-range STD code 47 to default', () => {
            const input = '\x1947fallback';
            const parts = rawText2Rich(input);
            const serialized = richText2Str(parts);
            expect(serialized).toContain('%00,00:');
            expect(serialized).toContain(':fallback');
        });

        it('round-trips STD code 44 (chat_value_null)', () => {
            const input = '\x1944null';
            const parts = rawText2Rich(input);
            const serialized = richText2Str(parts);
            expect(serialized).toContain('^chat_value_null');
            expect(serialized).toContain(':null');
        });

        it('round-trips invalid STD code 17 to default', () => {
            const input = '\x1917unstyled';
            const parts = rawText2Rich(input);
            const serialized = richText2Str(parts);
            expect(serialized).toContain('%00,00:');
            expect(serialized).toContain(':unstyled');
        });

        it('round-trips join message pattern with distinct colors', () => {
            // \x1915 = chat_nick_self (option type) + bold via \x1a*
            // \x1929 = chat_highlight (option type) for delimiters
            // \x1927 = chat_host (option type) for host info
            // Note: bare STD code \x1929 resets attrs, so bold is lost after nick
            const input = '\x1915\x1a* xt \x1929(\x1927~xt@83.242.23.252)\x1929 has joined #vev';
            const parts = rawText2Rich(input);
            const serialized = richText2Str(parts);

            // Nick "xt " should use chat_nick_self (option type) + bold
            expect(serialized).toContain('^chat_nick_self');
            expect(serialized).toContain('/*');

            // Host info "~xt@83.242.23.252" should use chat_host (code 27)
            expect(serialized).toContain('^chat_host');

            // Delimiters "(" and ")" should use chat_highlight (code 29)
            const hlCount = (serialized.match(/\^chat_highlight/g) || []).length;
            expect(hlCount).toBeGreaterThanOrEqual(2);
        });

        it('round-trips foreground color F format', () => {
            const input = '\x19F03red text';
            const parts = rawText2Rich(input);
            const result = richText2Str(parts);
            // F03 → getColorObj('03') → weechat code 03 (lightred / index 03)
            expect(result).toContain('%03');
            expect(result).toContain(':red text');
        });

        it('round-trips foreground+background * format', () => {
            const input = '\x19*03,07highlighted\x1c';
            const parts = rawText2Rich(input);
            const result = richText2Str(parts);
            expect(result).toContain('%03');
            expect(result).toContain(',07');
            expect(result).toContain(':highlighted');
        });

        it('round-trips emphasis E code', () => {
            const input = '\x19Eemphasized';
            const parts = rawText2Rich(input);
            const result = richText2Str(parts);
            expect(result).toContain('^emphasis');
            expect(result).toContain(':emphasized');
        });

        it('round-trips background color B format', () => {
            const input = '\x19B07backgrounded';
            const parts = rawText2Rich(input);
            const result = richText2Str(parts);
            expect(result).toContain(',07');
            expect(result).toContain(':backgrounded');
        });

        it('round-trips attribute set/reset sequence', () => {
            // \x1a* sets bold=true, \x1b/ sets italic=false
            // After reset, italic=false means no '//', bold persists → '/*'
            const input = '\x1a*bold\x1b/unbold text';
            const parts = rawText2Rich(input);
            const result = richText2Str(parts);
            // Bold persists through \x1b/ (which resets italic only)
            expect(result).toContain('/*');
            // Both parts should have bold since \x1b/ only affects italic
            expect(result).toMatch(/\/\*:bold.*\/\*:unbold text/);
        });

        it('round-trips extended foreground color', () => {
            // @12345 followed by non-digit text
            const input = '\x19F@12345 rest';
            const parts = rawText2Rich(input);
            const serialized = richText2Str(parts);
            expect(serialized).toContain('%12345');
            expect(serialized).toContain(': rest');
        });
    });
});
