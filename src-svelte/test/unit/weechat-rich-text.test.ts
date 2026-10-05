import { describe, it, expect } from 'vitest';
import { Protocol } from '#lib/weechat.ts';
import { rawText2Rich, richText2Str, convertIrcCodes } from '#lib/weechat-colors.ts';

// --- rawText2Rich conversion tests ---

describe('Protocol rawText2Rich conversion', () => {
    describe('basic text', () => {
        it('returns single part for plain text without styles', () => {
            const result = rawText2Rich('Hello world');
            expect(result).toHaveLength(1);
            expect(result[0]!.text).toBe('Hello world');
        });

        it('handles empty string', () => {
            const result = rawText2Rich('');
            expect(result).toHaveLength(1);
            expect(result[0]!.text).toBe('');
        });

        it('handles null input', () => {
            const result = rawText2Rich(null as unknown as string);
            expect(result).toHaveLength(1);
            expect(result[0]!.text).toBe('');
        });
    });

    describe('WeeChat color codes (\\x19)', () => {
        it('parses STD color code 42 (emphasis) as option type', () => {
            // Code 42 maps to option 'emphasis'
            const result = rawText2Rich('\x1942emphasized text');
            const part = result.find(p => p.text === 'emphasized text');
            expect(part).toBeDefined();
            expect(part!.fgColor.type).toBe('option');
            expect(part!.fgColor.name).toBe('emphasis');
        });

        it('parses bare STD color code as option type', () => {
            // Old JS: bare STD codes map to option type via styleMatcher[0]
            // Code 03 → option name 'chat_time_delimiters'
            const result = rawText2Rich('\x1903error\x1900');
            const errorPart = result.find(p => p.text === 'error');
            expect(errorPart).toBeDefined();
            expect(errorPart!.fgColor.type).toBe('option');
            expect(errorPart!.fgColor.name).toBe('chat_time_delimiters');
        });

        it('treats bare EXT code as unimplemented (old JS returns null)', () => {
            // Bare @NNNNN is unimplemented in old JS — returns null for all fields
            // Text remains unchanged, colors stay at defaults
            const result = rawText2Rich('\x19@12345colored text');
            const coloredPart = result.find(p => p.text.includes('colored text'));
            expect(coloredPart).toBeDefined();
            expect(coloredPart!.fgColor.type).toBe('weechat');
            expect(coloredPart!.fgColor.name).toBe('default');
        });

        it('parses foreground color F format', () => {
            const result = rawText2Rich('\x19F03red text');
            const redPart = result.find(p => p.text === 'red text');
            expect(redPart).toBeDefined();
            expect(redPart!.fgColor.type).toBe('weechat');
            expect(redPart!.fgColor.name).toBe('red');
        });

        it('parses foreground+background with * format', () => {
            const result = rawText2Rich('\x19*03,07highlighted');
            const part = result.find(p => p.text === 'highlighted');
            expect(part).toBeDefined();
            expect(part!.fgColor.type).toBe('weechat');
            expect(part!.bgColor.type).toBe('weechat');
        });

        it('parses foreground color F with STD + attributes', () => {
            // F*03 means: bold + red (code 03)
            const result = rawText2Rich('\x19F*03bold red');
            const part = result.find(p => p.text === 'bold red');
            expect(part).toBeDefined();
            expect(part!.fgColor.type).toBe('weechat');
            expect(part!.attrs.override.b).toBe(true);
        });

        it('parses foreground color F with EXT + attributes', () => {
            // F@00042 means: extended color 42
            const result = rawText2Rich('\x19F@00042ext text');
            const part = result.find(p => p.text === 'ext text');
            expect(part).toBeDefined();
            expect(part!.fgColor.type).toBe('ext');
            expect(part!.fgColor.name).toBe('42');
        });

        it('parses background color B format', () => {
            const result = rawText2Rich('\x19B07backgrounded');
            const part = result.find(p => p.text === 'backgrounded');
            expect(part).toBeDefined();
            expect(part!.bgColor.type).toBe('weechat');
            expect(part!.bgColor.name).toBe('brown');
        });

        it('parses emphasis E code', () => {
            const result = rawText2Rich('\x19Eemphasized');
            const part = result.find(p => p.text === 'emphasized');
            expect(part).toBeDefined();
            expect(part!.fgColor.type).toBe('option');
            expect(part!.fgColor.name).toBe('emphasis');
        });

        // A combined \x19* control needs a separator; without one WeeChat consumes
        // the fixed payload but applies no style (gui-curses-window.c:765-880), and
        // attribute flags are only recognized in F/B/* payload positions.
        it('consumes a combined control without a separator and keeps the default color', () => {
            const result = rawText2Rich('\x19*03bold red\x1c');
            const part = result.find(p => p.text === 'bold red');
            expect(part).toBeDefined();
            expect(part!.fgColor.type).toBe('weechat');
            expect(part!.fgColor.name).toBe('default');
        });

        it('consumes attribute flags in a combined control that has no separator', () => {
            const result = rawText2Rich('\x19*!/03styled');
            const part = result.find(p => p.text === 'styled');
            expect(part).toBeDefined();
            expect(part!.attrs.override.r).toBe(false);
            expect(part!.attrs.override.i).toBe(false);
        });

        it('leaves an attribute flag outside a payload position as literal text', () => {
            const result = rawText2Rich('\x19%03blinking');
            const part = result.find(p => p.text === '%03blinking');
            expect(part).toBeDefined();
            expect(part!.attrs.override.k).toBe(false);
        });

        it('leaves a leading dot before a color code as literal text', () => {
            const result = rawText2Rich('\x19.04dimmed');
            const part = result.find(p => p.text === '.04dimmed');
            expect(part).toBeDefined();
            expect(part!.attrs.override.d).toBe(false);
        });

        it('parses extended color with attributes in the payload position', () => {
            // Upstream order is @, then attribute flags, then five digits.
            const result = rawText2Rich('\x19F@*00123ext bold');
            const part = result.find(p => p.text === 'ext bold');
            expect(part).toBeDefined();
            expect(part!.fgColor.type).toBe('ext');
            expect(part!.fgColor.name).toBe('123');
            expect(part!.attrs.override.b).toBe(true);
        });

        it('parses blink and dim flags on a two-digit foreground color', () => {
            const blink = rawText2Rich('\x19F%03blinking').find(p => p.text === 'blinking');
            expect(blink).toBeDefined();
            expect(blink!.fgColor.name).toBe('red');
            expect(blink!.attrs.override.k).toBe(true);

            const dim = rawText2Rich('\x19F.04dimmed').find(p => p.text === 'dimmed');
            expect(dim).toBeDefined();
            expect(dim!.fgColor.name).toBe('lightred');
            expect(dim!.attrs.override.d).toBe(true);
        });

        it('consumes an unrecognized control payload without styling', () => {
            const result = rawText2Rich('\x19*\x01@00123ext bold');
            const part = result.find(p => p.text === '00123ext bold');
            expect(part).toBeDefined();
            expect(part!.fgColor.name).toBe('default');
        });
    });

    describe('attribute codes (\\x1a / \\x1b)', () => {
        // Per WeeChat doc: \x1a sets attribute, \x1b removes attribute.
        // Both are followed by a raw byte:
        //   0x01: bold    0x02: reverse  0x03: italic
        //   0x04: underline  0x05: blink  0x06: dim

        it('sets bold attribute via \\x1a\\x01', () => {
            const result = rawText2Rich('\x1a\x01bold text');
            const boldPart = result.find(p => p.text === 'bold text');
            expect(boldPart).toBeDefined();
            expect(boldPart!.attrs.override.b).toBe(true);
        });

        it('sets reverse attribute via \\x1a\\x02', () => {
            const result = rawText2Rich('\x1a\x02reversed text');
            const part = result.find(p => p.text === 'reversed text');
            expect(part).toBeDefined();
            expect(part!.attrs.override.r).toBe(true);
        });

        it('sets italic attribute via \\x1a\\x03', () => {
            const result = rawText2Rich('\x1a\x03italic text');
            const italicPart = result.find(p => p.text === 'italic text');
            expect(italicPart).toBeDefined();
            expect(italicPart!.attrs.override.i).toBe(true);
        });

        it('sets underline attribute via \\x1a\\x04', () => {
            const result = rawText2Rich('\x1a\x04underlined text');
            const part = result.find(p => p.text === 'underlined text');
            expect(part).toBeDefined();
            expect(part!.attrs.override.u).toBe(true);
        });

        it('sets blink attribute via \\x1a\\x05', () => {
            const result = rawText2Rich('\x1a\x05blinking text');
            const part = result.find(p => p.text === 'blinking text');
            expect(part).toBeDefined();
        });

        it('sets dim attribute via \\x1a\\x06', () => {
            const result = rawText2Rich('\x1a\x06dimmed text');
            const part = result.find(p => p.text === 'dimmed text');
            expect(part).toBeDefined();
        });

        it('removes bold attribute via \\x1b\\x01', () => {
            const result = rawText2Rich('\x1a\x01bold\x1b\x01not bold');
            const notBoldPart = result.find(p => p.text === 'not bold');
            expect(notBoldPart).toBeDefined();
            expect(notBoldPart!.attrs.override.b).toBe(false);
        });

        it('removes italic attribute via \\x1b\\x03', () => {
            const result = rawText2Rich('\x1a\x03italic\x1b\x03not italic');
            const part = result.find(p => p.text === 'not italic');
            expect(part).toBeDefined();
            expect(part!.attrs.override.i).toBe(false);
        });

        it('accumulates multiple attributes via \\x1a', () => {
            // Set bold, then underline; both should be active
            const result = rawText2Rich('\x1a\x01\x1a\x04bold underlined');
            const part = result.find(p => p.text === 'bold underlined');
            expect(part).toBeDefined();
            expect(part!.attrs.override.b).toBe(true);
            expect(part!.attrs.override.u).toBe(true);
        });

        it('sets then removes attribute in sequence', () => {
            // \x1a\x01 sets bold, \x1b\x01 removes bold
            const result = rawText2Rich('\x1a\x01bold\x1b\x01normal');
            const normalPart = result.find(p => p.text === 'normal');
            expect(normalPart).toBeDefined();
            expect(normalPart!.attrs.override.b).toBe(false);
        });
    });

    describe('color reset (\\x1c)', () => {
        it('resets colors and attributes via \\x1c', () => {
            const result = rawText2Rich('\x1903red\x1cdefault color');
            const defaultPart = result.find(p => p.text === 'default color');
            expect(defaultPart).toBeDefined();
            expect(defaultPart!.fgColor.type).toBe('weechat');
            expect(defaultPart!.fgColor.name).toBe('default');
            expect(defaultPart!.bgColor.type).toBe('weechat');
            expect(defaultPart!.bgColor.name).toBe('default');
        });

        it('bare STD code resets attributes (old JS replaces curAttrs)', () => {
            // \x1a\x01 sets bold, then \x1904 (bare STD) replaces attrs entirely
            // Old JS bare STD matcher returns attrs with empty override → bold lost
            const result = rawText2Rich('\x1a\x01\x1904colored');
            const part = result.find(p => p.text === 'colored');
            expect(part).toBeDefined();
            expect(part!.fgColor.type).toBe('option');
            // Empty override obj means attrs are not active (undefined is falsy)
            expect(part!.attrs.override.b).toBeFalsy();
        });

        it('\\x1c resets both colors and attributes when not after \\x19', () => {
            const result = rawText2Rich('\x1a\x01bold\x1cnormal');
            const normalPart = result.find(p => p.text === 'normal');
            expect(normalPart).toBeDefined();
            expect(normalPart!.attrs.override.b).toBe(false);
            expect(normalPart!.fgColor.name).toBe('default');
        });
    });

    describe('date change messages', () => {
        it('handles date change prefix with box drawing chars', () => {
            // \x1943 = chat_day_change option color
            const result = rawText2Rich('\x1943\u2500\u2500\u2500\u2500\u2500');
            const boxPart = result.find(p => p.text.includes('\u2500'));
            expect(boxPart).toBeDefined();
            expect(boxPart!.fgColor.type).toBe('option');
            expect(boxPart!.fgColor.name).toBe('chat_day_change');
        });

        it('handles date text with day name and month', () => {
            const result = rawText2Rich('\x1900Monday, June 15, 2026');
            const textPart = result[0];
            expect(textPart!.text).toContain('Monday');
            expect(textPart!.text).toContain('June');
            expect(textPart!.text).toContain('2026');
        });
    });

    describe('IRC code conversion (\\x03, \\x02, etc → WeeChat format)', () => {
        // The conversion mirrors WeeChat's own IRC plugin, irc_color_decode()
        // (src/plugins/irc/irc-color.c:206-488): attribute toggles become the
        // control characters WeeChat's renderer understands, and colors are mapped
        // through WeeChat's IRC color table into custom-color controls that keep
        // the current attributes.
        describe('convertIrcCodes', () => {
            it('converts mIRC color \x0304 to the mapped WeeChat color', () => {
                // IRC 4 is lightred, which is WeeChat palette index 04.
                expect(convertIrcCodes('\x0304red')).toBe('\x19F|04red');
            });

            it('converts mIRC color with fg+bg \x0312,04 to one combined control', () => {
                expect(convertIrcCodes('\x0312,04text')).toBe('\x19*|10~04text');
            });

            it('converts bare \x03 to WeeChat resetcolor', () => {
                expect(convertIrcCodes('\x03text')).toBe('\x19\x1ctext');
            });

            it('converts the bug report pattern \x0328(Leaving\x03 to a terminal color', () => {
                // IRC 28 maps to terminal color 88 (irc-color.c:47), which WeeChat
                // writes as an extended payload with the attribute flags between
                // the @ and the digits.
                expect(convertIrcCodes('\x0328(Leaving\x03')).toBe('\x19F@|00088(Leaving\x19\x1c');
            });

            it('converts \x0327gbbot to a terminal color', () => {
                expect(convertIrcCodes('\x0327gbbot')).toBe('\x19F@|00089gbbot');
            });

            it('converts \x02 (bold) to WeeChat set-attribute bold', () => {
                expect(convertIrcCodes('\x02bold')).toBe('\x1a\x01bold');
            });

            it('converts a second \x02 to the matching remove-attribute control', () => {
                expect(convertIrcCodes('\x02bold\x02normal')).toBe('\x1a\x01bold\x1b\x01normal');
            });

            it('converts \x0f (reset) to WeeChat \x1c', () => {
                expect(convertIrcCodes('\x0freset')).toBe('\x1creset');
            });

            it('converts \x16 (reverse) to WeeChat set-attribute reverse', () => {
                expect(convertIrcCodes('\x16reverse')).toBe('\x1a\x02reverse');
            });

            it('converts \x1d (italic) to WeeChat set-attribute italic', () => {
                expect(convertIrcCodes('\x1ditalic')).toBe('\x1a\x03italic');
            });

            it('converts \x1f (underline) to WeeChat set-attribute underline', () => {
                expect(convertIrcCodes('\x1funderline')).toBe('\x1a\x04underline');
            });

            it('converts \x1e (strikethrough) to WeeChat dim, as the IRC plugin does', () => {
                expect(convertIrcCodes('\x1estrikethrough')).toBe('\x1a\x06strikethrough');
            });

            it('converts \x04 hex colors to the nearest terminal color', () => {
                // 0xff0000 is terminal color 9 exactly (gui_color_convert_rgb_to_term).
                expect(convertIrcCodes('\x04ff0000hex')).toBe('\x19F@|00009hex');
            });

            it('converts \x04 hex colors with a background into one combined control', () => {
                expect(convertIrcCodes('\x04000000,fffffftext')).toBe('\x19*@|00000~@00015text');
            });

            it('converts a truncated hex color using the digits that are present', () => {
                // irc_color_decode() reads up to six hex digits; `ff` becomes 0x0000ff,
                // which is terminal color 12 exactly (the base 16-color table entry).
                expect(convertIrcCodes('\x04ffshort')).toBe('\x19F@|00012short');
            });

            it('leaves a comma with no background digits as literal text', () => {
                // Same guard as irc_color_decode(): a comma only starts a background
                // when a digit follows it.
                expect(convertIrcCodes('\x0304,trailing')).toBe('\x19F|04,trailing');
            });

            it('converts multiple IRC codes in one string', () => {
                expect(convertIrcCodes('\x02bold\x03 normal')).toBe('\x1a\x01bold\x19\x1c normal');
            });

            it('leaves plain text unchanged', () => {
                expect(convertIrcCodes('hello world')).toBe('hello world');
            });

            it('leaves WeeChat control codes alone', () => {
                expect(convertIrcCodes('\x1903error\x1900')).toBe('\x1903error\x1900');
            });

            it('leaves WeeChat attribute controls alone', () => {
                expect(convertIrcCodes('\x1a\x01bold\x1b\x01plain')).toBe('\x1a\x01bold\x1b\x01plain');
            });
        });

        describe('rawText2Rich handles converted IRC codes', () => {
            it('handles \\x0328(Leaving\\x03 — digits consumed as out-of-range color', () => {
                const result = rawText2Rich('\x0328(Leaving\x03');
                expect(result[0]!.text).toBe('(Leaving');
            });

            it('handles \\x0327gbbot — digits consumed as out-of-range color', () => {
                const result = rawText2Rich('\x0327gbbot');
                expect(result[0]!.text).toBe('gbbot');
            });

            it('applies bold via \\x02 (converted to \\x1a*)', () => {
                const result = rawText2Rich('\x02bold text\x1c');
                const boldPart = result.find(p => p.text === 'bold text');
                expect(boldPart).toBeDefined();
                expect(boldPart!.attrs.override.b).toBe(true);
            });
        });
    });
});

