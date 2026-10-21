/**
 * The line identity both transports and the read marker have to agree on.
 *
 * A retained line's id is WeeChat's own line number, written as one prefix plus that
 * number. Four places produce it — `createBufferLine` on the legacy path, the API's
 * `lineAdded` and `lineDataChanged`, and the API history window — and two places look
 * it up: the read-boundary re-anchoring that asks "which row is WeeChat's marker?", and
 * the history dedupe that asks "has this row already been inserted?".
 *
 * Nothing type-checks that agreement. A prefix edited at one site still compiles, and
 * the failure is silent in both directions: the boundary lookup finds no row, so the
 * unread badge and read marker go missing, or the dedupe finds no match, so every
 * history page re-inserts lines the live session already showed. `api-dossier` records
 * that WeeChat reuses line ids across buffers, so a wrong key is not merely cosmetic.
 *
 * This pins the pairs that must agree, by behaviour rather than by string: build a line
 * through one site and resolve it through another.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import {
    applyServerReadMarker,
    buffers,
    createBuffer,
    createBufferLine,
    getReadBoundaryIndex,
} from '#lib/stores/models.ts';
import { createApiStoreReducers, flushApiLineBatch, storeKeyForBufferId } from '#lib/api/api-store-reducers.ts';
import { fetchHistory } from '#lib/api/api-features.ts';
import type { ApiSession, ApiSessionResponse } from '#lib/api/api-session.ts';

const API_BUFFER_ID = 77;

/** Wire rows as the relay returns them; `id` is WeeChat's line number. */
function wireLine(id: number, message = `msg ${id}`) {
    return {
        id, y: id, date: '2026-10-04T12:00:00.000Z', date_printed: '2026-10-04T12:00:00.000Z',
        displayed: true, highlight: false, notify_level: 1, prefix: 'bob', message, tags: ['irc_privmsg'],
    };
}

function apiLine(id: number, message = `msg ${id}`) {
    return {
        id: id as never, epochMs: 1, displayed: true, highlight: false, notifyLevel: 1,
        prefix: 'bob', message, tags: ['irc_privmsg'],
    };
}

function fakeSession(body: unknown[]): ApiSession {
    return {
        request: () => Promise.resolve({ code: 200, body } as ApiSessionResponse),
    } as unknown as ApiSession;
}

/** The row index WeeChat's marker resolves to, or null when nothing matched. */
function boundaryOf(buffer: ReturnType<typeof createBuffer>): number | null {
    applyServerReadMarker(buffer, WECHAT_LINE_ID);
    return getReadBoundaryIndex(buffer);
}

const WECHAT_LINE_ID = 4242;

beforeEach(() => {
    buffers.set({});
    const snap = {
        id: API_BUFFER_ID as never, name: 'irc.glowing-bear.#chan', shortName: '#chan', number: 2,
        contentType: 'formatted', semanticType: 'channel', hidden: false, title: '',
        localVariables: { type: 'channel', plugin: 'irc', server: 'glowing-bear' }, lastReadLineId: -1,
    };
    createApiStoreReducers().buffers([snap as never]);
});

describe('a line built by one site is found by the other', () => {
    it('resolves a marker against a line the legacy path built', () => {
        const buffer = createBuffer({ full_name: 'irc.gbtest.#chan', short_name: '#chan' });
        buffer.lines = [
            createBufferLine({ buffer: buffer.id, date: 1, message: 'older', tags_array: ['irc_privmsg'] }),
            createBufferLine({
                buffer: buffer.id, date: 2, id: WECHAT_LINE_ID,
                message: 'marked', tags_array: ['irc_privmsg'],
            }),
        ];

        expect(boundaryOf(buffer), 'WeeChat\'s marker names the row the legacy path built').toBe(1);
    });

    it('resolves a marker against a line the API transport built', () => {
        createApiStoreReducers().lineAdded(API_BUFFER_ID, apiLine(WECHAT_LINE_ID));
        // The API path batches live lines; the row is only in the store once the batch
        // is flushed, which `lineDataChanged` and a history response do by themselves.
        flushApiLineBatch();
        const buffer = get(buffers)[storeKeyForBufferId(API_BUFFER_ID)];
        if (!buffer) throw new Error('the API snapshot buffer was not created');

        expect(boundaryOf(buffer), 'the marker lookup speaks the API transport\'s ids').toBe(0);
    });

    it('updates the row the live event built when the line later changes', () => {
        const reducers = createApiStoreReducers();
        reducers.lineAdded(API_BUFFER_ID, apiLine(WECHAT_LINE_ID, 'edited later'));
        const key = storeKeyForBufferId(API_BUFFER_ID);

        reducers.lineDataChanged(API_BUFFER_ID, apiLine(WECHAT_LINE_ID, 'edited later, twice'));

        const lines = get(buffers)[key]!.lines;
        expect(lines, 'a changed line is the same row, not a second one').toHaveLength(1);
        expect(lines[0]!.text).toBe('edited later, twice');
    });

    it('dedupes a history row against a live row in either arrival order', async () => {
        const reducers = createApiStoreReducers();
        const key = storeKeyForBufferId(API_BUFFER_ID);

        // History first, then a live line for the same id.
        await fetchHistory(fakeSession([wireLine(5), wireLine(6)]), { bufferId: API_BUFFER_ID as never, count: 2 });
        reducers.lineAdded(API_BUFFER_ID, apiLine(6));
        flushApiLineBatch();
        expect(get(buffers)[key]!.lines, 'the live race does not add a row').toHaveLength(2);

        // Live first, then a history page containing the same id.
        reducers.lineAdded(API_BUFFER_ID, apiLine(7));
        flushApiLineBatch();
        await fetchHistory(fakeSession([wireLine(7)]), { bufferId: API_BUFFER_ID as never, count: 1 });
        expect(get(buffers)[key]!.lines, 'the history page does not re-insert it').toHaveLength(3);
    });
    it('inserts a fetched row by its WeeChat number, read back out of the id', async () => {
        // The merge sorts a fetched window against the rows already held by WeeChat's
        // number, which it takes back out of the line id. A prefix the parse does not
        // recognise returns no number, and the row lands at the tail instead: the
        // transcript reads out of order, which is the bug this merge exists to prevent.
        const reducers = createApiStoreReducers();
        const key = storeKeyForBufferId(API_BUFFER_ID);
        reducers.lineAdded(API_BUFFER_ID, apiLine(10, 'before'));
        reducers.lineAdded(API_BUFFER_ID, apiLine(12, 'after'));
        flushApiLineBatch();

        await fetchHistory(fakeSession([wireLine(11, 'between')]), { bufferId: API_BUFFER_ID as never, count: 1 });

        expect(get(buffers)[key]!.lines.map((l) => l.text), 'the fetched row sits in print order').toEqual([
            'before', 'between', 'after',
        ]);
    });
});

