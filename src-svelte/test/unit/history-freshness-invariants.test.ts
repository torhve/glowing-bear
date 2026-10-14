import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import {
    buffers,
    historyWindowEstablished,
} from '#lib/stores/models.ts';
import { createApiStoreReducers } from '#lib/api/api-store-reducers.ts';
import type { BufferSnapshot } from '#lib/api/api-contracts.ts';
import type { ApiBufferId } from '#lib/api/api-ids.ts';

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
