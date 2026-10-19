/**
 * Characterization tests for the four API nicklist reducers.
 *
 * They exist before the four share a store-update helper, so the helper can be
 * checked against what each one actually does today — including the parts that
 * look accidental rather than designed: a group rename resolves to a new key and
 * leaves the nicks behind, a nick whose group was never announced lands in the
 * root group, and an event naming a buffer this session does not have invents
 * nothing.
 *
 * Group ids are unique per test on purpose. The buffer→group-key map is
 * module state that outlives a buffer, so a reused id would carry one test's
 * registration into the next.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { get } from 'svelte/store';
import { buffers, activeBufferId } from '#lib/stores/models.ts';
import { createApiStoreReducers } from '#lib/api/api-store-reducers.ts';
import type { ApiReducers, BufferSnapshot, LineSnapshot, NickGroupSnapshot, NickSnapshot } from '#lib/api/api-contracts.ts';
import type { ApiBufferId, ApiGroupId, ApiLineId, ApiNickId } from '#lib/api/api-ids.ts';
import type { NickGroup } from '#lib/types.ts';

vi.mock('#lib/notifications.ts', () => ({
    createHighlight: vi.fn(),
    playNotificationSound: vi.fn(),
    updateTitle: vi.fn(),
    updateFavico: vi.fn(),
    startIndicatorOwner: () => () => {},
    refreshIndicators: vi.fn(),
}));

const BUFFER_ID = 1759000000000001 as ApiBufferId;
const KEY = String(BUFFER_ID);

let reducers: ApiReducers;

function bufferSnap(): BufferSnapshot {
    return {
        id: BUFFER_ID,
        name: 'irc.glowing-bear.#chan',
        shortName: '#chan',
        number: 2,
        contentType: 'formatted',
        semanticType: 'channel',
        hidden: false,
        title: '#chan',
        localVariables: { type: 'channel', plugin: 'irc', server: 'glowing-bear', channel: '#chan' },
        lastReadLineId: -1,
    };
}

function groupSnap(id: number, overrides: Partial<NickGroupSnapshot> = {}): NickGroupSnapshot {
    return {
        id: id as ApiGroupId,
        parentGroupId: -1,
        name: '',
        colorName: '',
        color: '',
        visible: true,
        ...overrides,
    };
}

function nickSnap(id: number, parentGroupId: number, overrides: Partial<NickSnapshot> = {}): NickSnapshot {
    return {
        id: id as ApiNickId,
        parentGroupId: parentGroupId as ApiGroupId,
        prefix: '',
        prefixColorName: '',
        prefixColor: '',
        name: `nick${id}`,
        colorName: '',
        color: '',
        visible: true,
        ...overrides,
    };
}

function lineSnap(id: number): LineSnapshot {
    return {
        id: id as ApiLineId,
        epochMs: Date.parse('2026-10-04T12:00:00.000Z'),
        displayed: true,
        highlight: false,
        notifyLevel: 1,
        prefix: '',
        message: `msg ${id}`,
        tags: ['notify_message'],
    };
}

function groupMap(): Record<string, NickGroup> {
    return get(buffers)[KEY]!.nicklist;
}

/** Display order as the nicklist renders it: prefix glued to name. */
function nicksIn(key: string): string[] {
    return (groupMap()[key]?.nicks ?? []).map((n) => `${n.prefix}${n.name}`);
}

