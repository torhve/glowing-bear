import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import {
    buffers, createBuffer, createBufferLine,
    activeBufferId, initialHistoryWindow, linesPerScreen, runHistoryPage,
} from '#lib/stores/models.ts';
import type { BufferData } from '#lib/types.ts';

/**
 * One page of history, asked through the runner both transports now share.
 *
 * What a page is allowed to do was written twice, once per transport, and the
 * unit tests that existed tested one transport's internals — a test that
 * "fetchMoreLines re-fetches after a transient error passes" passed while
 * testing neither rule, because the rule lived in a copy that was never asked.
 * These tests ask the shared rules of the shared function: which buffers get
 * asked, how big a page is, and what a page is allowed to write back.
 */

const ID = '1001';

function bufferWith(count: number, overrides: Partial<BufferData> = {}): BufferData {
    const buffer = createBuffer({
        pointers: [ID], full_name: 'irc.gbtest.#chan', short_name: '#chan', number: 1,
        local_variables: { type: 'channel' },
    });
    // One shared date: a date change can inject a separator row, and these tests count rows.
    buffer.lines = Array.from({ length: count }, (_, i) => createBufferLine({
        buffer: ID, date: 1_700_000_000, prefix: 'nick', message: `msg ${i}`,
        tags_array: ['irc_privmsg'], displayed: 1, highlight: 0, id: i,
    }));
    return { ...buffer, ...overrides };
}

interface Ask {
    pageLines: number;
    bufferId: string;
}

/** A transport whose fetch records what it was asked for and answers with its own line count. */
function transport(
    answer: number | null | ((pageLines: number) => number),
    pending = new Set<string>(),
) {
    const asks: Ask[] = [];
    const request = {
        pending,
        pendingKeyFor: (buffer: BufferData) => buffer.id,
        heldWindow: () => initialHistoryWindow(),
        fetch: async (buffer: BufferData, pageLines: number, bufferId: string) => {
            asks.push({ pageLines, bufferId });
            const received = typeof answer === 'function' ? answer(pageLines) : answer;
            if (received === null) return null;
            return { received, complete: received < pageLines };
        },
    };
    return { asks, pending, request };
}

function held(): BufferData {
    return get(buffers)[ID]!;
}

beforeEach(() => {
    buffers.set({});
    linesPerScreen.set(100);
    activeBufferId.set('');
});

describe('which buffers get asked', () => {
    it('never asks a buffer whose history is already complete', async () => {
        buffers.set({ [ID]: bufferWith(5, { allLinesFetched: true }) });
        const { asks, request } = transport(0);

        await runHistoryPage(ID, { ...request, numLines: 0, deliberate: false });

        expect(asks).toEqual([]);
        expect(held().allLinesFetched).toBe(true);
    });

    it('never asks a buffer that already has a page in flight', async () => {
        buffers.set({ [ID]: bufferWith(5) });
        const { asks, pending, request } = transport(10, new Set([ID]));

        await runHistoryPage(ID, { ...request, numLines: 10, deliberate: false });

        expect(asks).toEqual([]);
        // The in-flight entry belongs to whoever put it there; the runner must not clear it.
        expect(pending.has(ID)).toBe(true);
    });

    it('asks the active buffer when none was named', async () => {
        buffers.set({ [ID]: bufferWith(5) });
        activeBufferId.set(ID);
        const { asks, request } = transport(10);

        await runHistoryPage(undefined, { ...request, numLines: 10, deliberate: false });

        expect(asks).toEqual([{ pageLines: initialHistoryWindow(), bufferId: ID }]);
    });

    it('says so when there is no buffer to page', async () => {
        activeBufferId.set('');
        const { request } = transport(10);

        await expect(runHistoryPage(undefined, { ...request, numLines: 10, deliberate: false }))
            .rejects.toThrow('No active buffer');
    });

    it('keeps one transport\'s in-flight page from silencing the other', async () => {
        buffers.set({ [ID]: bufferWith(5) });
        // Legacy keys a buffer as `0x…`, the API by its store id.
        const legacy = new Set(['0x' + ID]);
        const api = transport(10, new Set());
        const apiAsks = api.asks;

        await runHistoryPage(ID, { ...api.request, numLines: 10, deliberate: false });

        expect(apiAsks.length).toBe(1);
        expect(legacy.has('0x' + ID)).toBe(true);
    });
});

