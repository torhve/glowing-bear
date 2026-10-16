import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import {
    buffers, createBuffer, createBufferLine, lineLimitFor, growHistoryLimit,
    historyPageSize, initialHistoryWindow, maxBufferLines, linesPerScreen, setActiveBuffer,
} from '#lib/stores/models.ts';
import { handleBufferCleared } from '#lib/stores/handlers.ts';
import { trimBufferLines } from '#lib/api/api-store-reducers.ts';
import type { BufferData, ProtocolMessage } from '#lib/types.ts';

/**
 * Scrollback depth follows what the reader asked for.
 *
 * A buffer holds the screen-derived cap until the reader pages upward, and each
 * deliberate page raises that buffer's own cap toward a ceiling. The cap is
 * retention permission, not allocation, so raising it is free until lines
 * actually arrive — which is what lets a page be sized as the whole window the
 * buffer may now retain. Both relays answer a lines request as "the newest N
 * lines" and neither can be asked for lines older than what is held, so a page
 * smaller than the window re-delivers lines the buffer already has.
 */

const ID = '1001';

function bufferWith(count: number, overrides: Partial<BufferData> = {}): BufferData {
    const buffer = createBuffer({
        pointers: [ID], full_name: 'irc.gbtest.#chan', short_name: '#chan', number: 1,
        local_variables: { type: 'channel' },
    });
    // One shared date: a date change can inject a separator row, and these tests
    // count rows.
    buffer.lines = Array.from({ length: count }, (_, id) => createBufferLine({
        buffer: ID, date: 1_700_000_000, prefix: 'nick', message: `msg ${id}`,
        tags_array: ['irc_privmsg'], displayed: 1, highlight: 0, id,
    }));
    return { ...buffer, ...overrides };
}

function install(count: number, overrides: Partial<BufferData> = {}): void {
    buffers.set({ [ID]: bufferWith(count, overrides) });
}

function held(): BufferData {
    return get(buffers)[ID]!;
}

beforeEach(() => {
    buffers.set({});
    linesPerScreen.set(100);
});

describe('an unpaged buffer keeps the screen cap', () => {
    it('has no cap of its own', () => {
        install(50);
        expect(held().historyLimit).toBeUndefined();
        expect(lineLimitFor(held())).toBe(get(maxBufferLines));
    });

    it('follows the screen when the viewport changes', () => {
        install(50);
        const before = lineLimitFor(held());
        linesPerScreen.set(600);
        expect(lineLimitFor(held())).toBeGreaterThan(before);
    });
});

describe("a deliberate page raises only that buffer's cap", () => {
    it('doubles from the screen cap and records it on the buffer', () => {
        const screenCap = get(maxBufferLines);
        install(200);

        const next = growHistoryLimit(ID);

        expect(next).toBe(screenCap * 2);
        expect(held().historyLimit).toBe(screenCap * 2);
        expect(lineLimitFor(held())).toBe(screenCap * 2);
    });

    it('leaves other buffers at the screen cap', () => {
        install(200);
        buffers.update((current) => ({ ...current, '2002': bufferWith(200) }));
        growHistoryLimit(ID);

        expect(lineLimitFor(get(buffers)['2002']!)).toBe(get(maxBufferLines));
    });

    it('stops at the ceiling instead of growing without bound', () => {
        install(0, { historyLimit: 1500 });

        // 4096 is WeeChat's own history.max_buffer_lines_number default, so the
        // client stops exactly where the relay stops. Pinned deliberately.
        expect(growHistoryLimit(ID)).toBe(3000);
        expect(growHistoryLimit(ID)).toBe(4096);
        expect(growHistoryLimit(ID)).toBe(4096);
        expect(held().historyLimit).toBe(4096);
    });

    it("never sets a cap below what the screen itself holds", () => {
        // A cap recorded while the window was short, then read on a taller one:
        // doubling the stale value would still be smaller than the screen, so
        // the screen wins.
        install(0, { historyLimit: 100 });
        expect(growHistoryLimit(ID)).toBe(get(maxBufferLines));
    });

    it('survives a shrinking viewport', () => {
        install(0, { historyLimit: 1500 });
        linesPerScreen.set(50);
        expect(lineLimitFor(held())).toBe(1500);
    });
});

