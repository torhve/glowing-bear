import { describe, it, expect } from 'vitest';
import { insertHistoryLines } from '#lib/api/api-features.ts';
import { trimBufferLines } from '#lib/api/api-store-reducers.ts';
import { createBuffer, createBufferLine } from '#lib/stores/models.ts';
import type { BufferData, BufferLine } from '#lib/types.ts';

/**
 * Where a fetched history window lands.
 *
 * `applyHistory` used to prepend unconditionally, which is correct only while the
 * fetched window is older than everything the buffer holds. After a retained
 * handoff the held window is the transcript as of the outage and the newest-N
 * window is *newer than its tail* — prepending put the recovered lines at the
 * front, and the memory trim drops the front, so the fetch deleted exactly what
 * it had just recovered. These lock the positional rule and, with it, the
 * interaction with the trim.
 */

function bufferWith(ids: number[]): BufferData {
    const buffer = createBuffer({
        pointers: ['1001'], full_name: 'irc.server.#chan', short_name: '#chan', number: 1,
        local_variables: { type: 'channel' },
    });
    buffer.lines = ids.map((id) => line(id));
    return buffer;
}

function line(id: number, text?: string): BufferLine {
    return createBufferLine({
        buffer: '1001', date: 1_700_000_000 + id, prefix: 'nick',
        message: text ?? `msg ${id}`, tags_array: ['irc_privmsg'],
        displayed: 1, highlight: 0, id,
    });
}

function ids(buffer: BufferData): number[] {
    return buffer.lines.map((l) => Number((l.lineId ?? '').replace('weechat:', '')));
}

describe('history window placement', () => {
    it('prepends a window older than everything held, leaving held lines untouched', () => {
        const buffer = bufferWith([10, 11, 12]);
        insertHistoryLines(buffer, [line(7), line(8), line(9)]);
        expect(ids(buffer)).toEqual([7, 8, 9, 10, 11, 12]);
    });

    it('appends a window newer than the held tail — the retained-handoff case', () => {
        // The buffer holds last night's window; the relay's newest window is today.
        const buffer = bufferWith([100, 101, 102]);
        insertHistoryLines(buffer, [line(103), line(104)]);
        expect(ids(buffer)).toEqual([100, 101, 102, 103, 104]);
    });

    it('survives the memory trim when the recovered window is the newest one', () => {
        // This is the actual defect: 200 held + 40 recovered, cap 200. Prepending
        // put the 40 at index 0 and the trim removed them. Appending puts the
        // oldest lines at index 0, which is what the trim is for.
        const buffer = bufferWith(Array.from({ length: 10 }, (_, i) => 100 + i));
        insertHistoryLines(buffer, Array.from({ length: 4 }, (_, i) => line(110 + i)));
        trimBufferLines(buffer, 10);
        expect(buffer.lines).toHaveLength(10);
        expect(ids(buffer), 'the trim must drop the oldest, never the recovered tail')
            .toEqual([104, 105, 106, 107, 108, 109, 110, 111, 112, 113]);
    });

    it('interleaves a window that straddles the held range', () => {
        const buffer = bufferWith([10, 20]);
        insertHistoryLines(buffer, [line(5), line(15), line(25)]);
        expect(ids(buffer)).toEqual([5, 10, 15, 20, 25]);
    });

    it('never reorders or rebuilds held lines, so a correct transcript is untouched', () => {
        const buffer = bufferWith([10, 11, 12]);
        const before = buffer.lines;
        insertHistoryLines(buffer, [line(8), line(9)]);
        expect(ids(buffer)).toEqual([8, 9, 10, 11, 12]);
        expect(buffer.lines[2]).toBe(before[0], 'held line objects are reused, not rebuilt');
        expect(buffer.lines[4]).toBe(before[2]);
    });
    it('falls back to prepending when the fetched window carries no server id', () => {
        const buffer = bufferWith([10, 11]);
        const unnumbered = createBufferLine({
            buffer: '1001', date: 1_700_000_000, prefix: 'nick', message: 'no id',
            tags_array: ['irc_privmsg'], displayed: 1, highlight: 0,
        });
        insertHistoryLines(buffer, [unnumbered]);
        expect(buffer.lines[0]!.text).toBe('no id');
        expect(ids(buffer).slice(1)).toEqual([10, 11]);
    });
});