describe('STD color code parity with old JS', () => {
    describe('out-of-range codes (> 16)', () => {
        it('consumes digits for code 28 instead of leaking them into text', () => {
            // Code 28 maps to option 'chat_host'
            const result = rawText2Rich('\x1928(Leaving\x1c');
            const part = result.find(p => p.text.includes('Leaving'));
            expect(part).toBeDefined();
            expect(part!.text).toBe('(Leaving');
        });

        it('consumes digits for code 27 instead of leaking them into text', () => {
            // Code 27 maps to option 'chat_delimiters'
            const result = rawText2Rich('\x1927gbbot');
            const part = result.find(p => p.text.includes('gbbot'));
            expect(part).toBeDefined();
            expect(part!.text).toBe('gbbot');
        });

        it('applies option color for valid out-of-range code (<=46)', () => {
            // Code 27 is valid option color 'chat_host'
            const result = rawText2Rich('\x1927colored');
            const coloredPart = result.find(p => p.text === 'colored');
            expect(coloredPart).toBeDefined();
            expect(coloredPart!.fgColor.type).toBe('option');
            expect(coloredPart!.fgColor.name).toBe('chat_host');
        });

        it('uses default color for truly out-of-range code (>46)', () => {
            const result = rawText2Rich('\x1947fallback');
            const fallbackPart = result.find(p => p.text === 'fallback');
            expect(fallbackPart).toBeDefined();
            expect(fallbackPart!.fgColor.type).toBe('weechat');
            expect(fallbackPart!.fgColor.name).toBe('default');
        });

        it('parses STD color code 44 (chat_value_null) as option type', () => {
            const result = rawText2Rich('\x1944nullvalue');
            const part = result.find(p => p.text === 'nullvalue');
            expect(part).toBeDefined();
            expect(part!.fgColor.type).toBe('option');
            expect(part!.fgColor.name).toBe('chat_value_null');
        });

        it('parses STD color code 46 (chat_status_enabled) as option type', () => {
            const result = rawText2Rich('\x1946status');
            const part = result.find(p => p.text === 'status');
            expect(part).toBeDefined();
            expect(part!.fgColor.type).toBe('option');
            expect(part!.fgColor.name).toBe('chat_status_enabled');
        });

        it('treats code 17 as invalid (gap between STD palette and options)', () => {
            const result = rawText2Rich('\x1917unstyled');
            const part = result.find(p => p.text === 'unstyled');
            expect(part).toBeDefined();
            expect(part!.fgColor.type).toBe('weechat');
            expect(part!.fgColor.name).toBe('default');
        });
    });

    describe('valid codes (0-16) — parity with old JS', () => {
        it('bare STD code sets both fgColor and bgColor to option type', () => {
            // Old JS: bare STD codes set fgColor=option, bgColor=clone of fgColor
            const result = rawText2Rich('\x1903red text\x1c');
            const redPart = result.find(p => p.text === 'red text');
            expect(redPart).toBeDefined();
            expect(redPart!.fgColor.type).toBe('option');
            expect(redPart!.bgColor.type).toBe('option');
            expect(redPart!.bgColor.name).toBe('chat_time_delimiters');
        });

        it('sets attrs.name to option name for STD color', () => {
            const result = rawText2Rich('\x1905named style\x1c');
            const part = result.find(p => p.text === 'named style');
            expect(part).toBeDefined();
            expect(part!.attrs.name).toBe('chat_prefix_network');
        });

        it('maps all 17 STD palette indices to correct option names', () => {
            // Bare STD codes map to colorsOptionsNames indices (option type)
            const expectedNames = [
                'separator', 'chat', 'chat_time', 'chat_time_delimiters',
                'chat_prefix_error', 'chat_prefix_network', 'chat_prefix_action',
                'chat_prefix_join', 'chat_prefix_quit', 'chat_prefix_more',
                'chat_prefix_suffix', 'chat_buffer', 'chat_server', 'chat_channel',
                'chat_nick', 'chat_nick_self', 'chat_nick_other'
            ];
            for (let i = 0; i <= 16; i++) {
                const code = String(i).padStart(2, '0');
                const result = rawText2Rich(`\x19${code}text`);
                const part = result.find(p => p.text === 'text');
                expect(part!.fgColor.type).toBe('option');
                expect(part!.fgColor.name).toBe(expectedNames[i]);
            }
        });
    });
});

