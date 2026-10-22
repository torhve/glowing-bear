import { describe, it, expect, beforeEach, vi } from 'vitest';
import { get } from 'svelte/store';
import {
    activeBufferId, buffers, createBuffer, createBufferLine,
    SWITCH_FETCH_REQUEST_LINES,
} from '#lib/stores/models.ts';
import { switchBufferCommon } from '#lib/stores/connectionLifecycle.ts';
import type { BufferData } from '#lib/types.ts';

/**
 * Switching buffers, on the path both transports now share.
 *
 * Each transport used to write the same three steps — page a buffer that has no
 * window yet, move the active buffer, then tell WeeChat the reader arrived — and
 * the ordering between them was stated twice and obeyed twice. What matters to
 * the reader is visible here: a buffer nobody has fetched gets a page before the
 * switch lands, a failed page does not lose the switch, and the two commands that
 * clear unread go out only after the frame, because the read marker is computed
 * from the unread count those commands zero.
 */

function buffer(id: string, count: number, overrides: Partial<BufferData> = {}): BufferData {
    const made = createBuffer({
        pointers: [id], full_name: `irc.gbtest.#${id}`, short_name: `#${id}`, number: 1,
        local_variables: { type: 'channel' },
    });
    made.lines = Array.from({ length: count }, (unused, i) => createBufferLine({
        buffer: id, date: 1_700_000_000, prefix: 'nick', message: `msg ${i}`,
        tags_array: ['irc_privmsg'], displayed: 1, highlight: 0, id: i,
    }));
    return { ...made, ...overrides };
}

/** Wait for the frame the switch scheduled, so its commands have gone out. */
async function frame(): Promise<void> {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

const NEEDS_HISTORY = '1001';
const ALREADY_FETCHED = '1002';

interface Switch {
    pages: string[];
    commands: string[];
    calls: () => { fetchPage: (requested: number, bufferId: string) => Promise<void>; deliver: (command: string, bufferId: string) => void; hotlistQuery: () => void };
}

function switcher(pagesFail = false): Switch {
    const pages: string[] = [];
    const commands: string[] = [];
    const fetchPage = async (_requested: number, bufferId: string) => {
        // The active buffer at the moment the page is asked for: a switch that
        // moved first would make the page belong to the wrong buffer.
        pages.push(`${bufferId}@${get(activeBufferId)}`);
        if (pagesFail) throw new Error('fetchMoreLines timeout');
    };
    const deliver = (command: string, bufferId: string) => { commands.push(`${command}#${bufferId}`); };
    const hotlistQuery = vi.fn();
    return {
        pages,
        commands,
        calls: () => ({ fetchPage, deliver, hotlistQuery }),
    };
}

beforeEach(() => {
    buffers.set({
        [NEEDS_HISTORY]: buffer(NEEDS_HISTORY, 3, { lastSeen: -1, newestWindowFetched: false }),
        [ALREADY_FETCHED]: buffer(ALREADY_FETCHED, 40, { lastSeen: 39, newestWindowFetched: true }),
    });
    activeBufferId.set(ALREADY_FETCHED);
});

describe('the page a switch asks for', () => {
    it('fetches a buffer that has never had a window in this session', async () => {
        const run = switcher();

        expect(await switchBufferCommon(NEEDS_HISTORY, run.calls())).toBe(true);

        expect(run.pages).toEqual([`${NEEDS_HISTORY}@${ALREADY_FETCHED}`]);
        expect(get(activeBufferId)).toBe(NEEDS_HISTORY);
    });

    it('asks the fixed switch page, not the whole file', async () => {
        let requested = 0;
        await switchBufferCommon(NEEDS_HISTORY, {
            fetchPage: async (count) => { requested = count; },
            deliver: () => { },
            hotlistQuery: () => { },
        });

        expect(requested).toBe(SWITCH_FETCH_REQUEST_LINES);
    });

    it('leaves a buffer whose window is already fetched alone', async () => {
        activeBufferId.set(NEEDS_HISTORY);
        const run = switcher();

        expect(await switchBufferCommon(ALREADY_FETCHED, run.calls())).toBe(true);

        expect(run.pages).toEqual([]);
        expect(get(activeBufferId)).toBe(ALREADY_FETCHED);
    });

    it('switches anyway when the page fails', async () => {
        const run = switcher(true);

        expect(await switchBufferCommon(NEEDS_HISTORY, run.calls())).toBe(true);

        expect(get(activeBufferId)).toBe(NEEDS_HISTORY);
        await frame();
        expect(run.commands.length).toBe(2);
    });

    it('refuses a buffer that is not in the store, asking for nothing', async () => {
        const run = switcher();

        expect(await switchBufferCommon('9999', run.calls())).toBe(false);

        expect(run.pages).toEqual([]);
        expect(get(activeBufferId)).toBe(ALREADY_FETCHED);
        await frame();
        expect(run.commands).toEqual([]);
    });
});

describe('what a switch tells WeeChat', () => {
    it('sends nothing before the frame has run', async () => {
        const run = switcher();

        await switchBufferCommon(NEEDS_HISTORY, run.calls());

        // The read marker is computed from the unread count these commands zero, so
        // clearing first would position the marker at a line the reader never read.
        expect(run.commands).toEqual([]);
    });

    it('clears the hotlist and moves the marker to the last line, then re-reads the hotlist', async () => {
        const run = switcher();

        await switchBufferCommon(NEEDS_HISTORY, run.calls());
        await frame();

        expect(run.commands).toEqual([
            `/buffer set hotlist -1#${NEEDS_HISTORY}`,
            `/buffer set unread#${NEEDS_HISTORY}`,
        ]);
        expect(run.calls().hotlistQuery).toHaveBeenCalledTimes(1);
    });

    it('names the buffer being left, not whichever buffer is active when the frame fires', async () => {
        const run = switcher();

        await switchBufferCommon(NEEDS_HISTORY, run.calls());
        activeBufferId.set(ALREADY_FETCHED);
        await frame();

        expect(run.commands.every((command) => command.endsWith(`#${NEEDS_HISTORY}`))).toBe(true);
    });
});
