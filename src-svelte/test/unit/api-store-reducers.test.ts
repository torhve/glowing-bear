// Phase 7 store-reducer tests: the ApiReducers implementation applied to the
// real models.ts stores, including bootstrap/event interleavings and the
// sync-phase tally gates.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { get } from 'svelte/store';
import {
    buffers, servers, activeBufferId, previousBufferId, localUnreadBuffers,
    beginSyncPhase, endSyncPhase, isSyncing, getEffectiveUnread, getReadBoundaryIndex,
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

    it('free buffers map to bufferType 1 and hideBufferLineTimes', () => {
        reducers.buffers([bufferSnap({ contentType: 'free', name: 'python.eval' })]);
        expect(get(buffers)[KEY]!.bufferType).toBe(1);
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
        dispatchEvent(event('nicklist_nick_removing', { id: 42, parent_group_id: 0, prefix: '@', prefix_color_name: '', prefix_color: '', name: 'bob', color_name: '', color: '', visible: true }, 'nick'), reducers);
        buf = get(buffers)[KEY]!;
        expect(buf.nicklist['root']!.nicks).toHaveLength(0);
    });

    // Production churn captured live on 4.10.1: every part/join emits
    // nicklist_nick_removing (full object, old id) followed by
    // nicklist_nick_added (full object, NEW id). Both must land or the
    // nicklist UI drifts after each churn.
    it('part/join churn removes the old id and re-adds the new id', () => {
        reducers.buffers([bufferSnap()]);
        dispatchEvent(event('nicklist_nick_added', {
            id: 100, parent_group_id: 0, prefix: ' ', prefix_color_name: '', prefix_color: '',
            name: 'gbbot2', color_name: '', color: '', visible: true,
        }, 'nick'), reducers);
        dispatchEvent(event('nicklist_nick_removing', {
            id: 100, parent_group_id: 0, prefix: ' ', prefix_color_name: '', prefix_color: '',
            name: 'gbbot2', color_name: '', color: '', visible: true,
        }, 'nick'), reducers);
        expect(get(buffers)[KEY]!.nicklist['root']!.nicks).toHaveLength(0);
        dispatchEvent(event('nicklist_nick_added', {
            id: 200, parent_group_id: 0, prefix: '@', prefix_color_name: '', prefix_color: '',
            name: 'gbbot2', color_name: '', color: '', visible: true,
        }, 'nick'), reducers);
        const nicks = get(buffers)[KEY]!.nicklist['root']!.nicks;
        expect(nicks).toHaveLength(1);
        expect(nicks[0]!.nickId).toBe(200);
        expect(nicks[0]!.prefix).toBe('@');
    });

    // Live 4.10.1: every buffer_* change event carries a full buffer snapshot.
    // localvar removal does not name the variable — the remaining map wins.
    it('bufferUpdated merges snapshot metadata without touching lines', () => {
        reducers.buffers([bufferSnap()]);
        dispatchEvent(event('buffer_line_added', WIRE_LINE(50), 'line'), reducers);

        dispatchEvent(event('buffer_title_changed', { ...WIRE_BUFFER, title: 'New topic' }, 'buffer'), reducers);
        expect(get(buffers)[KEY]!.rtitle).toBe('New topic');

        dispatchEvent(event('buffer_localvar_added', {
            ...WIRE_BUFFER, local_variables: { ...WIRE_BUFFER.local_variables, pinned: 'true' },
        }, 'buffer'), reducers);
        expect(get(buffers)[KEY]!.pinned).toBe(true);

        // Removal: body lists what REMAINS — pinned is gone even though the
        // event never names it.
        dispatchEvent(event('buffer_localvar_removed', {
            ...WIRE_BUFFER, local_variables: { type: 'channel', plugin: 'irc', server: 'glowing-bear', channel: '#chan' },
        }, 'buffer'), reducers);
        const afterRemove = get(buffers)[KEY]!;
        expect(afterRemove.pinned).toBe(false);
        expect(afterRemove.localVariables!.pinned).toBeUndefined();

        dispatchEvent(event('buffer_hidden', { ...WIRE_BUFFER, hidden: true }, 'buffer'), reducers);
        expect(get(buffers)[KEY]!.hidden).toBe(true);

        dispatchEvent(event('buffer_renamed', { ...WIRE_BUFFER, name: 'irc.glowing-bear.#new', short_name: '#new' }, 'buffer'), reducers);
        expect(get(buffers)[KEY]!.shortName).toBe('#new');

        dispatchEvent(event('buffer_type_changed', { ...WIRE_BUFFER, type: 'free' }, 'buffer'), reducers);
        expect(get(buffers)[KEY]!.bufferType).toBe(1);
        expect(get(buffers)[KEY]!.hideBufferLineTimes).toBe(true);
        expect(get(buffers)[KEY]!.type).toBe('channel'); // semantic type survives

        // Metadata-only: the line from before survives untouched.
        expect(get(buffers)[KEY]!.lines.map((l) => l.lineId)).toEqual(['weechat:50']);
    });

    it('free→formatted transition reverses bufferType and time hiding', () => {
        reducers.buffers([bufferSnap({ contentType: 'free', name: 'python.eval' })]);
        expect(get(buffers)[KEY]!.bufferType).toBe(1);
        dispatchEvent(event('buffer_type_changed', { ...WIRE_BUFFER, type: 'formatted' }, 'buffer'), reducers);
        expect(get(buffers)[KEY]!.bufferType).toBe(0);
        expect(get(buffers)[KEY]!.hideBufferLineTimes).toBe(false);
    });

    // Legacy parity (handlers.ts): semantic type/plugin/server fall back to
    // the previous value when the authoritative snapshot no longer carries
    // the localvar — creation defaults must not clobber a live buffer.
    it('semantic fields survive localvar removal; pinned is recomputed', () => {
        reducers.buffers([bufferSnap()]);
        expect(get(buffers)[KEY]!.type).toBe('channel');
        dispatchEvent(event('buffer_localvar_removed', {
            ...WIRE_BUFFER, local_variables: {},
        }, 'buffer'), reducers);
        const buf = get(buffers)[KEY]!;
        expect(buf.type).toBe('channel');
        expect(buf.plugin).toBe('irc');
        expect(buf.server).toBe('glowing-bear');
        expect(buf.localVariables).toBeUndefined(); // empty map → undefined
        expect(buf.pinned).toBe(false);
    });

    it('bufferUpdated preserves nicklist entries', () => {
        reducers.buffers([bufferSnap()]);
        reducers.nickChanged(BUFFER_ID, {
            id: 300, group: 1, name: 'alice', prefix: '', suffix: '',
            flags: 0, visible: true, color: null, tags: {},
        });
        dispatchEvent(event('buffer_title_changed', { ...WIRE_BUFFER, title: 't' }, 'buffer'), reducers);
        const nicks = Object.values(get(buffers)[KEY]!.nicklist).flatMap((g) => g.nicks);
        expect(nicks.map((n) => n.nickId)).toEqual([300]);
    });
});

