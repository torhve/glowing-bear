import { describe, expect, it } from 'vitest';
import { parseLegacyCompletion } from '#lib/stores/legacyConnection.ts';
import type { ProtocolMessage } from '#lib/types.ts';

/**
 * The legacy relay's completion record.
 *
 * Every shape below is a live reply captured from gbtest's WeeChat 4.10.1 legacy
 * relay; the parser is what turns that record into a replacement the composer can
 * apply, so the offsets are the part that matters.
 */

function reply(record: Record<string, unknown>): ProtocolMessage {
    return {
        id: '13',
        objects: [{ pointer: '7920fdea0', content: [record] }],
    } as unknown as ProtocolMessage;
}

describe('parseLegacyCompletion', () => {
    it('reads a custom command completion, including the span to replace', () => {
        // `completion 0x… 6 /zzzgb` on a buffer where /zzzgb is a user alias.
        const parsed = parseLegacyCompletion(reply({
            context: 'command',
            base_word: 'zzzgb',
            pos_start: 1,
            pos_end: 5,
            add_space: 1,
            list: ['zzzgb'],
        }));
        expect(parsed).toEqual({
            candidates: ['zzzgb'],
            addSpace: true,
            replaceStart: 1,
            // pos_end names the LAST character to replace, so the span ends after it.
            replaceEnd: 6,
        });
    });

    it('keeps several candidates in the order WeeChat sent them', () => {
        const parsed = parseLegacyCompletion(reply({
            context: 'command',
            base_word: 'zzz',
            pos_start: 1,
            pos_end: 3,
            add_space: 1,
            list: ['zzzgb', 'zzzother'],
        }));
        expect(parsed?.candidates).toEqual(['zzzgb', 'zzzother']);
    });

    it('reports no space when the relay says the word stands alone', () => {
        const parsed = parseLegacyCompletion(reply({
            context: 'command_arg',
            base_word: 'fi',
            pos_start: 6,
            pos_end: 7,
            add_space: 0,
            list: ['fifo', 'filter'],
        }));
        expect(parsed?.addSpace).toBe(false);
        expect(parsed?.replaceStart).toBe(6);
        expect(parsed?.replaceEnd).toBe(8);
    });

    it('reports nothing when WeeChat found nothing to complete', () => {
        expect(parseLegacyCompletion(reply({
            context: 'auto',
            base_word: '/zzzgb',
            pos_start: 0,
            pos_end: 5,
            add_space: 0,
            list: [],
        }))).toBeNull();
    });

    it('reports nothing for the empty hdata an unknown buffer answers with', () => {
        const empty = { id: '13', objects: [{ pointer: '', content: [] }] } as unknown as ProtocolMessage;
        expect(parseLegacyCompletion(empty)).toBeNull();
    });

    it('rejects a record whose replacement span is not usable', () => {
        expect(parseLegacyCompletion(reply({
            context: 'command', base_word: 'x', add_space: 1, list: ['x'],
        }))).toBeNull();
        expect(parseLegacyCompletion(reply({
            context: 'command', base_word: 'x', pos_start: 4, pos_end: 2, add_space: 1, list: ['x'],
        }))).toBeNull();
    });
});
