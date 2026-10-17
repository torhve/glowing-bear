// Free buffers (/exec -nf, plugin output, relay.list) page history exactly like
// channels: the relay answers a wider newest-N window with more of the buffer's
// content, so nothing may be refused on account of buffer type. Issue #11 is
// what happened when "free" was read as "no history to fetch" — `relay.list`,
// whose rows predate the connection, rendered empty (issue #11).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { get } from 'svelte/store';
import { activeBufferId, buffers, createBuffer } from '#lib/stores/models.ts';
import { fetchMoreLines } from '#lib/stores/connectionManager.ts';
// The transports are replaced by spies, so these bindings are the call record.
import { fetchMoreLines as apiFetchMoreLines } from '#lib/stores/apiConnection.ts';
import { fetchMoreLines as legacyFetchMoreLines } from '#lib/stores/legacyConnection.ts';

// The facade registers each transport's adapter when it loads, so a mock of a
// transport has to carry one or the facade throws before the test runs. Kept
// inert: this spec is about history paging, not about retry state.
const inertAdapter = vi.hoisted(() => (kind: 'api' | 'legacy') => ({
    kind,
    open: () => Promise.resolve(),
    teardown: () => {},
    hasLiveSession: () => false,
    isAttemptInProgress: () => false,
    hasRetryLoop: () => false,
    manualReconnect: () => {},
    pendingRetry: () => ({ active: false }),
}));
vi.mock('#lib/stores/apiConnection.ts', () => ({ fetchMoreLines: vi.fn(), transportAdapter: inertAdapter('api') }));
vi.mock('#lib/stores/legacyConnection.ts', () => ({ fetchMoreLines: vi.fn(), transportAdapter: inertAdapter('legacy') }));

const FREE_ID = 'free-buffer';
const CHANNEL_ID = 'channel-buffer';

beforeEach(() => {
    buffers.set({
        [FREE_ID]: createBuffer({
            pointers: ['0x1'],
            full_name: 'exec.exec.free',
            short_name: 'exec.free',
            title: [],
            hidden: 0,
            number: 2,
            type: 1,
            local_variables: { type: 'free', plugin: 'exec' },
        }),
        [CHANNEL_ID]: createBuffer({
            pointers: ['0x2'],
            full_name: 'irc.gbtest.#glowing-bear',
            short_name: '#glowing-bear',
            title: [],
            hidden: 0,
            number: 1,
            type: 0,
            local_variables: { type: 'channel', irc: 'gbtest', channel: '#glowing-bear' },
        }),
    });
    activeBufferId.set(CHANNEL_ID);
});

describe('connectionManager history paging', () => {
    it('a free buffer reaches the transport for its initial window', async () => {
        // `relay.list` is a free buffer whose rows exist before this connection,
        // so the window request is the only thing that can deliver them.
        await fetchMoreLines(100, FREE_ID);

        expect(apiFetchMoreLines).toHaveBeenCalledTimes(1);
        expect(legacyFetchMoreLines).not.toHaveBeenCalled();
    });

    it('a reader page on a free buffer reaches the transport too', async () => {
        // Live probe (api-dossier `probes/probe-free-buffer-depth.mjs`): a free
        // buffer holding 501 rows answers `lines=-40` with 40 and `lines=-1000`
        // with all 501, so a page is not a no-op. Completeness is the transport's
        // answer to make, not the buffer type's.
        await fetchMoreLines(0, FREE_ID, true);

        expect(apiFetchMoreLines).toHaveBeenCalledTimes(1);
        expect(legacyFetchMoreLines).not.toHaveBeenCalled();
        expect(get(buffers)[FREE_ID]!.allLinesFetched, 'the facade must not close the gate on its own').not.toBe(true);
    });

    it('the active buffer is asked without an explicit id', async () => {
        activeBufferId.set(FREE_ID);

        await fetchMoreLines(100);

        expect(apiFetchMoreLines).toHaveBeenCalledTimes(1);
    });

    it('a channel buffer still asks the active transport', async () => {
        await fetchMoreLines(100, CHANNEL_ID);

        expect(apiFetchMoreLines).toHaveBeenCalledTimes(1);
        expect(legacyFetchMoreLines).not.toHaveBeenCalled();
    });
});
