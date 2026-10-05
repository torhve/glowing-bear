// Pending /q and nicklist-query navigation: WeeChat opens the requested private
// buffer asynchronously, and the same nick can be queried on two IRC servers at
// once, so only a buffer in the request's server context may auto-switch.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { get } from 'svelte/store';
import {
    buffers,
    activeBufferId,
    pendingBufferSwitch,
    newPendingSwitch,
    clearPendingSwitchIfCurrent,
} from '#lib/stores/models.ts';
import { createApiStoreReducers } from '#lib/api/api-store-reducers.ts';
import { dispatchEvent } from '#lib/api/api-mapping.ts';
import { handleBufferOpened } from '#lib/stores/handlers.ts';
import type { ApiReducers, BufferSnapshot } from '#lib/api/api-contracts.ts';
import type { ApiSessionEvent } from '#lib/api/api-session.ts';
import type { ApiBufferId } from '#lib/api/api-ids.ts';
import type { BufferMessage, ProtocolMessage } from '#lib/types.ts';

const ALPHA_ID = 1759000000000001 as ApiBufferId;
const BETA_ID = 1759000000000002 as ApiBufferId;

// A query buffer for the same nick on two different IRC servers.
function querySnapshot(id: ApiBufferId, server: string): BufferSnapshot {
    return {
        id,
        name: `irc.${server}.alice`,
        shortName: 'alice',
        number: 3,
        contentType: 'formatted',
        semanticType: 'query',
        hidden: false,
        title: 'alice',
        localVariables: { type: 'query', plugin: 'irc', server, nick: 'alice' },
        lastReadLineId: -1,
    };
}

function wireBuffer(id: ApiBufferId, server: string) {
    return {
        id,
        name: `irc.${server}.alice`,
        short_name: 'alice',
        number: 3,
        type: 'formatted',
        hidden: false,
        title: 'alice',
        modes: '',
        input_prompt: '',
        input: '',
        input_position: 0,
        input_multiline: false,
        nicklist: false,
        nicklist_case_sensitive: false,
        nicklist_display_groups: false,
        time_displayed: false,
        local_variables: { type: 'query', plugin: 'irc', server, nick: 'alice' },
        keys: [],
        last_read_line_id: -1,
    };
}

function event(name: string, body: unknown, bodyType: string, bufferId: ApiBufferId): ApiSessionEvent {
    return { event_name: name, buffer_id: bufferId, body_type: bodyType, body };
}

let reducers: ApiReducers;

beforeEach(() => {
    buffers.set({});
    activeBufferId.set('');
    pendingBufferSwitch.set(null);
    reducers = createApiStoreReducers();
});

describe('pending query navigation on the API transport', () => {
    it('ignores a same-nick query buffer from another IRC server', () => {
        pendingBufferSwitch.set(newPendingSwitch('alice', 'alpha'));

        dispatchEvent(event('buffer_opened', wireBuffer(BETA_ID, 'beta'), 'buffer', BETA_ID), reducers);

        expect(get(activeBufferId)).toBe('');
        expect(get(pendingBufferSwitch)!.nick).toBe('alice');
        expect(get(buffers)[String(BETA_ID)]).toBeDefined();
    });

    it('switches once the buffer from the requested server opens', () => {
        pendingBufferSwitch.set(newPendingSwitch('alice', 'alpha'));

        dispatchEvent(event('buffer_opened', wireBuffer(BETA_ID, 'beta'), 'buffer', BETA_ID), reducers);
        dispatchEvent(event('buffer_opened', wireBuffer(ALPHA_ID, 'alpha'), 'buffer', ALPHA_ID), reducers);
        expect(get(activeBufferId)).toBe(String(ALPHA_ID));
        expect(get(pendingBufferSwitch)).toBeNull();
    });

    it('matches any server when the request has no server context', () => {
        pendingBufferSwitch.set(newPendingSwitch('alice', null));

        dispatchEvent(event('buffer_opened', wireBuffer(BETA_ID, 'beta'), 'buffer', BETA_ID), reducers);

        expect(get(activeBufferId)).toBe(String(BETA_ID));
        expect(get(pendingBufferSwitch)).toBeNull();
    });

    it('ignores a buffer whose short name is not the requested nick', () => {
        pendingBufferSwitch.set(newPendingSwitch('alice', 'alpha'));

        dispatchEvent(event('buffer_opened', {
            ...wireBuffer(ALPHA_ID, 'alpha'),
            short_name: 'other',
            name: 'irc.alpha.other',
        }, 'buffer', ALPHA_ID), reducers);

        expect(get(activeBufferId)).toBe('');
        expect(get(pendingBufferSwitch)!.nick).toBe('alice');
    });
});

describe('pending query navigation on the legacy transport', () => {
    // The legacy protocol keys buffers by pointer, so each buffer needs its own.
    const legacyMessage = (pointer: string, fullName: string, server: string): ProtocolMessage => ({
        id: pointer,
        objects: [{
            pointer,
            content: [{
                pointers: [pointer],
                full_name: fullName,
                short_name: 'alice',
                title: [],
                hidden: 0,
                number: 3,
                type: 0,
                local_variables: { type: 'query', plugin: 'irc', server, nick: 'alice' },
            } as BufferMessage],
        }],
    });

    it('does not switch for a same-nick buffer on another server', () => {
        pendingBufferSwitch.set(newPendingSwitch('alice', 'alpha'));

        handleBufferOpened(legacyMessage('12', 'irc.beta.alice', 'beta'));

        expect(get(activeBufferId)).toBe('');
        expect(get(pendingBufferSwitch)!.nick).toBe('alice');
    });

    it('switches for the buffer in the requested server context', () => {
        pendingBufferSwitch.set(newPendingSwitch('alice', 'alpha'));

        handleBufferOpened(legacyMessage('12', 'irc.beta.alice', 'beta'));
        handleBufferOpened(legacyMessage('11', 'irc.alpha.alice', 'alpha'));

        expect(get(activeBufferId)).toBe('11');
    });
});

describe('request identity guards the click timeout', () => {
    it('an older request timeout cannot clear a newer pending request', () => {
        const older = newPendingSwitch('alice', 'alpha');
        pendingBufferSwitch.set(older);
        const newer = newPendingSwitch('bob', 'beta');
        pendingBufferSwitch.set(newer);

        clearPendingSwitchIfCurrent(older.requestId);
        expect(get(pendingBufferSwitch)).toEqual(newer);

        clearPendingSwitchIfCurrent(newer.requestId);
        expect(get(pendingBufferSwitch)).toBeNull();
    });
});
