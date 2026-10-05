// Phase 7 store-reducer tests: the ApiReducers implementation applied to the
// real models.ts stores, including bootstrap/event interleavings and the
// sync-phase tally gates.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { get } from 'svelte/store';
import {
    buffers, servers, activeBufferId, previousBufferId, localUnreadBuffers,
    beginSyncPhase, endSyncPhase, isSyncing, getEffectiveUnread,
} from '#lib/stores/models.ts';
import { createApiStoreReducers, storeKeyForBufferId } from '#lib/api/api-store-reducers.ts';
import { dispatchEvent } from '#lib/api/api-mapping.ts';
import type { ApiReducers, BufferSnapshot, LineSnapshot, HotlistSnapshot } from '#lib/api/api-contracts.ts';
import type { ApiSessionEvent } from '#lib/api/api-session.ts';
import type { ApiBufferId, ApiLineId } from '#lib/api/api-ids.ts';

const BUFFER_ID = 1759000000000001 as ApiBufferId;
const KEY = String(BUFFER_ID);

function bufferSnap(overrides: Partial<BufferSnapshot> = {}): BufferSnapshot {
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
        ...overrides,
    };
}

function lineSnap(id: number, overrides: Partial<LineSnapshot> = {}): LineSnapshot {
    return {
        id: id as ApiLineId,
        epochMs: Date.parse('2026-10-04T12:00:00.000Z'),
        displayed: true,
        highlight: false,
        notifyLevel: 1,
        prefix: '',
        message: `msg ${id}`,
        tags: ['notify_message'],
        ...overrides,
    };
}

function event(name: string, body: unknown, bodyType: string | null = null, bufferId: number = BUFFER_ID): ApiSessionEvent {
    return { event_name: name, buffer_id: bufferId, body_type: bodyType, body };
}

const WIRE_BUFFER = {
    id: BUFFER_ID, name: 'irc.glowing-bear.#chan', short_name: '#chan', number: 2,
    type: 'formatted', hidden: false, title: '#chan', modes: '', input_prompt: '<nicks>',
    input: '', input_position: 0, input_multiline: false, nicklist: true,
    nicklist_case_sensitive: false, nicklist_display_groups: true, time_displayed: true,
    local_variables: { type: 'channel', plugin: 'irc', server: 'glowing-bear', channel: '#chan' },
    keys: [], last_read_line_id: -1,
};
const WIRE_LINE = (id: number, extra: Record<string, unknown> = {}) => ({
    id, y: id, date: '2026-10-04T12:00:00.000Z', date_printed: '2026-10-04T12:00:00.000Z',
    displayed: true, highlight: false, notify_level: 1, prefix: 'alice', message: `msg ${id}`,
    tags: ['notify_message'], ...extra,
});

let reducers: ApiReducers;

beforeEach(() => {
    buffers.set({});
    servers.set({});
    activeBufferId.set('');
    previousBufferId.set('');
    localUnreadBuffers.update(() => new Set());
    // Close any sync phase left open by a previous test.
    endSyncPhase();
    reducers = createApiStoreReducers();
});

describe('buffers + identity', () => {
    it('creates buffers keyed by String(apiBufferId) with apiBufferId authoritative', () => {
        reducers.buffers([bufferSnap()]);
        const store = get(buffers);
        expect(store[KEY]).toBeDefined();
        expect(store[KEY]!.id).toBe(KEY);
        expect(store[KEY]!.apiBufferId).toBe(BUFFER_ID);
        expect(store[KEY]!.type).toBe('channel');
        expect(storeKeyForBufferId(BUFFER_ID)).toBe(KEY);
    });

    it('upserts metadata without dropping lines or local state', () => {
        reducers.buffers([bufferSnap()]);
        reducers.lineAdded(BUFFER_ID, lineSnap(10));
        reducers.buffers([bufferSnap({ title: 'renamed', localVariables: { ...bufferSnap().localVariables, pinned: 'true' } })]);
        const buf = get(buffers)[KEY]!;
        expect(buf.rtitle).toBe('renamed');
        expect(buf.pinned).toBe(true);
        expect(buf.lines).toHaveLength(1);
    });

    it('free buffers map to hideBufferLineTimes', () => {
        reducers.buffers([bufferSnap({ contentType: 'free', name: 'python.eval' })]);
        expect(get(buffers)[KEY]!.hideBufferLineTimes).toBe(true);
    });
});

