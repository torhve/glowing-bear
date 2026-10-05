import { describe, it, expect, vi } from 'vitest';
import {
    mapBuffer, mapLine, mapNickGroup, mapHotlistEntry,
    mapBufferList, mapHotlist, dispatchEvent,
} from '#lib/api/api-mapping.ts';
import type { ApiReducers } from '#lib/api/api-contracts.ts';
import type { ApiSessionEvent } from '#lib/api/api-session.ts';

function reducers(): ApiReducers {
    return {
        buffers: vi.fn(), bufferOpened: vi.fn(), bufferClosing: vi.fn(), bufferClosed: vi.fn(),
        bufferUpdated: vi.fn(), bufferNotifyChanged: vi.fn(), bufferInputChanged: vi.fn(), lineAdded: vi.fn(),
        lineDataChanged: vi.fn(), bufferCleared: vi.fn(), nickGroupChanged: vi.fn(),
        nickGroupRemoved: vi.fn(), nickChanged: vi.fn(), nickRemoved: vi.fn(),
        hotlist: vi.fn(), completion: vi.fn(), inputRejected: vi.fn(), unhandled: vi.fn(),
    };
}

const BUFFER = {
    id: 1759000000000001, name: 'irc.glowing-bear.#chan', short_name: '#chan', number: 2,
    type: 'formatted' as const, hidden: false, title: '#chan', modes: 'v', input_prompt: '<nicks>',
    input: '', input_position: 0, input_multiline: false, nicklist: true,
    nicklist_case_sensitive: false, nicklist_display_groups: true, time_displayed: true,
    local_variables: { type: 'channel', channel: '#chan' }, keys: [], last_read_line_id: 12,
};

const LINE = {
    id: 3, y: 5, date: '2026-10-04T12:00:00.000Z', date_printed: '2026-10-04T12:00:00.000Z',
    displayed: true, highlight: true, notify_level: 3, prefix: '@', message: 'hello', tags: ['notify_highlight'],
};

const NICK = {
    id: 1759000000000002, parent_group_id: 0, prefix: '@', prefix_color_name: 'lightred',
    prefix_color: '1', name: 'alice', color_name: 'white', color: '7', visible: true,
};

function event(name: string, bufferId: number, body: unknown, bodyType: string | null = null): ApiSessionEvent {
    return { event_name: name, buffer_id: bufferId, body_type: bodyType, body };
}

describe('mappings', () => {
    it('maps a buffer with semantic type from local_variables and read marker', () => {
        const snap = mapBuffer(BUFFER);
        expect(snap).toMatchObject({
            id: 1759000000000001,
            shortName: '#chan',
            contentType: 'formatted',
            semanticType: 'channel',
            lastReadLineId: 12,
        });
    });

    it('maps last_read_line_id -1 to the NO_READ_LINE sentinel', () => {
        const snap = mapBuffer({ ...BUFFER, last_read_line_id: -1 });
        expect(snap?.lastReadLineId).toBe(-1);
    });

    it('derives epochMs but never uses it as identity', () => {
        const line = mapLine(LINE);
        expect(line?.id).toBe(3);
        expect(line?.epochMs).toBe(Date.parse(LINE.date));
        expect(mapLine({ ...LINE, date: 'garbage' })?.epochMs).toBe(0);
    });

    it('maps hotlist counts to named slots in wire order [low, message, private, highlight]', () => {
        const snap = mapHotlistEntry({ priority: 3, date: 'd', buffer_id: 1, count: [1, 2, 3, 4] });
        expect(snap?.counts).toEqual({ low: 1, message: 2, private: 3, highlight: 4 });
    });

    it('maps nick group root with parent -1', () => {
        const g = mapNickGroup({ id: 0, parent_group_id: -1, name: '', color_name: '', color: '', visible: true, groups: [], nicks: [] });
        expect(g).toMatchObject({ id: 0, parentGroupId: -1 });
    });
});

describe('collection mapping', () => {
    it('skips invalid buffers but applies the rest, reporting each skip', () => {
        const r = reducers();
        const list = mapBufferList([BUFFER, { id: 'nope' }, BUFFER], r);
        expect(list).toHaveLength(2);
        expect(r.unhandled).toHaveBeenCalledTimes(1);
    });

    it('rejects a non-array buffers body via unhandled', () => {
        const r = reducers();
        expect(mapBufferList({ buffers: [] }, r)).toBeNull();
        expect(r.unhandled).toHaveBeenCalledWith('buffers response is not an array');
    });

    it('keys hotlist by buffer id', () => {
        const r = reducers();
        const map = mapHotlist([
            { priority: 1, date: '2026-10-04T12:00:00Z', buffer_id: 111, count: [0, 0, 1, 0] },
            { priority: 3, date: '2026-10-04T12:00:01Z', buffer_id: 222, count: [0, 0, 0, 1] },
        ], r);
        expect(map?.size).toBe(2);
        expect(map?.get(222 as never)?.counts.highlight).toBe(1);
    });
});

