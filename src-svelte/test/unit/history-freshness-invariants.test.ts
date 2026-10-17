import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import {
    buffers,
    historyWindowEstablished,
} from '#lib/stores/models.ts';
import { createApiStoreReducers } from '#lib/api/api-store-reducers.ts';
import type { BufferSnapshot } from '#lib/api/api-contracts.ts';
import type { ApiBufferId } from '#lib/api/api-ids.ts';
import { handleBufferCleared } from '#lib/stores/handlers.ts';
import type { ProtocolMessage } from '#lib/types.ts';

/**
 * What the one-shot history gate is allowed to treat as "already fetched".
 *
 * The gate asks whether THIS session has seen the relay's current newest window.
 * Two things can corrupt that answer: a response that carried no window at all,
 * and a buffer that was emptied underneath a session that had already fetched.
 * Both would close the gate and leave the user looking at a transcript with a
 * hole in it, which is the failure mode this guards against.
 */

const GREP_ID = 1759000000000077 as ApiBufferId;

function snapshot(id: ApiBufferId, name: string): BufferSnapshot {
    return {
        id, name, shortName: name, number: 4, contentType: 'formatted',
        semanticType: 'channel', hidden: false, title: name,
        localVariables: { type: 'channel', plugin: 'python' }, lastReadLineId: -1,
    };
}

describe('what counts as an established newest window', () => {
    it('a window that carried lines counts', () => {
        expect(historyWindowEstablished(100, false)).toBe(true);
    });

    it('fewer lines than requested means history start, which also counts', () => {
        // A buffer with only 12 lines answers a request for 100 with 12. Asking
        // again would ask forever, and there is nothing newer to find.
        expect(historyWindowEstablished(12, true)).toBe(true);
    });

    it('an empty answer to an empty request establishes nothing', () => {
        // `lines=0` is answered with []. `0 < 0` is false, so this is not history
        // start either — it is a request that asked for nothing, and closing the
        // gate on it is how a capped buffer silently stopped paging upward.
        expect(historyWindowEstablished(0, false)).toBe(false);
    });

    it('a genuinely empty buffer still closes the gate', () => {
        expect(historyWindowEstablished(0, true)).toBe(true);
    });
});

describe('a cleared buffer has fetched nothing', () => {
    beforeEach(() => { buffers.set({}); });

    // api-dossier (probes/probe-scripts-grep.mjs): the `*grep` results buffer is
    // shared and reused, and every /grep run — hit or miss — emits buffer_cleared
    // before it emits any lines. So a reused buffer always arrives as an empty
    // one, and it must not inherit the previous search's freshness.
    it('buffer_cleared resets the freshness the previous content had earned', () => {
        const reducers = createApiStoreReducers();
        reducers.buffers([snapshot(GREP_ID, 'grep')]);
        const key = String(GREP_ID);

        buffers.update((current) => ({
            ...current,
            [key]: { ...current[key]!, requestedLines: 200, newestWindowFetched: true, allLinesFetched: true },
        }));
        expect(get(buffers)[key]!.newestWindowFetched).toBe(true);

        reducers.bufferCleared(GREP_ID);

        const after = get(buffers)[key]!;
        expect(after.lines).toHaveLength(0);
        expect(after.requestedLines, 'nothing has been asked for since the clear').toBe(0);
        expect(after.newestWindowFetched, 'the reused buffer must ask for its own newest window').toBe(false);
        expect(after.allLinesFetched, 'completeness did not survive the clear').toBe(false);
    });
});

/**
 * The other half of the same rule: a clear must also invalidate a window that is
 * already on its way. fetchMoreLines captures the epoch before asking and re-reads
 * it after the await, because the response is applied as a wholesale replacement of
 * the buffer's lines. WeeChat re-renders its own buffers — relay.list on every
 * client connect and disconnect — so the clear can land mid-request with no user
 * action, and applying the older window would reinstate content WeeChat had just
 * thrown away beside the fresh rows that arrive after it.
 */
describe('a clear invalidates a window already on its way', () => {
    const RELAY_LIST_ID = 1759000000000088 as ApiBufferId;

    beforeEach(() => { buffers.set({}); });

    function seedFetchedBuffer(): number {
        const reducers = createApiStoreReducers();
        reducers.buffers([snapshot(RELAY_LIST_ID, 'relay.list')]);
        const key = String(RELAY_LIST_ID);
        buffers.update((current) => ({
            ...current,
            [key]: { ...current[key]!, newestWindowFetched: true, allLinesFetched: true },
        }));
        return get(buffers)[key]!.clearEpoch ?? 0;
    }

    it('the API reducer bumps the epoch a pending response is checked against', () => {
        const before = seedFetchedBuffer();
        createApiStoreReducers().bufferCleared(RELAY_LIST_ID);
        expect(get(buffers)[String(RELAY_LIST_ID)]!.clearEpoch, 'a response built before the clear must not match').toBe(before + 1);
    });

    it('the legacy handler bumps the same epoch and forgets the same freshness', () => {
        const before = seedFetchedBuffer();

        handleBufferCleared({ objects: [{ content: [{ pointers: [RELAY_LIST_ID] }] }] } as unknown as ProtocolMessage);

        const after = get(buffers)[String(RELAY_LIST_ID)]!;
        expect(after.clearEpoch, 'the legacy path guards its wholesale line replacement too').toBe(before + 1);
        expect(after.newestWindowFetched, 'a re-rendered buffer must ask for its window again').toBe(false);
        expect(after.allLinesFetched).toBe(false);
    });
});