describe('buffer_opened bootstrap', () => {
    it('applies initial lines and the nick tree through the event path', () => {
        reducers.buffers([bufferSnap()]);
        dispatchEvent(event('buffer_opened', {
            ...WIRE_BUFFER,
            lines: [WIRE_LINE(101), WIRE_LINE(102)],
            nicklist_root: {
                id: 0, parent_group_id: -1, name: '', color_name: '', color: '', visible: true,
                groups: [{ id: 5, parent_group_id: 0, name: 'ops', color_name: '', color: '', visible: true, groups: [], nicks: [] }],
                nicks: [{ id: 9, parent_group_id: 0, prefix: '', prefix_color_name: '', prefix_color: '', name: 'alice', color_name: 'white', color: '7', visible: true }],
            },
        }, 'buffer'), reducers);
        const buf = get(buffers)[KEY]!;
        expect(buf.lines.map((l) => l.lineId)).toEqual(['weechat:101', 'weechat:102']);
        expect(Object.keys(buf.nicklist)).toEqual(['root', 'ops']);
        expect(buf.nicklist['root']!.nicks[0]!.name).toBe('alice');
        expect(buf.nicklist['root']!.nicks[0]!.nickId).toBe(9);
    });

    it('nick lifecycle events locate nicks by api id', () => {
        reducers.buffers([bufferSnap()]);
        dispatchEvent(event('nicklist_nick_changed', {
            id: 42, parent_group_id: 0, prefix: '@', prefix_color_name: '', prefix_color: '',
            name: 'bob', color_name: '', color: '', visible: true,
        }, 'nick'), reducers);
        dispatchEvent(event('nicklist_nick_changed', {
            id: 42, parent_group_id: 0, prefix: '@', prefix_color_name: '', prefix_color: '',
            name: 'bob', color_name: '', color: '', visible: false,
        }, 'nick'), reducers);
        let buf = get(buffers)[KEY]!;
        expect(buf.nicklist['root']!.nicks).toHaveLength(1);
        expect(buf.nicklist['root']!.nicks[0]!.visible).toBe('0');
        dispatchEvent(event('nicklist_nick_removing', 42), reducers);
        buf = get(buffers)[KEY]!;
        expect(buf.nicklist['root']!.nicks).toHaveLength(0);
    });
});

describe('line tally gates (ported legacy rules)', () => {
    it('does not tally while the sync phase is open and the boundary is unknown', () => {
        const token = beginSyncPhase();
        reducers.buffers([bufferSnap({ lastReadLineId: -1 })]);
        activeBufferId.set(''); // bootstrap auto-selects a default; tally needs an inactive buffer
        // lastReadLineId -1 marks the boundary known; force the unknown case:
        get(buffers)[KEY]!.readBoundaryKnown = false;
        reducers.lineAdded(BUFFER_ID, lineSnap(1));
        const buf = get(buffers)[KEY]!;
        expect(buf.localUnread).toBe(0);
        expect(buf.unread).toBe(0);
        endSyncPhase(token);
        reducers.lineAdded(BUFFER_ID, lineSnap(2));
        expect(get(buffers)[KEY]!.localUnread).toBe(1);
    });

    it('active buffer never tallies', () => {
        reducers.buffers([bufferSnap()]);
        activeBufferId.set(KEY);
        reducers.lineAdded(BUFFER_ID, lineSnap(1, { notifyLevel: 3, highlight: true, tags: ['notify_highlight'] }));
        const buf = get(buffers)[KEY]!;
        expect(buf.localUnread).toBe(0);
        expect(buf.notification).toBe(0);
    });

    it('notify_level 1 increments unread and server totals; >=2 with highlight increments notification', () => {
        reducers.buffers([bufferSnap()]);
        activeBufferId.set('');
        reducers.lineAdded(BUFFER_ID, lineSnap(1));
        reducers.lineAdded(BUFFER_ID, lineSnap(2, { notifyLevel: 3, highlight: true, tags: ['notify_highlight'] }));
        const buf = get(buffers)[KEY]!;
        expect(buf.unread).toBe(1);
        expect(buf.notification).toBe(1);
        expect(buf.localUnread).toBe(2);
        expect(get(servers)['irc.glowing-bear']!.unread).toBe(2);
    });

    it('lineDataChanged replaces the line in place by weechat:<id>', () => {
        reducers.buffers([bufferSnap()]);
        reducers.lineAdded(BUFFER_ID, lineSnap(7));
        reducers.lineAdded(BUFFER_ID, lineSnap(8));
        reducers.lineDataChanged(BUFFER_ID, lineSnap(7, { message: 'edited', notifyLevel: 0, tags: [] }));
        const buf = get(buffers)[KEY]!;
        expect(buf.lines).toHaveLength(2);
        expect(buf.lines[0]!.text).toBe('edited');
        expect(buf.lines[0]!.lineId).toBe('weechat:7');
    });

    it('lines for unsynced buffers are ignored without crashing', () => {
        reducers.lineAdded(999 as ApiBufferId, lineSnap(1));
        expect(get(buffers)[String(999)]).toBeUndefined();
    });

    it('skips smart-filtered lines (irc_smart_filter tag or displayed:false) — no render, no tally', () => {
        reducers.buffers([bufferSnap()]);
        activeBufferId.set('');
        reducers.lineAdded(BUFFER_ID, lineSnap(1, { tags: ['irc_privmsg', 'irc_smart_filter'] }));
        reducers.lineAdded(BUFFER_ID, lineSnap(2, { displayed: false }));
        reducers.lineAdded(BUFFER_ID, lineSnap(3));
        const buf = get(buffers)[KEY]!;
        expect(buf.lines.map((l) => l.lineId)).toEqual(['weechat:3']);
        expect(buf.localUnread).toBe(1); // only the unfiltered line is tallied
    });
});

