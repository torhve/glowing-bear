// Free buffers (/exec -nf, plugin output, relay.list) are ordinary buffers for
// history — they page like channels (see free-buffer-history-paging.test.ts and
// api-dossier `probes/probe-free-buffer-depth.mjs`). What this file pins is the
// bufferType marker the API reducer and the legacy transport derive the same
// way: type 1 for free buffers, 0 for the rest.
import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { buffers, createBuffer } from '#lib/stores/models.ts';
import { createApiStoreReducers } from '#lib/api/api-store-reducers.ts';
import type { BufferSnapshot } from '#lib/api/api-contracts.ts';
import type { ApiBufferId } from '#lib/api/api-ids.ts';

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

describe('free-buffer markers', () => {
    it('free buffers map to bufferType 1 and channels to 0', () => {
        const reducers = createApiStoreReducers();
        reducers.buffers([
            snapshot(FREE_ID, 'free', 'python.eval', ''),
            snapshot(CHANNEL_ID, 'formatted', 'irc.gbtest.#glowing-bear', 'gbtest'),
        ]);

        // The transports key rendering and trimming off this marker; history
        // paging must not.
        expect(get(buffers)[String(FREE_ID)]!.bufferType).toBe(1);
        expect(get(buffers)[String(CHANNEL_ID)]!.bufferType).toBe(0);
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
        expect(free.bufferType).toBe(1);
    });
});