describe('line tally gates (ported legacy rules)', () => {
    it('badges live lines while the sync phase is open, deferring server counts', () => {
        const token = beginSyncPhase();
        reducers.buffers([bufferSnap({ lastReadLineId: -1 })]);
        activeBufferId.set(''); // bootstrap auto-selects a default; tally needs an inactive buffer
        // lastReadLineId -1 marks the boundary known; force the unknown case:
        get(buffers)[KEY]!.readBoundaryKnown = false;
        reducers.lineAdded(BUFFER_ID, lineSnap(1));
        const buf = get(buffers)[KEY]!;
        // Alert ⇒ badge invariant: the badge tally is never gated (the alert
        // path rings for these lines too); only the boundary-resolution
        // counters stay deferred to the baseline.
        expect(buf.localUnread).toBe(1);
        expect(buf.unread).toBe(0);
        endSyncPhase(token);
        reducers.lineAdded(BUFFER_ID, lineSnap(2));
        expect(get(buffers)[KEY]!.localUnread).toBe(2);
        expect(get(buffers)[KEY]!.unread).toBe(1);
    });

    it('baseline max-merges with a badge tally that raced past it, without inflation', () => {
        const token = beginSyncPhase();
        reducers.buffers([bufferSnap({ lastReadLineId: -1 })]);
        activeBufferId.set('');
        get(buffers)[KEY]!.readBoundaryKnown = false;
        // A highlight races in live before the hotlist baseline is applied...
        reducers.lineAdded(BUFFER_ID, lineSnap(1, { notifyLevel: 3, highlight: true, tags: ['notify_highlight'] }));
        // ...and the baseline (generated after the line) already includes it.
        reducers.hotlist(new Map([[BUFFER_ID, { priority: 3, counts: { low: 0, message: 0, private: 0, highlight: 1 } }]]));
        const buf = get(buffers)[KEY]!;
        expect(buf.notification).toBe(1);
        expect(buf.localUnread).toBe(1);
        // getEffectiveUnread max-merges: the badge shows 1, never 2.
        expect(getEffectiveUnread(buf)).toBe(1);
        endSyncPhase(token);
    });

    it('poll converges a disjoint baseline+race count after the sync phase', () => {
        const token = beginSyncPhase();
        reducers.buffers([bufferSnap({ lastReadLineId: -1 })]);
        activeBufferId.set('');
        get(buffers)[KEY]!.readBoundaryKnown = false;
        // Baseline covers two lines this client never saw live (arrived before
        // sync)...
        reducers.hotlist(new Map([[BUFFER_ID, { priority: 1, counts: { low: 0, message: 2, private: 0, highlight: 0 } }]]));
        // ...and a third line races in after the baseline was generated.
        reducers.lineAdded(BUFFER_ID, lineSnap(3));
        let buf = get(buffers)[KEY]!;
        // Transiently max(2, 1) = 2: the badge is visible (alert ⇒ badge) even
        // though the disjoint counts undercount until the next poll.
        expect(getEffectiveUnread(buf)).toBe(2);
        endSyncPhase(token);
        // The periodic poll re-reads the hotlist, which now counts all three.
        reducers.hotlist(new Map([[BUFFER_ID, { priority: 1, counts: { low: 0, message: 3, private: 0, highlight: 0 } }]]));
        buf = get(buffers)[KEY]!;
        expect(buf.unread).toBe(3);
        expect(getEffectiveUnread(buf)).toBe(3);
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
    it('last_read_line_id -1 means WeeChat has no marker: the boundary stays unknown', () => {
        reducers.buffers([bufferSnap({ lastReadLineId: -1 })]);
        const buf = get(buffers)[KEY]!;
        // -1 is not evidence that every retained line is unread: unread counts
        // come from the hotlist, so no marker is shown until one is known.
        expect(buf.serverReadLineId).toBe(-1);
        expect(buf.readBoundaryKnown).toBe(false);
        expect(getReadBoundaryIndex(buf)).toBeNull();
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
        dispatchEvent(event('buffer_localvar_added', { ...WIRE_BUFFER, local_variables: { ...WIRE_BUFFER.local_variables, pinned: 'true' } }, 'buffer'), reducers);
        expect(get(buffers)[KEY]!.pinned).toBe(true);
        // Removal names no variable: the remaining map is authoritative.
        dispatchEvent(event('buffer_localvar_removed', { ...WIRE_BUFFER, local_variables: WIRE_BUFFER.local_variables }, 'buffer'), reducers);
        expect(get(buffers)[KEY]!.pinned).toBe(false);
    });

    it('title changes re-parse rich text', () => {
        reducers.buffers([bufferSnap()]);
        dispatchEvent(event('buffer_title_changed', { ...WIRE_BUFFER, title: 'topic \u0019C*red*' }, 'buffer'), reducers);
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
