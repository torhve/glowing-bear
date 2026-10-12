// The relay transport facade must not ask either transport for history on a
// free buffer (/exec -nf, plugin output): those rows are live-only, so a
// history request re-delivers the current rows instead of older content.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { get } from 'svelte/store';
import { activeBufferId, buffers, createBuffer } from '#lib/stores/models.ts';
import { fetchMoreLines } from '#lib/stores/connectionManager.ts';
// The transports are replaced by spies, so these bindings are the call record.
import { fetchMoreLines as apiFetchMoreLines } from '#lib/stores/apiConnection.ts';
import { fetchMoreLines as legacyFetchMoreLines } from '#lib/stores/legacyConnection.ts';

// The facade registers each transport's adapter when it loads, so a mock of a
// transport has to carry one or the facade throws before the test runs. Kept
// inert: this spec is about the history gate, not about retry state.
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

describe('connectionManager history gate', () => {
    it('a free buffer never reaches either transport', async () => {
        await fetchMoreLines(100, FREE_ID);

        expect(apiFetchMoreLines).not.toHaveBeenCalled();
        expect(legacyFetchMoreLines).not.toHaveBeenCalled();
        expect(get(buffers)[FREE_ID]!.allLinesFetched).toBe(true);
    });

    it('the active buffer is gated too, without an explicit id', async () => {
        activeBufferId.set(FREE_ID);

        await fetchMoreLines(100);

        expect(apiFetchMoreLines).not.toHaveBeenCalled();
        expect(legacyFetchMoreLines).not.toHaveBeenCalled();
    });

    it('a channel buffer still asks the active transport', async () => {
        await fetchMoreLines(100, CHANNEL_ID);

        expect(apiFetchMoreLines).toHaveBeenCalledTimes(1);
        expect(legacyFetchMoreLines).not.toHaveBeenCalled();
    });
});