describe('buffer notify level (WeeChat >= 5.0.0)', () => {
    it('defaults to all (3) when the server does not report notify', () => {
        reducers.buffers([bufferSnap()]);
        expect(get(buffers)[KEY]!.notify).toBe(3);
    });

    it('applies notify from snapshots and buffer_notify_changed events', () => {
        reducers.buffers([bufferSnap({ notify: 1 })]);
        expect(get(buffers)[KEY]!.notify).toBe(1);
        reducers.bufferNotifyChanged(BUFFER_ID, 0);
        expect(get(buffers)[KEY]!.notify).toBe(0);
        reducers.bufferNotifyChanged(999 as ApiBufferId, 2); // unknown buffer: no crash
    });

    it('muted buffer (notify none) tallies no unread or notification counts', () => {
        reducers.buffers([bufferSnap({ notify: 0 })]);
        activeBufferId.set(''); // bootstrap auto-selects; tally needs an inactive buffer
        reducers.lineAdded(BUFFER_ID, lineSnap(1));
        reducers.lineAdded(BUFFER_ID, lineSnap(2, { notifyLevel: 3, highlight: true, tags: ['notify_highlight'] }));
        const buf = get(buffers)[KEY]!;
        expect(buf.unread).toBe(0);
        expect(buf.notification).toBe(0);
        expect(get(servers)['irc.glowing-bear']?.unread ?? 0).toBe(0); // no server totals at all
    });

    it('highlight-notify buffer counts highlights but not plain messages', () => {
        reducers.buffers([bufferSnap({ notify: 1 })]);
        activeBufferId.set('');
        reducers.lineAdded(BUFFER_ID, lineSnap(1));
        reducers.lineAdded(BUFFER_ID, lineSnap(2, { notifyLevel: 3, highlight: true, tags: ['notify_highlight'] }));
        const buf = get(buffers)[KEY]!;
        expect(buf.unread).toBe(0); // message priority needs notify >= 2
        expect(buf.notification).toBe(1); // highlight needs notify >= 1
    });

    it('buffer_opened snapshot carries notify through to the tally gate', () => {
        dispatchEvent(event('buffer_opened', { ...WIRE_BUFFER, notify: 'none' }, 'buffer'), reducers);
        const buf = get(buffers)[KEY]!;
        expect(buf.notify).toBe(0);
        activeBufferId.set('');
        reducers.lineAdded(BUFFER_ID, lineSnap(1, { notifyLevel: 3, highlight: true, tags: ['notify_highlight'] }));
        expect(get(buffers)[KEY]!.notification).toBe(0);
    });

});

describe('hotlist baseline', () => {
    it('applies server counts and preserves separately modeled localUnread', () => {
        reducers.buffers([bufferSnap()]);
        activeBufferId.set('');
        reducers.lineAdded(BUFFER_ID, lineSnap(1)); // localUnread 1, unread 1
        const map = new Map<ApiBufferId, HotlistSnapshot>([[BUFFER_ID, {
            priority: 3,
            counts: { low: 0, message: 5, private: 1, highlight: 2 },
        }]]);
        reducers.hotlist(map);
        const buf = get(buffers)[KEY]!;
        expect(buf.unread).toBe(5);
        expect(buf.notification).toBe(3);
        expect(buf.localUnread).toBe(1);
        expect(getEffectiveUnread(buf)).toBeGreaterThanOrEqual(5);
    });

    it('skips active and previous buffers (setActiveBuffer owns them)', () => {
        reducers.buffers([bufferSnap()]);
        activeBufferId.set(KEY);
        reducers.hotlist(new Map([[BUFFER_ID, { priority: 1, counts: { low: 0, message: 9, private: 0, highlight: 0 } }]]));
        expect(get(buffers)[KEY]!.unread).toBe(0);
    });

    it('unknown boundary with counts records pendingReadBoundaryUnread', () => {
        reducers.buffers([bufferSnap()]);
        activeBufferId.set('');
        get(buffers)[KEY]!.readBoundaryKnown = false;
        reducers.hotlist(new Map([[BUFFER_ID, { priority: 2, counts: { low: 0, message: 4, private: 0, highlight: 0 } }]]));
        expect(get(buffers)[KEY]!.pendingReadBoundaryUnread).toBe(4);
    });
});