describe('mixed content', () => {
    it('handles text with multiple style changes', () => {
        const result = rawText2Rich('\x1903red\x1900normal\x1902green');
        expect(result.length).toBeGreaterThan(1);
    });

    it('preserves unicode characters in styled text', () => {
        const result = rawText2Rich('\x1904\u2764\u2764\u2764');
        const heartPart = result.find(p => p.text.includes('\u2764'));
        expect(heartPart).toBeDefined();
    });

    it('combines color codes and attribute codes in sequence', () => {
        // \x1a\x01 sets bold, then \x1904 (bare STD) replaces attrs entirely → bold lost
        // \x1b\x01 removes bold, \x1c resets all
        const result = rawText2Rich('\x1a\x01\x1904bold red\x1b\x01just red\x1cnormal');
        expect(result).toHaveLength(3);
        expect(result[0]!.text).toBe('bold red');
        // Bare STD code \x1904 replaces curAttrs → bold is lost
        expect(result[0]!.fgColor.type).toBe('option');
        expect(result[0]!.attrs.override.b).toBeFalsy();
        expect(result[1]!.text).toBe('just red');
        expect(result[1]!.attrs.override.b).toBeFalsy();
        expect(result[2]!.text).toBe('normal');
        expect(result[2]!.fgColor.name).toBe('default');
    });
});

