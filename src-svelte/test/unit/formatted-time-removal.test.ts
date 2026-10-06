import { describe, expect, it } from 'vitest';
import { createBufferLine } from '#lib/stores/models.ts';

/**
 * Direct equivalence guard for removing `BufferLine.formattedTime`.
 *
 * The field was written per line (`date.toLocaleTimeString()`, ~627 ns/call,
 * about 13% of the cost of building a line) and read nowhere in the app, its
 * tests or its E2E specs. Removing it is the one optimisation in this campaign
 * that changes an object shape rather than only how a value is produced, so it
 * gets a shape test instead of relying on the benchmark output hashes alone:
 * the benchmark snapshots no longer contain the field, so they cannot prove it
 * was the only thing that disappeared.
 */

/** The exact key set `createBufferLine` returned before the field was removed. */
const BASELINE_KEYS = [
    'prefix',
    'content',
    'date',
    'shortTime',
    'formattedTime',
    'buffer',
    'tags',
    'highlight',
    'displayed',
    'prefixtext',
    'text',
    'showHiddenBrackets',
    'lineId',
    'notifyLevel',
    'isUserMessage',
    'isDateSeparator',
] as const;

const MESSAGES = [
    {
        buffer: '0x100',
        date: 1735689600000, // 2025-01-01T00:00:00Z
        prefix: '<\u0019F02nick> ',
        message: '\u0019D03hello \u001a\u0001world\u001b\u0001',
        tags_array: ['irc_privmsg', 'irc_channel'],
        displayed: 1,
        notify_level: 1,
        highlight: 0,
        id: 42,
        bufferType: 'channel' as const,
    },
    {
        buffer: '0x200',
        date: 1751328000000, // 2025-06-30T16:00:00Z, Europe/Oslo summer time
        prefix: '',
        message: 'plain text, no controls',
        tags_array: ['notify_private'],
        displayed: 1,
        notify_level: 2,
        highlight: 1,
        bufferType: 'private' as const,
    },
    {
        buffer: '0x300',
        date: 0,
        prefix: '-- 2025/01/01 00:00:00',
        message: 'core buffer line',
        tags_array: [],
        displayed: 0,
        highlight: 0,
        bufferType: 'weechat' as const,
    },
];

describe('removing BufferLine.formattedTime', () => {
    it('keeps every other key of the produced line, in the same order', () => {
        for (const message of MESSAGES) {
            const keys = Object.keys(createBufferLine(message));
            expect(keys).toEqual(BASELINE_KEYS.filter((key) => key !== 'formattedTime'));
        }
    });

    it('no longer reports the field as present', () => {
        for (const message of MESSAGES) {
            expect('formattedTime' in createBufferLine(message)).toBe(false);
        }
    });

    it('leaves the remaining values exactly as the old expression produced them', () => {
        for (const message of MESSAGES) {
            const line = createBufferLine(message);
            const date = new Date(message.date);
            const time = date.getTime();

            // Recomputed independently of the production helpers.
            expect(line.date).toBe(time);
            expect(line.buffer).toBe(message.buffer);
            expect(line.tags).toEqual(message.tags_array);
            expect(line.highlight).toBe(!!message.highlight);
            expect(line.displayed).toBe(!!message.displayed);
            expect(line.isDateSeparator).toBe(false);
            expect(line.notifyLevel).toBe(message.notify_level ?? 0);
            expect(line.text).toBe(line.content.map((c) => c.text).join(''));
            expect(line.prefixtext).toBe(line.prefix.map((p) => p.text).join(''));
            expect(line.lineId).toBe(
                message.id !== undefined
                    ? `weechat:${String(message.id)}`
                    : `line:${message.buffer}:${message.date}:${message.prefix}:${message.message}:${message.tags_array.join(',')}`,
            );

            // The HH:MM field the app actually renders, checked against the
            // original per-call Intl expression rather than formatShortTime().
            expect(line.shortTime).toBe(
                date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
            );

            // The removed field's old value, for the record: it was the system
            // locale's full time, and nothing consumed it.
            expect(date.toLocaleTimeString()).toBeTypeOf('string');
        }
    });
});
