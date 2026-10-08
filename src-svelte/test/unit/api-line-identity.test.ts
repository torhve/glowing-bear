/**
 * Direct equivalence coverage for the API path's line-idempotence rule.
 *
 * `applyLineAdded` used to answer "has history already inserted this line?" by
 * scanning every retained line. It now asks `buffer.lineIdsSeen` first and only
 * scans when that set claims the id is known. These tests pin the behaviour the
 * scan used to guarantee — the outcomes must be identical whichever way the
 * answer is obtained, including the cases where the set is deliberately stale.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { get } from 'svelte/store';
import { buffers, activeBufferId, recalculateLinesPerScreen } from '#lib/stores/models.ts';
import { createApiStoreReducers, flushApiLineBatch } from '#lib/api/api-store-reducers.ts';
import type { ApiReducers, BufferSnapshot, LineSnapshot } from '#lib/api/api-contracts.ts';
import type { ApiBufferId, ApiLineId } from '#lib/api/api-ids.ts';

vi.mock('#lib/notifications.ts', () => ({
    createHighlight: vi.fn(),
    playNotificationSound: vi.fn(),
    updateTitle: vi.fn(),
    updateFavico: vi.fn(),
    startIndicatorOwner: () => () => {},
    refreshIndicators: vi.fn(),
}));
vi.mock('#lib/windowFocus.ts', () => ({ isWindowFocused: () => true }));

const BUFFER_ID = 1759000000000009 as ApiBufferId;
const KEY = String(BUFFER_ID);

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
        notify: 3,
    };
}

function lineSnap(id: number, overrides: Partial<LineSnapshot> = {}): LineSnapshot {
    return {
        id: id as ApiLineId,
        epochMs: Date.parse('2026-10-04T12:00:00.000Z') + id * 1000,
        displayed: true,
        highlight: false,
        notifyLevel: 1,
        prefix: 'alice',
        message: `msg ${id}`,
        tags: ['notify_message'],
        ...overrides,
    };
}

let reducers: ApiReducers;

/** `lineAdded` queues; the frame-aligned flush applies it. Drain before reading. */
function addLine(id: number, overrides: Partial<LineSnapshot> = {}): void {
    reducers.lineAdded(BUFFER_ID, lineSnap(id, overrides));
    flushApiLineBatch();
}

const rows = () => get(buffers)[KEY]!.lines;
const ids = () => rows().map((l) => l.lineId);

beforeEach(() => {
    buffers.set({});
    activeBufferId.set('');
    recalculateLinesPerScreen(500); // maxBufferLines = 1000
    reducers = createApiStoreReducers();
    reducers.buffers([bufferSnap()]);
});

describe('API line identity', () => {
    it('a live line whose id history already inserted updates the row in place', () => {
        // buffer_opened carries the initial (history) rows.
        reducers.bufferOpened(bufferSnap(), [lineSnap(5), lineSnap(6)], undefined, undefined);
        expect(ids()).toEqual(['weechat:5', 'weechat:6']);

        addLine(5, { message: 'live update of 5' });

        expect(rows()).toHaveLength(2);
        expect(rows()[0]!.text).toBe('live update of 5');
        expect(rows()[0]!.lineId).toBe('weechat:5');
    });

    it('a live line with an unseen id appends exactly once', () => {
        addLine(1);
        addLine(2);
        expect(ids()).toEqual(['weechat:1', 'weechat:2']);
    });

    it('a line trimmed out of the visible window re-appends instead of duplicating', () => {
        recalculateLinesPerScreen(95); // maxBufferLines = 200
        for (let id = 1; id <= 200; id++) addLine(id);
        expect(rows()).toHaveLength(200);

        // id 1 is now off-screen but still remembered in the id superset.
        addLine(201);
        expect(rows()).toHaveLength(200);
        expect(ids()).not.toContain('weechat:1');

        addLine(1, { message: 'refetched 1' });
        expect(rows()).toHaveLength(200);
        expect(ids().filter((id) => id === 'weechat:1')).toHaveLength(1);
        expect(rows()[rows().length - 1]!.text).toBe('refetched 1');
    });

    it('bufferCleared empties the window so the same id appends again', () => {
        addLine(7);
        reducers.bufferCleared(BUFFER_ID);
        expect(rows()).toHaveLength(0);

        addLine(7, { message: 'after clear' });
        expect(ids()).toEqual(['weechat:7']);
        expect(rows()[0]!.text).toBe('after clear');
    });

    it('live lines interleaved with buffer_opened rows stay unique and in place', () => {
        // buffer_opened appends its initial rows without deduping them (only the
        // history fetch dedupes). What the id check guarantees is that a LIVE line
        // never duplicates a row that is already on screen.
        reducers.bufferOpened(bufferSnap(), [lineSnap(8), lineSnap(9)], undefined, undefined);
        addLine(10);
        addLine(9, { message: 'live 9' });
        addLine(11);
        flushApiLineBatch();

        const seen = ids();
        expect(new Set(seen).size).toBe(seen.length);
        expect(seen).toEqual(['weechat:8', 'weechat:9', 'weechat:10', 'weechat:11']);
        expect(rows()[1]!.text).toBe('live 9');
    });

    it('the id set stays bounded instead of growing with every line ever seen', () => {
        recalculateLinesPerScreen(95); // maxBufferLines = 200, rebuild bound = 800
        for (let id = 1; id <= 900; id++) addLine(id);
        const buffer = get(buffers)[KEY]!;
        expect(buffer.lines).toHaveLength(200);
        expect(buffer.lineIdsSeen?.size ?? 0).toBeLessThanOrEqual(800);
        expect(buffer.lineIdsSeen?.has('weechat:1')).toBe(false);
    });
});