describe('API nicklist reducers', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        buffers.set({});
        activeBufferId.set('');
        reducers = createApiStoreReducers();
        reducers.buffers([bufferSnap()]);
    });

    it('stores a group under its name, and a nameless group as the root group', () => {
        reducers.nickGroupChanged(BUFFER_ID, groupSnap(11, { name: 'opers' }));
        reducers.nickGroupChanged(BUFFER_ID, groupSnap(12, { name: '' }));

        expect(Object.keys(groupMap()).sort()).toEqual(['opers', 'root']);
    });

    it('nickGroupChanged is an upsert: a second event updates the group it registered', () => {
        reducers.nickGroupChanged(BUFFER_ID, groupSnap(13, { name: 'opers', visible: true }));
        reducers.nickGroupChanged(BUFFER_ID, groupSnap(13, { name: 'opers', visible: false }));

        expect(Object.keys(groupMap())).toEqual(['opers']);
        expect(groupMap()['opers']!.visible).toBe('0');
    });

    it('a group rename registers a new key and leaves the old group holding the nicks', () => {
        const group = groupSnap(14, { name: 'opers' });
        reducers.nickGroupChanged(BUFFER_ID, group);
        reducers.nickChanged(BUFFER_ID, nickSnap(201, 14, { name: 'alice' }));

        reducers.nickGroupChanged(BUFFER_ID, { ...group, name: 'halfops' });

        // Both keys survive, and the nicks stayed where they were registered.
        expect(Object.keys(groupMap()).sort()).toEqual(['halfops', 'opers']);
        expect(nicksIn('opers')).toEqual(['alice']);
        expect(nicksIn('halfops')).toEqual([]);
    });

    it('nickChanged re-ranks the group after a prefix change', () => {
        reducers.nickGroupChanged(BUFFER_ID, groupSnap(15, { name: '' }));
        reducers.nickChanged(BUFFER_ID, nickSnap(301, 15, { name: 'bob' }));
        reducers.nickChanged(BUFFER_ID, nickSnap(302, 15, { name: 'carol' }));
        reducers.nickChanged(BUFFER_ID, nickSnap(303, 15, { name: 'alice', prefix: '@' }));

        // ops, halfops, voices, the rest — alphabetical within each rank.
        expect(nicksIn('root')).toEqual(['@alice', 'bob', 'carol']);
    });

    it('nickChanged replaces the nick holding that id instead of adding a second one', () => {
        reducers.nickGroupChanged(BUFFER_ID, groupSnap(16, { name: '' }));
        reducers.nickChanged(BUFFER_ID, nickSnap(304, 16, { name: 'alice' }));
        reducers.nickChanged(BUFFER_ID, nickSnap(304, 16, { name: 'alice', prefix: '+' }));

        expect(nicksIn('root')).toEqual(['+alice']);
    });

    it('a nick whose group was never announced lands in the root group', () => {
        reducers.nickChanged(BUFFER_ID, nickSnap(305, 17, { name: 'alice' }));

        expect(Object.keys(groupMap())).toEqual(['root']);
        expect(nicksIn('root')).toEqual(['alice']);
    });

    it('nickRemoved finds the nick in whichever group holds it', () => {
        reducers.nickGroupChanged(BUFFER_ID, groupSnap(18, { name: 'opers' }));
        reducers.nickGroupChanged(BUFFER_ID, groupSnap(19, { name: 'voices' }));
        reducers.nickChanged(BUFFER_ID, nickSnap(401, 18, { name: 'alice' }));
        reducers.nickChanged(BUFFER_ID, nickSnap(402, 19, { name: 'bob', prefix: '+' }));

        reducers.nickRemoved(BUFFER_ID, 401);

        expect(nicksIn('opers')).toEqual([]);
        expect(nicksIn('voices')).toEqual(['+bob']);
    });

    it('nickRemoved for a nick this buffer does not hold changes nothing', () => {
        reducers.nickGroupChanged(BUFFER_ID, groupSnap(20, { name: 'opers' }));
        reducers.nickChanged(BUFFER_ID, nickSnap(403, 20, { name: 'alice' }));

        reducers.nickRemoved(BUFFER_ID, 999_999);

        expect(nicksIn('opers')).toEqual(['alice']);
    });

    it('nickGroupRemoved drops the group along with its key registration', () => {
        reducers.nickGroupChanged(BUFFER_ID, groupSnap(21, { name: 'opers' }));
        reducers.nickChanged(BUFFER_ID, nickSnap(404, 21, { name: 'alice' }));

        reducers.nickGroupRemoved(BUFFER_ID, 21);

        expect(groupMap()['opers']).toBeUndefined();
        // The registration is gone too, so the same group id arriving again
        // resolves to the root group rather than back to 'opers'.
        reducers.nickChanged(BUFFER_ID, nickSnap(405, 21, { name: 'bob' }));
        expect(Object.keys(groupMap())).toEqual(['root']);
        expect(nicksIn('root')).toEqual(['bob']);
    });

    it('a nick event leaves the rest of the buffer alone', () => {
        reducers.nickGroupChanged(BUFFER_ID, groupSnap(22, { name: 'opers' }));
        reducers.nickChanged(BUFFER_ID, nickSnap(406, 22, { name: 'alice' }));

        const buffer = get(buffers)[KEY]!;
        expect(buffer.lines).toHaveLength(0);
        expect(buffer.localUnread).toBe(0);
        expect(buffer.newestWindowFetched).toBe(false);
        expect(buffer.allLinesFetched).toBe(false);
    });

    it('a nick event commits the lines queued before it', () => {
        // Lines are queued and flushed once per frame. Every reducer that mutates
        // the store flushes that queue first, so a mutation never lands on a
        // buffer a queued line is about to replace.
        reducers.lineAdded(BUFFER_ID, lineSnap(501));
        expect(get(buffers)[KEY]!.lines, 'the line is queued, not applied').toHaveLength(0);

        reducers.nickGroupChanged(BUFFER_ID, groupSnap(24, { name: 'opers' }));

        expect(get(buffers)[KEY]!.lines).toHaveLength(1);
    });

    it.each([
        ['nickGroupChanged', (r: ApiReducers) => r.nickGroupChanged(999 as ApiBufferId, groupSnap(23, { name: 'opers' }))],
        ['nickGroupRemoved', (r: ApiReducers) => r.nickGroupRemoved(999 as ApiBufferId, 23)],
        ['nickChanged', (r: ApiReducers) => r.nickChanged(999 as ApiBufferId, nickSnap(407, 23, { name: 'alice' }))],
        ['nickRemoved', (r: ApiReducers) => r.nickRemoved(999 as ApiBufferId, 407)],
    ])('%s for a buffer this session does not have invents nothing', (_name, apply) => {
        apply(reducers);

        expect(get(buffers)['999'], 'no buffer was created for an id this session never saw')
            .toBeUndefined();
        expect(Object.keys(groupMap()), 'the buffer this session does have is untouched')
            .toEqual([]);
    });
});
