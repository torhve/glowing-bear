import { describe, it, expect } from 'vitest';
import { Protocol, rawText2Rich, richText2Str, convertIrcCodes } from '$lib/weechat';

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
        it('parses STD color code 43 (out of range) as default color', () => {
            // Code 43 > 16 is out of range for STD colors, returns default
            const result = rawText2Rich('\x1943\u2500\u2500\u2500');
            expect(result.some((p) => p.text.includes('\u2500'))).toBe(true);
            expect(result.find((p) => p.text.includes('\u2500'))!.fgColor.type).toBe('weechat');
        });

        it('parses STD color code 03 (light red) with text', () => {
            const result = rawText2Rich('\x1903error\x1900');
            const errorPart = result.find(p => p.text === 'error');
            expect(errorPart).toBeDefined();
            expect(errorPart!.fgColor.type).toBe('option');
        });

       it('leaves extended color code @12345 unhandled (matches original AngularJS)', () => {
            // Original AngularJS explicitly returns null for EXT colors/attrs (unimplemented case)
            // So the part keeps the previous/initial values
            const result = rawText2Rich('\x19@12345colored text');
            const coloredPart = result.find(p => p.text === 'colored text');
            expect(coloredPart!.fgColor.type).toBe('weechat');
            expect(coloredPart!.fgColor.name).toBe('default');
            expect(coloredPart!.bgColor.type).toBe('weechat');
            expect(coloredPart!.bgColor.name).toBe('default');
            expect(coloredPart!.attrs.name).toBeNull();
            expect(Object.keys(coloredPart!.attrs.override).length).toBe(0);
            expect(coloredPart!.text).toBe('colored text');
        });

        it('parses foreground color F format', () => {
            const result = rawText2Rich('\x19F03red text');
            const redPart = result.find(p => p.text === 'red text');
            expect(redPart).toBeDefined();
            expect(redPart!.fgColor.type).toBe('weechat');
        });

        it('parses foreground+background with * format', () => {
            const result = rawText2Rich('\x19*03,07highlighted');
            const part = result.find(p => p.text === 'highlighted');
            expect(part).toBeDefined();
        });
    });

    describe('attribute codes (\\x1a / \\x1b)', () => {
        it('sets bold attribute via \\x1a*', () => {
            const result = rawText2Rich('\x1a*bold text');
            const boldPart = result.find(p => p.text === 'bold text');
            expect(boldPart).toBeDefined();
            expect(boldPart!.attrs.override.b).toBe(true);
        });

        it('sets italic attribute via \\x1a/', () => {
            const result = rawText2Rich('\x1a/italic text');
            const italicPart = result.find(p => p.text === 'italic text');
            expect(italicPart).toBeDefined();
            expect(italicPart!.attrs.override.i).toBe(true);
        });

        it('resets attributes via \\x1b', () => {
            const result = rawText2Rich('\x1a*bold\x1b/unbold');
            const unboldPart = result.find(p => p.text === 'unbold');
            expect(unboldPart).toBeDefined();
            expect(unboldPart!.attrs.override.i).toBe(false);
        });
    });

    describe('color reset (\\x1c)', () => {
        it('resets colors via \\x1c', () => {
            const result = rawText2Rich('\x1903red\x1cdefault color');
            const defaultPart = result.find(p => p.text === 'default color');
            expect(defaultPart).toBeDefined();
            expect(defaultPart!.fgColor.type).toBe('weechat');
            expect(defaultPart!.fgColor.name).toBe('default');
        });
    });

    describe('date change messages', () => {
        it('handles date change prefix with box drawing chars', () => {
            const result = rawText2Rich('\x1943\u2500\u2500\u2500\u2500\u2500');
            const boxPart = result.find(p => p.text.includes('\u2500'));
            expect(boxPart).toBeDefined();
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
    describe('convertIrcCodes', () => {
        it('converts mIRC color \\x0304 to WeeChat \\x1904', () => {
            expect(convertIrcCodes('\x0304red')).toBe('\x1904red');
        });

        it('converts mIRC color with fg+bg \\x0312,04 to \\x19*12,04', () => {
            expect(convertIrcCodes('\x0312,04text')).toBe('\x19*12,04text');
        });

        it('converts bare \\x03 to WeeChat reset \\x1c', () => {
            expect(convertIrcCodes('\x03text')).toBe('\x1ctext');
        });

        it('converts the bug report pattern \\x0328(Leaving\\x03 to \\x1928(Leaving\\x1c', () => {
            expect(convertIrcCodes('\x0328(Leaving\x03')).toBe('\x1928(Leaving\x1c');
        });

        it('converts \\x0327gbbot to \\x1927gbbot', () => {
            expect(convertIrcCodes('\x0327gbbot')).toBe('\x1927gbbot');
        });

        it('converts \\x02 (bold) to WeeChat \\x1a*', () => {
            expect(convertIrcCodes('\x02bold')).toBe('\x1a*bold');
        });

        it('converts \\x0f (reset) to WeeChat \\x1c', () => {
            expect(convertIrcCodes('\x0freset')).toBe('\x1creset');
        });

        it('converts \\x16 (reverse) to WeeChat \\x1a!', () => {
            expect(convertIrcCodes('\x16reverse')).toBe('\x1a!reverse');
        });

        it('converts \\x1d (italic) to WeeChat \\x1a/', () => {
            expect(convertIrcCodes('\x1ditalic')).toBe('\x1a/italic');
        });

        it('converts \\x1f (underline) to WeeChat \\x1a_', () => {
            expect(convertIrcCodes('\x1funderline')).toBe('\x1a_underline');
        });

        it('converts multiple IRC codes in one string', () => {
            expect(convertIrcCodes('\x02bold\x03 normal')).toBe('\x1a*bold\x1c normal');
        });

        it('leaves plain text unchanged', () => {
            expect(convertIrcCodes('hello world')).toBe('hello world');
        });

        it('leaves WeeChat control codes alone', () => {
            expect(convertIrcCodes('\x1903error\x1900')).toBe('\x1903error\x1900');
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

describe('STD color code parity with old JS', () => {
    describe('out-of-range codes (> 16)', () => {
        it('consumes digits for code 28 instead of leaking them into text', () => {
            // This is the root cause fix for the "28(Leaving" bug
            const result = rawText2Rich('\x1928(Leaving\x1c');
            const part = result.find(p => p.text.includes('Leaving'));
            expect(part).toBeDefined();
            expect(part!.text).toBe('(Leaving');
        });

        it('consumes digits for code 27 instead of leaking them into text', () => {
            const result = rawText2Rich('\x1927gbbot');
            const part = result.find(p => p.text.includes('gbbot'));
            expect(part).toBeDefined();
            expect(part!.text).toBe('gbbot');
        });

        it('does not apply color for out-of-range code (uses default)', () => {
            const result = rawText2Rich('\x1928colored');
            const coloredPart = result.find(p => p.text === 'colored');
            expect(coloredPart).toBeDefined();
            expect(coloredPart!.fgColor.type).toBe('weechat');
            expect(coloredPart!.fgColor.name).toBe('default');
        });
    });

    describe('valid codes (0-16) — parity with old JS', () => {
        it('does not change bgColor for STD color (only foreground)', () => {
            const result = rawText2Rich('\x1903red text\x1c');
            const redPart = result.find(p => p.text === 'red text');
            expect(redPart).toBeDefined();
            // STD colors only change foreground; background stays default
            expect(redPart!.bgColor.type).toBe('weechat');
            expect(redPart!.bgColor.name).toBe('default');
        });

        it('sets attrs.name to option name for STD color (old JS sets name)', () => {
            const result = rawText2Rich('\x1905named style\x1c');
            const part = result.find(p => p.text === 'named style');
            expect(part).toBeDefined();
            expect(part!.attrs.name).toBe('chat_prefix_network');
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