// --- richText2Str round-trip tests ---

describe('Protocol richText2Str conversion', () => {
    it('converts RichPart array back to WeeChat format string', () => {
        const parts = rawText2Rich('\x1903colored\x1900 normal');
        const result = richText2Str(parts);
        expect(typeof result).toBe('string');
    });

    it('handles plain text through richText2Str', () => {
        const parts = rawText2Rich('plain text');
        const result = richText2Str(parts);
        expect(typeof result).toBe('string');
    });
});

// --- Backward compatibility tests ---

describe('Protocol class backward compatibility', () => {
    describe('static method wrappers', () => {
        it('Protocol.formatHandshake works as static method', () => {
            const result = Protocol.formatHandshake({
                password_hash_algo: 'plain',
                compression: 'off'
            });
            expect(result).toContain('handshake');
            expect(result).toContain('password_hash_algo=plain');
        });

        it('Protocol.rawText2Rich works as static method', () => {
            const result = Protocol.rawText2Rich('\x1903red text');
            expect(Array.isArray(result)).toBe(true);
            expect(result.some(p => p.text === 'red text')).toBe(true);
        });

        it('Protocol.formatInput produces correct input command', () => {
            const result = Protocol.formatInput({
                buffer: '0x12345',
                data: '/nick newnick'
            });
            expect(result).toMatch(/^input 0x12345 /);
            expect(result).toContain('/nick newnick');
        });

        it('Protocol.formatQuit produces quit command', () => {
            const result = Protocol.formatQuit();
            expect(result).toBe('quit\n');
        });

        it('Protocol.formatInfo produces version request', () => {
            const result = Protocol.formatInfo({ name: 'version' });
            expect(result).toBe('info version\n');
        });

        it('Protocol.formatSync produces sync command', () => {
            const result = Protocol.formatSync({});
            expect(result).toBe('sync\n');
        });
    });

    describe('instance methods', () => {
        it('protocol.setId formats command with ID prefix', () => {
            const protocol = new Protocol();
            const result = protocol.setId(42, 'handshake');
            expect(result).toBe('(42) handshake');
        });

        it('protocol.setId with different IDs', () => {
            const protocol = new Protocol();
            expect(protocol.setId(1, 'cmd1')).toBe('(1) cmd1');
            expect(protocol.setId(999, 'cmd2')).toBe('(999) cmd2');
        });
    });
});