describe('bootstrap default + resume selection', () => {
    it('defaults to core.weechat, not the first buffer', () => {
        reducers.buffers([
            bufferSnap({ id: 1 as ApiBufferId, name: 'irc.s.#a', shortName: '#a' }),
            bufferSnap({ id: 2 as ApiBufferId, name: 'core.weechat', shortName: 'weechat' }),
        ]);
        expect(get(activeBufferId)).toBe('2');
    });

    it('falls back to the first buffer when there is no core buffer', () => {
        reducers.buffers([bufferSnap({ id: 3 as ApiBufferId })]);
        expect(get(activeBufferId)).toBe('3');
    });

    it('resumes the saved buffer by full name over the core default', () => {
        localStorage.setItem('gb-last-buffer', 'irc.glowing-bear.#chan');
        reducers.buffers([
            bufferSnap({ id: 2 as ApiBufferId, name: 'core.weechat', shortName: 'weechat' }),
            bufferSnap({ id: 1 as ApiBufferId }),
        ]);
        expect(get(activeBufferId)).toBe('1');
        localStorage.removeItem('gb-last-buffer');
    });
});

describe('read marker + clear epoch', () => {
    it('last_read_line_id -1 means every retained line is unread (boundary known, id null)', () => {
        reducers.buffers([bufferSnap({ lastReadLineId: -1 })]);
        const buf = get(buffers)[KEY]!;
        expect(buf.readBoundaryKnown).toBe(true);
        expect(buf.readBoundaryId).toBeNull();
    });

    it('a read marker inside retained history sets a stable boundary', () => {
        reducers.buffers([bufferSnap()]);
        dispatchEvent(event('buffer_opened', {
            ...WIRE_BUFFER, lines: [WIRE_LINE(10), WIRE_LINE(11)], last_read_line_id: 10,
        }, 'buffer'), reducers);
        const buf = get(buffers)[KEY]!;
        expect(buf.readBoundaryKnown).toBe(true);
        expect(buf.readBoundaryId).toBe('weechat:10');
    });

    it('a read marker outside retained history leaves the boundary unknown', () => {
        reducers.buffers([bufferSnap()]);
        dispatchEvent(event('buffer_opened', {
            ...WIRE_BUFFER, lines: [WIRE_LINE(10)], last_read_line_id: 999,
        }, 'buffer'), reducers);
        expect(get(buffers)[KEY]!.readBoundaryKnown).toBe(false);
    });

    it('bufferCleared bumps the clear epoch and empties lines', () => {
        reducers.buffers([bufferSnap()]);
        reducers.lineAdded(BUFFER_ID, lineSnap(1));
        reducers.bufferCleared(BUFFER_ID);
        const buf = get(buffers)[KEY]!;
        expect(buf.lines).toHaveLength(0);
        expect(buf.clearEpoch).toBe(1);
        reducers.bufferCleared(BUFFER_ID);
        expect(get(buffers)[KEY]!.clearEpoch).toBe(2);
    });
});

describe('buffer lifecycle + localvars', () => {
    it('buffer_closed removes the buffer', () => {
        reducers.buffers([bufferSnap()]);
        dispatchEvent(event('buffer_closed', null), reducers);
        expect(get(buffers)[KEY]).toBeUndefined();
    });

    it('pinned localvar round-trips through set/remove', () => {
        reducers.buffers([bufferSnap()]);
        dispatchEvent(event('buffer_localvar_set', { name: 'pinned', value: 'true' }), reducers);
        expect(get(buffers)[KEY]!.pinned).toBe(true);
        dispatchEvent(event('buffer_localvar_removed', 'pinned'), reducers);
        expect(get(buffers)[KEY]!.pinned).toBe(false);
    });

    it('title changes re-parse rich text', () => {
        reducers.buffers([bufferSnap()]);
        dispatchEvent(event('buffer_title_changed', 'topic \u0019C*red*'), reducers);
        const buf = get(buffers)[KEY]!;
        expect(buf.rtitle).toContain('red');
        expect(buf.title.some((p) => p.classes?.length)).toBe(true);
    });

    it('invalid payloads never damage store state', () => {
        reducers.buffers([bufferSnap()]);
        dispatchEvent(event('buffer_line_added', { id: 'garbage' }, 'line'), reducers);
        expect(get(buffers)[KEY]!.lines).toHaveLength(0);
    });
});
