import { describe, it, expect } from 'vitest';
import { bufferNamePrefix, bufferServerSortKey, isPinnedBuffer, trimmedBufferName } from '#lib/bufferNaming.ts';

/**
 * What a buffer is called, and what it sorts under.
 *
 * These four derivations were written five times across the three events that
 * describe a buffer, so the sidebar could label a row from the event that created
 * it and re-sort it from the event that revised it. The rules the copies agreed
 * on are here, including the two that look like typos and are not.
 */

describe('the label beside the sigil', () => {
    it('keeps the sigil out of the name and in its own column', () => {
        expect(trimmedBufferName('#glowing-bear')).toBe('glowing-bear');
        expect(bufferNamePrefix('#glowing-bear')).toBe('#');
        expect(trimmedBufferName('&server')).toBe('server');
        expect(bufferNamePrefix('&server')).toBe('&');
        expect(trimmedBufferName('+status')).toBe('status');
        expect(bufferNamePrefix('+status')).toBe('+');
    });

    it('leaves a name with no sigil untouched and prefixes nothing', () => {
        expect(trimmedBufferName('testuser')).toBe('testuser');
        expect(bufferNamePrefix('testuser')).toBe('');
    });

    it('still labels a name that is only a sigil', () => {
        // Trimming to '' would render an empty row, so the row gets a space.
        expect(trimmedBufferName('#')).toBe(' ');
        expect(bufferNamePrefix('#')).toBe('#');
    });

    it('has no label at all for a buffer with no name', () => {
        expect(trimmedBufferName('')).toBeNull();
        expect(bufferNamePrefix('')).toBe('');
    });
});

describe('the key a buffer sorts under', () => {
    it('groups a channel under its server and name', () => {
        expect(bufferServerSortKey('irc', 'glowing-bear', 'channel', '#glowing-bear'))
            .toBe('irc.glowing-bear.#glowing-bear');
    });

    it('groups a server buffer by server alone, with no dangling dot', () => {
        expect(bufferServerSortKey('irc', 'glowing-bear', 'server', 'glowing-bear'))
            .toBe('irc.glowing-bear');
    });

    it('groups regardless of how the relay capitalised the names', () => {
        expect(bufferServerSortKey('IRC', 'Glowing-Bear', 'channel', '#Glowing-Bear'))
            .toBe('irc.glowing-bear.#glowing-bear');
    });
});

describe('the pinned flag', () => {
    it('is the string WeeChat sends, not a boolean', () => {
        expect(isPinnedBuffer({ pinned: 'true' })).toBe(true);
        expect(isPinnedBuffer({ pinned: '1' })).toBe(false);
        expect(isPinnedBuffer({ pinned: '' })).toBe(false);
        expect(isPinnedBuffer(undefined)).toBe(false);
    });
});