describe('dispatchEvent', () => {
    it('routes buffer_opened with lines and a flattened nick tree', () => {
        const r = reducers();
        dispatchEvent(event('buffer_opened', 1759000000000001, {
            ...BUFFER,
            lines: [LINE],
            nicklist_root: {
                id: 0, parent_group_id: -1, name: '', color_name: '', color: '', visible: true,
                groups: [{ id: 5, parent_group_id: 0, name: 'ops', color_name: '', color: '', visible: true, groups: [], nicks: [{ ...NICK, id: 9 }] }],
                nicks: [NICK],
            },
        }, 'buffer'), r);
        expect(r.bufferOpened).toHaveBeenCalledTimes(1);
        const [snap, lines, groups, nicks] = r.bufferOpened.mock.calls[0]!;
        expect(snap.id).toBe(1759000000000001);
        expect(lines).toHaveLength(1);
        expect(groups).toHaveLength(2); // root + group 5, depth-first
        expect(groups![0]).toMatchObject({ id: 0, parentGroupId: -1 });
        expect(groups![1]).toMatchObject({ id: 5, name: 'ops' });
        expect(nicks).toHaveLength(2); // direct + nested under group 5
        expect(r.unhandled).not.toHaveBeenCalled();
    });

    it('distinguishes absent sub-resources from empty ones', () => {
        const r = reducers();
        dispatchEvent(event('buffer_opened', 1759000000000001, BUFFER, 'buffer'), r);
        const [, lines, groups] = r.bufferOpened.mock.calls[0]!;
        expect(lines).toBeUndefined();
        expect(groups).toBeUndefined();
    });

    it('routes line events with validation', () => {
        const r = reducers();
        dispatchEvent(event('buffer_line_added', 1759000000000001, LINE, 'line'), r);
        expect(r.lineAdded).toHaveBeenCalledWith(1759000000000001, expect.objectContaining({ id: 3, highlight: true }));
        dispatchEvent(event('buffer_line_data_changed', 1759000000000001, { id: 'bad' }), r);
        expect(r.lineDataChanged).not.toHaveBeenCalled();
        expect(r.unhandled).toHaveBeenCalled();
    });

    // Live 4.10.1 shape: every buffer_* change signal carries a FULL buffer
    // snapshot as its body — there is no string-body variant and no
    // buffer_localvar_set event (real names: added/changed/removed).
    it('routes buffer change events through bufferUpdated with full buffer bodies', () => {
        const r = reducers();
        dispatchEvent(event('buffer_title_changed', 1759000000000001, { ...BUFFER, title: 'new title' }, 'buffer'), r);
        dispatchEvent(event('buffer_localvar_added', 1759000000000001, { ...BUFFER, local_variables: { ...BUFFER.local_variables, pinned: 'true' } }, 'buffer'), r);
        dispatchEvent(event('buffer_localvar_changed', 1759000000000001, { ...BUFFER, local_variables: { ...BUFFER.local_variables, channel: '#chan2' } }, 'buffer'), r);
        // Removal does NOT name the variable: the remaining map is authoritative.
        dispatchEvent(event('buffer_localvar_removed', 1759000000000001, { ...BUFFER, local_variables: { type: 'channel' } }, 'buffer'), r);
        dispatchEvent(event('buffer_modes_changed', 1759000000000001, { ...BUFFER, modes: 'vo' }, 'buffer'), r);
        dispatchEvent(event('buffer_hidden', 1759000000000001, { ...BUFFER, hidden: true }, 'buffer'), r);
        dispatchEvent(event('buffer_unhidden', 1759000000000001, { ...BUFFER }, 'buffer'), r);
        dispatchEvent(event('buffer_renamed', 1759000000000001, { ...BUFFER, name: 'irc.glowing-bear.#renamed', short_name: '#renamed' }, 'buffer'), r);
        dispatchEvent(event('buffer_type_changed', 1759000000000001, { ...BUFFER, type: 'free' }, 'buffer'), r);
        dispatchEvent(event('buffer_moved', 1759000000000001, { ...BUFFER, number: 9 }, 'buffer'), r);
        expect(r.bufferUpdated).toHaveBeenCalledTimes(10);
        expect(r.bufferUpdated).toHaveBeenCalledWith(expect.objectContaining({ title: 'new title' }));
        expect(r.bufferUpdated).toHaveBeenCalledWith(expect.objectContaining({ modes: 'vo' }));
        expect(r.bufferUpdated).toHaveBeenCalledWith(expect.objectContaining({ hidden: true }));
        expect(r.bufferUpdated).toHaveBeenCalledWith(expect.objectContaining({ shortName: '#renamed' }));
        expect(r.bufferUpdated).toHaveBeenCalledWith(expect.objectContaining({ contentType: 'free' }));
        expect(r.bufferUpdated).toHaveBeenCalledWith(expect.objectContaining({ number: 9 }));
        expect(r.unhandled).not.toHaveBeenCalled();
    });

    it('rejects fabricated string bodies on buffer change events', () => {
        const r = reducers();
        dispatchEvent(event('buffer_title_changed', 1759000000000001, 'new title'), r);
        dispatchEvent(event('buffer_localvar_removed', 1759000000000001, 'pinned'), r);
        expect(r.bufferUpdated).not.toHaveBeenCalled();
        expect(r.unhandled).toHaveBeenCalledTimes(2);
        expect(r.unhandled.mock.calls[0][0]).toContain('buffer_title_changed invalid');
        expect(r.unhandled.mock.calls[1][0]).toContain('buffer_localvar_removed invalid');
    });

    it('routes buffer_notify_changed from a buffer body or a bare level string', () => {
        const r = reducers();
        dispatchEvent(event('buffer_notify_changed', 1759000000000001, { ...BUFFER, notify: 'highlight' }, 'buffer'), r);
        dispatchEvent(event('buffer_notify_changed', 1759000000000001, 'none'), r);
        expect(r.bufferNotifyChanged).toHaveBeenCalledWith(1759000000000001, 1);
        expect(r.bufferNotifyChanged).toHaveBeenCalledWith(1759000000000001, 0);
        expect(r.unhandled).not.toHaveBeenCalled();
    });

    it('reports buffer_notify_changed without a usable level', () => {
        const r = reducers();
        dispatchEvent(event('buffer_notify_changed', 1759000000000001, { ...BUFFER, notify: 'loud' }), r);
        expect(r.bufferNotifyChanged).not.toHaveBeenCalled();
        expect(r.unhandled).toHaveBeenCalledWith('buffer_notify_changed without notify level');
    });

    it('maps the WeeChat >= 5.0.0 buffer notify field to a numeric level', () => {
        expect(mapBuffer({ ...BUFFER, notify: 'all' })?.notify).toBe(3);
        expect(mapBuffer({ ...BUFFER, notify: 'message' })?.notify).toBe(2);
        expect(mapBuffer(BUFFER)?.notify).toBeUndefined();
    });

    it('routes buffer_cleared and the real input events (not fabricated names)', () => {
        const r = reducers();
        dispatchEvent(event('buffer_cleared', 1759000000000001, { ...BUFFER }, 'buffer'), r);
        dispatchEvent(event('input_text_changed', 1759000000000001, { ...BUFFER, input: 'hello', input_position: 5 }, 'buffer'), r);
        dispatchEvent(event('input_text_cursor_moved', 1759000000000001, { ...BUFFER, input_position: 3 }, 'buffer'), r);
        dispatchEvent(event('input_prompt_changed', 1759000000000001, { ...BUFFER, input_prompt: '<nicks>' }, 'buffer'), r);
        expect(r.bufferCleared).toHaveBeenCalledWith(1759000000000001);
        expect(r.bufferInputChanged).toHaveBeenCalledWith(1759000000000001, 'hello', 5);
        expect(r.bufferInputChanged).toHaveBeenCalledWith(1759000000000001, '', 3);
        expect(r.bufferInputChanged).toHaveBeenCalledWith(1759000000000001, '', 0);
        expect(r.unhandled).not.toHaveBeenCalled();
    });

    it('routes nick/group lifecycle events', () => {
        const r = reducers();
        dispatchEvent(event('nicklist_nick_changed', 1759000000000001, NICK, 'nick'), r);
        // Live 4.10.1 shape: removal events carry the full entity object.
        dispatchEvent(event('nicklist_nick_removing', 1759000000000001, { ...NICK }, 'nick'), r);
        dispatchEvent(event('nicklist_group_changed', 1759000000000001, {
            id: 7, parent_group_id: 0, name: 'halfops', color_name: '', color: '', visible: true, groups: [], nicks: [],
        }, 'nick_group'), r);
        dispatchEvent(event('nicklist_group_removing', 1759000000000001, {
            id: 7, parent_group_id: 0, name: 'halfops', color_name: '', color: '', visible: true, groups: [], nicks: [],
        }, 'nick_group'), r);
        expect(r.nickChanged).toHaveBeenCalledTimes(1);
        expect(r.nickRemoved).toHaveBeenCalledWith(1759000000000001, 1759000000000002);
        expect(r.nickGroupChanged).toHaveBeenCalledWith(1759000000000001, expect.objectContaining({ id: 7 }));
        expect(r.nickGroupRemoved).toHaveBeenCalledWith(1759000000000001, 7);
        expect(r.unhandled).not.toHaveBeenCalled();
    });

    it('accepts a bare numeric body on removal events (tolerated shape)', () => {
        const r = reducers();
        dispatchEvent(event('nicklist_nick_removed', 1759000000000001, 1759000000000002), r);
        dispatchEvent(event('nicklist_group_removed', 1759000000000001, 7), r);
        expect(r.nickRemoved).toHaveBeenCalledWith(1759000000000001, 1759000000000002);
        expect(r.nickGroupRemoved).toHaveBeenCalledWith(1759000000000001, 7);
        expect(r.unhandled).not.toHaveBeenCalled();
    });

    // Live-captured 4.10.1 payloads: a join emits nicklist_nick_removing for
    // the old nick id followed by nicklist_nick_added with a NEW id — both
    // must reach the reducers or the nicklist UI drifts after every part/join.
    it('routes nicklist_nick_added / nicklist_group_added as upserts', () => {
        const r = reducers();
        dispatchEvent(event('nicklist_nick_added', 1791149913057556, {
            id: 1791184475802699, parent_group_id: 1791149913077412, prefix: ' ',
            prefix_color_name: 'lightblue', prefix_color: '\u0019F10', name: 'gbbot2',
            color_name: 'bar_fg', color: '\u0019bF', visible: true,
        }, 'nick'), r);
        dispatchEvent(event('nicklist_group_added', 1791149913057556, {
            id: 1791149913077412, parent_group_id: 0, name: '', color_name: '', color: '',
            visible: true, groups: [], nicks: [],
        }, 'nick_group'), r);
        expect(r.nickChanged).toHaveBeenCalledWith(1791149913057556, expect.objectContaining({
            id: 1791184475802699, name: 'gbbot2',
        }));
        expect(r.nickGroupChanged).toHaveBeenCalledWith(1791149913057556, expect.objectContaining({ id: 1791149913077412 }));
        expect(r.unhandled).not.toHaveBeenCalled();
    });

    it('reports removal events without a usable id', () => {
        const r = reducers();
        dispatchEvent(event('nicklist_nick_removing', 1759000000000001, { name: 'ghost' }, 'nick'), r);
        dispatchEvent(event('nicklist_group_removing', 1759000000000001, { name: 'gone' }, 'nick_group'), r);
        expect(r.nickRemoved).not.toHaveBeenCalled();
        expect(r.nickGroupRemoved).not.toHaveBeenCalled();
        expect(r.unhandled).toHaveBeenCalledWith('nick removal without nick id');
        expect(r.unhandled).toHaveBeenCalledWith('nicklist group removal without group id');
    });

    it('routes closing/closed with buffer id only', () => {
        const r = reducers();
        dispatchEvent(event('buffer_closing', 1759000000000001, { ...BUFFER }, 'buffer'), r);
        dispatchEvent(event('buffer_closed', 1759000000000001, null), r);
        expect(r.bufferClosing).toHaveBeenCalledWith(1759000000000001);
        expect(r.bufferClosed).toHaveBeenCalledWith(1759000000000001);
    });

    it('unknown events go to unhandled without crashing', () => {
        const r = reducers();
        dispatchEvent(event('brand_new_event_from_the_future', 1, {}), r);
        dispatchEvent(event('buffer_hidden', 1759000000000001, 'not a buffer'), r);
        expect(r.unhandled).toHaveBeenCalledTimes(2);
    });

    it('invalid buffer_id never reaches reducers', () => {
        const r = reducers();
        dispatchEvent(event('buffer_line_added', -5, LINE, 'line'), r);
        expect(r.lineAdded).not.toHaveBeenCalled();
        expect(r.unhandled).toHaveBeenCalledWith('buffer_line_added with invalid buffer_id');
    });
});