describe('how big a page is', () => {
    it('covers one screenful plus headroom when nobody asked for depth', async () => {
        buffers.set({ [ID]: bufferWith(5) });
        const { asks, request } = transport(0);

        await runHistoryPage(ID, { ...request, numLines: 0, deliberate: false });

        expect(asks[0]!.pageLines).toBe(initialHistoryWindow());
    });

    it('covers the whole window the buffer may keep when the reader asked for depth', async () => {
        buffers.set({ [ID]: bufferWith(5) });
        // A page that arrives full keeps the gate open, so the next deliberate page is asked too.
        const { asks, request } = transport((pageLines) => pageLines);

        await runHistoryPage(ID, { ...request, numLines: 0, deliberate: true });

        // The page is exactly the window this buffer is now permitted to retain.
        expect(asks[0]!.pageLines).toBe(held().historyLimit);
        expect(asks[0]!.pageLines).toBeGreaterThan(initialHistoryWindow());

        // The next deliberate page widens the window rather than re-asking the same size.
        await runHistoryPage(ID, { ...request, numLines: 0, deliberate: true });
        expect(asks[1]!.pageLines).toBe(asks[0]!.pageLines * 2);
    });

    it('stays at least a page, so an empty answer is not read as no history', async () => {
        buffers.set({ [ID]: bufferWith(0) });
        const { asks, request } = transport(0);

        await runHistoryPage(ID, { ...request, numLines: 0, deliberate: false });

        expect(asks[0]!.pageLines).toBeGreaterThan(0);
    });

    it('floors the page at the lines a replacing transport already holds', async () => {
        // The legacy transport passes a floor because its response replaces the window.
        buffers.set({ [ID]: bufferWith(400) });
        const { asks, request } = transport(0);

        await runHistoryPage(ID, {
            ...request,
            numLines: 0,
            deliberate: false,
            heldWindow: (buffer) => Math.max(initialHistoryWindow(), buffer.lines.length),
        });

        expect(asks[0]!.pageLines).toBe(400);
    });
});

describe('what a page writes back', () => {
    it('closes the history gate when the answer came back short', async () => {
        buffers.set({ [ID]: bufferWith(5) });
        const { request } = transport(3);

        await runHistoryPage(ID, { ...request, numLines: 100, deliberate: false });

        expect(held().allLinesFetched).toBe(true);
        expect(held().newestWindowFetched).toBe(true);
    });

    it('leaves the gate open when the relay had more to give', async () => {
        buffers.set({ [ID]: bufferWith(5) });
        const window = initialHistoryWindow();
        const { request } = transport(window);

        await runHistoryPage(ID, { ...request, numLines: window, deliberate: false });

        expect(held().allLinesFetched).toBe(false);
        expect(held().newestWindowFetched).toBe(true);
    });

    it('marks the window fetched even when the page added nothing', async () => {
        // Without this, a buffer whose window was already complete re-fires the switch fetch
        // forever: 301 identical `lines=-100` requests in one recorded run.
        buffers.set({ [ID]: bufferWith(5, { newestWindowFetched: false }) });
        const { request } = transport(0);

        await runHistoryPage(ID, { ...request, numLines: 100, deliberate: false });

        expect(held().newestWindowFetched).toBe(true);
    });

    it('writes nothing when the answer describes a window that is gone', async () => {
        buffers.set({ [ID]: bufferWith(5, { allLinesFetched: false, newestWindowFetched: false }) });
        const { pending, request } = transport(null);

        await runHistoryPage(ID, { ...request, numLines: 100, deliberate: false });

        expect(held().allLinesFetched).toBe(false);
        expect(held().newestWindowFetched).toBe(false);
        expect(pending.size).toBe(0);
    });

    it('re-asks a buffer whose page failed, because a failure is not the end of history', async () => {
        buffers.set({ [ID]: bufferWith(5) });
        let fail = true;
        const asks: number[] = [];
        const pending = new Set<string>();
        const request = {
            pending,
            pendingKeyFor: (buffer: BufferData) => buffer.id,
            heldWindow: () => initialHistoryWindow(),
            fetch: async (_buffer: BufferData, pageLines: number) => {
                asks.push(pageLines);
                if (fail) throw new Error('fetchMoreLines timeout');
                return { received: 2, complete: true };
            },
        };

        await runHistoryPage(ID, { ...request, numLines: 100, deliberate: false });
        expect(held().allLinesFetched).toBe(false);
        expect(pending.size).toBe(0);

        fail = false;
        await runHistoryPage(ID, { ...request, numLines: 100, deliberate: false });
        expect(asks.length).toBe(2);
        expect(held().allLinesFetched).toBe(true);
    });

    it('leaves a buffer that vanished mid-page alone', async () => {
        buffers.set({ [ID]: bufferWith(5) });
        const { request } = transport(2);

        await runHistoryPage(ID, {
            ...request,
            numLines: 100,
            deliberate: false,
            fetch: async () => {
                buffers.set({});
                return { received: 2, complete: true };
            },
        });

        expect(get(buffers)[ID]).toBeUndefined();
    });
});
