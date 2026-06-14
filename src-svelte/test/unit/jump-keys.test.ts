import { describe, it, expect } from 'vitest';
import { computeJumpKeys } from '$lib/utils';
import type { BufferData } from '$lib/types';

function makeBuffer(id: string, num: number): BufferData {
    return {
        id,
        fullName: '#' + num,
        shortName: '#' + num,
        hidden: false,
        trimmedName: null,
        nameClasses: [],
        prefix: '',
        number: num,
        title: [],
        rtitle: '#' + num,
        lines: [],
        requestedLines: 0,
        allLinesFetched: true,
        unread: 0,
        notification: 0,
        notify: 0,
        nicklist: {},
        serverSortKey: '',
        indent: false,
        bufferType: 0,
        type: 'channel',
        plugin: '',
        server: '',
        hideBufferLineTimes: false,
        pinned: false,
        active: false,
    } as unknown as BufferData;
}

describe('computeJumpKeys', () => {
    it('assigns sequential jump keys starting from 1', () => {
        const bufs = [makeBuffer('buf1', 1), makeBuffer('buf2', 2), makeBuffer('buf3', 3)];
        const result = computeJumpKeys(bufs);
        expect(result[0].$jumpKey).toBe('1');
        expect(result[1].$jumpKey).toBe('2');
        expect(result[2].$jumpKey).toBe('3');
    });

    it('sorts by buffer number before assigning keys', () => {
        const bufs = [makeBuffer('buf3', 3), makeBuffer('buf1', 1), makeBuffer('buf2', 2)];
        const result = computeJumpKeys(bufs);
        // buf1 (number=1) should get key '1'
        // buf2 (number=2) should get key '2'
        // buf3 (number=3) should get key '3'
        expect(result.find(b => b.id === 'buf1')?.$jumpKey).toBe('1');
        expect(result.find(b => b.id === 'buf2')?.$jumpKey).toBe('2');
        expect(result.find(b => b.id === 'buf3')?.$jumpKey).toBe('3');
    });

    it('skips buffers that already have a $jumpKey assigned', () => {
        const bufs = [
            { ...makeBuffer('buf1', 1), $jumpKey: '99' },
            makeBuffer('buf2', 2),
            makeBuffer('buf3', 3),
        ];
        const result = computeJumpKeys(bufs as BufferData[]);
        expect(result.find(b => b.id === 'buf1')?.$jumpKey).toBe('99');
        // buf2 and buf3 should still get sequential keys
        expect(result.find(b => b.id === 'buf2')?.$jumpKey).toBe('2');
        expect(result.find(b => b.id === 'buf3')?.$jumpKey).toBe('3');
    });

    it('limits jump keys to 99', () => {
        const bufs = Array.from({ length: 105 }, (_, i) => makeBuffer('buf' + i, i + 1));
        const result = computeJumpKeys(bufs);
        // First 99 should have keys, rest should be undefined (not assigned)
        for (let i = 0; i < 99; i++) {
            expect(result[i].$jumpKey).toBe(String(i + 1));
        }
        for (let i = 99; i < 105; i++) {
            expect(result[i].$jumpKey).toBeUndefined();
        }
    });

    it('returns empty array for no buffers', () => {
        const result = computeJumpKeys([]);
        expect(result).toEqual([]);
    });

    it('skips hidden buffers when assigning keys', () => {
        const bufs = [
            makeBuffer('buf1', 1),
            { ...makeBuffer('buf2', 2), hidden: true },
            makeBuffer('buf3', 3),
        ];
        const result = computeJumpKeys(bufs);
        // buf1 gets key '1', buf2 is hidden so skipped, buf3 gets key '2'
        expect(result.find(b => b.id === 'buf1')?.$jumpKey).toBe('1');
        expect(result.find(b => b.id === 'buf2')?.$jumpKey).toBeUndefined();
        expect(result.find(b => b.id === 'buf3')?.$jumpKey).toBe('2');
    });
});
