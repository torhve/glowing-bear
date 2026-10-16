import { describe, it, expect } from 'vitest';
import { trimBufferLines } from '#lib/api/api-store-reducers.ts';
import { createBuffer, createBufferLine, historyPageSize } from '#lib/stores/models.ts';
import type { BufferData } from '#lib/types.ts';

/**
 * `requestedLines` is a record of what this session ASKED the server for.
 *
 * It is not a line count, and the trim must not treat it as one. Two consumers
 * read it as a request cursor: the scroll-up page size (`requestedLines * 2`) and
 * the legacy re-fetch gate (`requestedLines < 100`). Subtracting the trimmed lines
 * made a capped buffer's counter cancel toward zero during an ordinary flood —
 * observed at -14 and -40 — which both re-opened the gate forever (301 identical
 * `lines=-100` requests in one run) and reduced the scroll-up page to `lines=0`,
 * a request the relay answers with an empty array.
 */

function bufferWith(count: number): BufferData {
    const buffer = createBuffer({
        pointers: ['1001'], full_name: 'irc.server.#chan', short_name: '#chan', number: 1,
        local_variables: { type: 'channel' },
    });
    buffer.lines = Array.from({ length: count }, (_, id) => createBufferLine({
        buffer: '1001', date: 1_700_000_000 + id, prefix: 'nick', message: `msg ${id}`,
        tags_array: ['irc_privmsg'], displayed: 1, highlight: 0, id,
    }));
    return buffer;
}

describe('requestedLines survives the memory trim', () => {
    it('does not subtract the lines the trim dropped', () => {
        const buffer = bufferWith(200);
        buffer.requestedLines = 200;
        trimBufferLines(buffer, 150);
        expect(buffer.lines).toHaveLength(150);
        expect(buffer.requestedLines, 'the session still asked for 200 lines').toBe(200);
    });

    it('keeps a small request cursor intact', () => {
        const buffer = bufferWith(200);
        buffer.requestedLines = 10;
        trimBufferLines(buffer, 150);
        expect(buffer.requestedLines, 'a trim is not evidence that fewer lines were requested').toBe(10);
    });

    it('never drives the counter negative, whichever path produced it', () => {
        // The legacy pass still subtracts per trim, so a counter can arrive here
        // already negative. The floor is what makes `requestedLines * 2` usable.
        const buffer = bufferWith(200);
        buffer.requestedLines = -40;
        trimBufferLines(buffer, 150);
        expect(buffer.requestedLines).toBe(0);
        expect(buffer.requestedLines * 2, 'a zero-sized page is a request that returns nothing').toBeGreaterThanOrEqual(0);
    });

    it('leaves the oldest lines as the ones being dropped', () => {
        const buffer = bufferWith(5);
        buffer.requestedLines = 5;
        trimBufferLines(buffer, 3);
        expect(buffer.lines.map((l) => l.text)).toEqual(['msg 2', 'msg 3', 'msg 4']);
    });
});

/**
 * The cursor may legitimately reach zero, so the page size must not.
 *
 * setActiveBuffer trims the buffer being switched to when it holds more lines
 * than the current cap, and subtracts from the cursor along with the window —
 * readmarker.test.ts locks that, and on this transport it is consistent because
 * every received line increments the cursor. The consequence is that a cursor can
 * arrive at 0 (a retained handoff starts one), and `last_line(-0)` is answered
 * with an empty array that looks exactly like "no older history exists".
 */
describe('a history page is sized to the window the buffer may retain', () => {
    it('asks for the whole cap, not an increment', () => {
        // Both relays answer a lines request as "the newest N lines" and neither
        // can be asked for lines older than what is held, so an increment-sized
        // page re-delivers lines the buffer already has. The bound on this number
        // is the buffer's cap, which growHistoryLimit raises page by page.
        expect(historyPageSize(0, 200)).toBe(200);
    });

    it('honours a larger explicit request', () => {
        expect(historyPageSize(500, 10)).toBe(500);
    });

    it('never asks for a page of zero', () => {
        expect(historyPageSize(0, 0)).toBe(100);
    });

    it('never asks for a negative page either', () => {
        // A cursor subtracted below zero by repeated activation trims.
        expect(historyPageSize(0, -140)).toBe(100);
    });
});