describe('a history page is sized to the window it may retain', () => {
    it('asks for the whole cap, not an increment', () => {
        install(0, { historyLimit: 1200 });
        expect(historyPageSize(0, lineLimitFor(held()))).toBe(1200);
    });

    it('never asks for a page of zero', () => {
        expect(historyPageSize(0, 0)).toBe(100);
    });

    it('honours a larger explicit request', () => {
        expect(historyPageSize(2000, 1200)).toBe(2000);
    });
});

describe("the trim honours the buffer's own cap", () => {
    it('keeps a deep window the screen cap would have dropped', () => {
        const buffer = bufferWith(1000, { historyLimit: 1200 });
        trimBufferLines(buffer, lineLimitFor(buffer));
        expect(buffer.lines).toHaveLength(1000);
    });

    it('still trims to a cap the window exceeds', () => {
        const buffer = bufferWith(1000, { historyLimit: 500 });
        trimBufferLines(buffer, lineLimitFor(buffer));
        expect(buffer.lines).toHaveLength(500);
        expect(buffer.lines[0]!.text).toBe('msg 500', 'the oldest lines are the ones dropped');
    });

    it('does not trim a deep window away when the reader switches back to it', () => {
        install(1500, { historyLimit: 2000 });

        setActiveBuffer(ID);

        expect(held().lines).toHaveLength(1500);
    });
});

describe('a clear gives the depth back', () => {
    it('drops the raised cap along with the lines', () => {
        install(10, { historyLimit: 3000 });

        handleBufferCleared({ objects: [{ content: [{ pointers: [ID] }] }] } as unknown as ProtocolMessage);

        expect(held().lines).toHaveLength(0);
        expect(held().historyLimit, 'the depth was earned by paging, and the window is gone').toBeUndefined();
        expect(lineLimitFor(held())).toBe(get(maxBufferLines));
    });
});

describe('a buffer opens with room left for live traffic', () => {
    it('asks for one screenful, not the whole cap', () => {
        // linesPerScreen 100 -> cap 210. Opening at the cap would leave no room
        // for a live line to grow the window, which is how this regressed once.
        expect(initialHistoryWindow()).toBe(110);
        expect(initialHistoryWindow()).toBeLessThan(get(maxBufferLines));
    });

    it('leaves the depth to a deliberate page', () => {
        install(0);
        const opening = historyPageSize(0, initialHistoryWindow());
        const paged = historyPageSize(0, growHistoryLimit(ID));
        expect(opening, 'a page nobody asked for must not fill the cap').toBeLessThan(paged);
    });
});

describe('a buffer paged to the ceiling', () => {
    it('stops widening the window', () => {
        install(0, { historyLimit: 3000 });
        const first = growHistoryLimit(ID);
        const second = growHistoryLimit(ID);
        expect(second, 'the ceiling is a ceiling').toBe(first);
        // The next deliberate page asks for exactly the window already held, so it
        // re-delivers lines the buffer has rather than reaching deeper.
        expect(historyPageSize(0, second)).toBe(first);
    });

    it('keeps every line it holds at the ceiling', () => {
        install(0, { historyLimit: 3000 });
        const limit = growHistoryLimit(ID);
        const full = bufferWith(limit, { historyLimit: limit });
        trimBufferLines(full, lineLimitFor(full));
        expect(full.lines.length).toBe(limit);
    });

    it('is not provably exhausted, so the control stays available', () => {
        // A full page is not evidence of exhaustion: the relay answers "the newest
        // N lines" and N here was the window itself. The app therefore leaves
        // allLinesFetched false at the ceiling and the control keeps re-requesting
        // the same window. Locked deliberately — hiding it would need an exhaustion
        // signal neither relay provides.
        install(0, { historyLimit: 3000, allLinesFetched: false });
        growHistoryLimit(ID);
        expect(get(buffers)[ID]!.allLinesFetched).toBe(false);
    });
});

