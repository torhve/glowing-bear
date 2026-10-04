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
        bufferTitleChanged: vi.fn(), bufferLocalvarSet: vi.fn(), bufferLocalvarRemoved: vi.fn(),
        bufferModesChanged: vi.fn(), bufferInputChanged: vi.fn(), lineAdded: vi.fn(),
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
        const [snap, lines, root, nicks] = r.bufferOpened.mock.calls[0]!;
        expect(snap.id).toBe(1759000000000001);
        expect(lines).toHaveLength(1);
        expect(root).toMatchObject({ id: 0, parentGroupId: -1 });
        expect(nicks).toHaveLength(2); // direct + nested under group 5
        expect(r.unhandled).not.toHaveBeenCalled();
    });

    it('distinguishes absent sub-resources from empty ones', () => {
        const r = reducers();
        dispatchEvent(event('buffer_opened', 1759000000000001, BUFFER, 'buffer'), r);
        const [, lines, root] = r.bufferOpened.mock.calls[0]!;
        expect(lines).toBeUndefined();
        expect(root).toBeUndefined();
    });

    it('routes line events with validation', () => {
        const r = reducers();
        dispatchEvent(event('buffer_line_added', 1759000000000001, LINE, 'line'), r);
        expect(r.lineAdded).toHaveBeenCalledWith(1759000000000001, expect.objectContaining({ id: 3, highlight: true }));
        dispatchEvent(event('buffer_line_data_changed', 1759000000000001, { id: 'bad' }), r);
        expect(r.lineDataChanged).not.toHaveBeenCalled();
        expect(r.unhandled).toHaveBeenCalled();
    });

    it('routes simple string-body events (title, localvar removed, modes)', () => {
        const r = reducers();
        dispatchEvent(event('buffer_title_changed', 1759000000000001, 'new title'), r);
        dispatchEvent(event('buffer_localvar_removed', 1759000000000001, 'pinned'), r);
        dispatchEvent(event('buffer_modes_changed', 1759000000000001, 'vo'), r);
        expect(r.bufferTitleChanged).toHaveBeenCalledWith(1759000000000001, 'new title');
        expect(r.bufferLocalvarRemoved).toHaveBeenCalledWith(1759000000000001, 'pinned');
        expect(r.bufferModesChanged).toHaveBeenCalledWith(1759000000000001, 'vo');
    });

    it('routes object-body events (localvar set, input changed)', () => {
        const r = reducers();
        dispatchEvent(event('buffer_localvar_set', 1759000000000001, { name: 'pinned', value: 'true' }), r);
        dispatchEvent(event('buffer_input_changed', 1759000000000001, { input: 'hello', cursor_pos: 5 }), r);
        expect(r.bufferLocalvarSet).toHaveBeenCalledWith(1759000000000001, 'pinned', 'true');
        expect(r.bufferInputChanged).toHaveBeenCalledWith(1759000000000001, 'hello', 5);
    });

    it('routes nick/group lifecycle events', () => {
        const r = reducers();
        dispatchEvent(event('nicklist_nick_changed', 1759000000000001, NICK, 'nick'), r);
        dispatchEvent(event('nicklist_nick_removing', 1759000000000001, 1759000000000002), r);
        dispatchEvent(event('nicklist_group_changed', 1759000000000001, {
            id: 7, parent_group_id: 0, name: 'halfops', color_name: '', color: '', visible: true, groups: [], nicks: [],
        }, 'nick_group'), r);
        dispatchEvent(event('nicklist_group_removing', 1759000000000001, 7), r);
        expect(r.nickChanged).toHaveBeenCalledTimes(1);
        expect(r.nickRemoved).toHaveBeenCalledWith(1759000000000001, 1759000000000002);
        expect(r.nickGroupChanged).toHaveBeenCalledWith(1759000000000001, expect.objectContaining({ id: 7 }));
        expect(r.nickGroupRemoved).toHaveBeenCalledWith(1759000000000001, 7);
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
        dispatchEvent(event('input_prompt_changed', 1759000000000001, 'new prompt'), r);
        dispatchEvent(event('brand_new_event_from_the_future', 1, {}), r);
        expect(r.unhandled).toHaveBeenCalledTimes(2);
    });

    it('invalid buffer_id never reaches reducers', () => {
        const r = reducers();
        dispatchEvent(event('buffer_line_added', -5, LINE, 'line'), r);
        expect(r.lineAdded).not.toHaveBeenCalled();
        expect(r.unhandled).toHaveBeenCalledWith('buffer_line_added with invalid buffer_id');
    });
});
