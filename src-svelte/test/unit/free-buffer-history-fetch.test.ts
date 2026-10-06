// Free buffers (/exec -nf, plugin output) have live-only rows: both transports
// must treat them as history-complete instead of asking for older lines, which
// would re-deliver the current rows as duplicates.
import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import {
    buffers,
    createBuffer,
    hasNoHistoryToFetch,
    markHistoryComplete,
} from '#lib/stores/models.ts';
import { createApiStoreReducers, flushApiLineBatch } from '#lib/api/api-store-reducers.ts';
import type { BufferSnapshot } from '#lib/api/api-contracts.ts';
import type { ApiBufferId, ApiLineId } from '#lib/api/api-ids.ts';

const FREE_ID = 1759000000000001 as ApiBufferId;
const CHANNEL_ID = 1759000000000002 as ApiBufferId;

function snapshot(id: ApiBufferId, contentType: string, name: string, server: string): BufferSnapshot {
    return {
        id,
        name,
        shortName: name,
        number: 2,
        contentType,
        semanticType: contentType === 'free' ? 'other' : 'channel',
        hidden: false,
        title: name,
        localVariables: { type: contentType, plugin: contentType === 'free' ? 'exec' : 'irc', server },
        lastReadLineId: -1,
    };
}

beforeEach(() => {
    buffers.set({});
});

describe('free-buffer history gate', () => {
    it('free buffers map to bufferType 1 and are recognised as history-less', () => {
        const reducers = createApiStoreReducers();
        reducers.buffers([
            snapshot(FREE_ID, 'free', 'python.eval', ''),
            snapshot(CHANNEL_ID, 'formatted', 'irc.gbtest.#glowing-bear', 'gbtest'),
        ]);

        expect(get(buffers)[String(FREE_ID)]!.bufferType).toBe(1);
        expect(hasNoHistoryToFetch(get(buffers)[String(FREE_ID)]!)).toBe(true);
        expect(hasNoHistoryToFetch(get(buffers)[String(CHANNEL_ID)]!)).toBe(false);
    });

    it('marking history complete keeps the rows already on screen', () => {
        const reducers = createApiStoreReducers();
        reducers.buffers([snapshot(FREE_ID, 'free', 'python.eval', '')]);
        reducers.lineAdded(FREE_ID, {
            id: 11 as ApiLineId,
            epochMs: Date.parse('2026-10-05T19:16:40.000Z'),
            displayed: true,
            highlight: false,
            notifyLevel: 0,
            prefix: '',
            message: 'live row',
            tags: [],
        });
        // lineAdded is frame-aligned: it queues the event, one flush applies
        // the batch. Drain it before reading the store.
        flushApiLineBatch();

        markHistoryComplete(String(FREE_ID));

        const buf = get(buffers)[String(FREE_ID)]!;
        expect(buf.allLinesFetched).toBe(true);
        expect(buf.lines).toHaveLength(1);
    });

    it('marking an unknown or already-complete buffer changes nothing', () => {
        const reducers = createApiStoreReducers();
        reducers.buffers([snapshot(FREE_ID, 'free', 'python.eval', '')]);
        markHistoryComplete(String(FREE_ID));

        const before = get(buffers);
        markHistoryComplete('missing-buffer-id');
        markHistoryComplete(String(FREE_ID));

        expect(get(buffers)).toEqual(before);
    });

    it('createBuffer keeps the free marker for the legacy transport', () => {
        const free = createBuffer({
            pointers: ['0x1'],
            full_name: 'python.eval',
            short_name: 'eval',
            title: [],
            hidden: 0,
            number: 2,
            type: 1,
            local_variables: { type: 'free', plugin: 'exec' },
        });
        expect(hasNoHistoryToFetch(free)).toBe(true);
    });
});
