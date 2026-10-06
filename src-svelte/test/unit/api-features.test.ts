import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import {
    byteOffsetToCharIndex, charIndexToCodePointOffset, utf8Length,
    fetchHistory, sendInput, requestCompletion, rankCandidates, completionInsert, clearHiddenLineIdTracking,
} from '#lib/api/api-features.ts';
import { createApiStoreReducers } from '#lib/api/api-store-reducers.ts';
import {
    buffers, activeBufferId, previousBufferId, getReadBoundaryIndex, isUserMessageLine,
    beginSyncPhase, endSyncPhase, setActiveBuffer,
} from '#lib/stores/models.ts';
import type { BufferData } from '#lib/types.ts';
import type { ApiSession, ApiSessionResponse } from '#lib/api/api-session.ts';
import type { ApiBufferId } from '#lib/api/api-ids.ts';
import type { BufferSnapshot, HotlistSnapshot } from '#lib/api/api-contracts.ts';

const BUFFER_ID = 1759000000000001 as ApiBufferId;
const KEY = String(BUFFER_ID);

/** Minimal structural fake: features only use session.request. */
function fakeSession(handler: (path: string) => ApiSessionResponse | Promise<ApiSessionResponse>): ApiSession {
    return {
        request: (req: { path: string }) => Promise.resolve(handler(req.path)),
    } as unknown as ApiSession;
}

function wireLine(id: number, message = `msg ${id}`) {
    return {
        id, y: id, date: '2026-10-04T12:00:00.000Z', date_printed: '2026-10-04T12:00:00.000Z',
        displayed: true, highlight: false, notify_level: 0, prefix: '', message, tags: [],
    };
}

function wireMessage(id: number, message = `msg ${id}`) {
    return { ...wireLine(id, message), notify_level: 1, tags: ['irc_privmsg'] };
}

/** The badge the chat view renders: retained lines after the read boundary. */
function displayedUnread(buffer: BufferData): number {
    const readEndIndex = getReadBoundaryIndex(buffer);
    const messages = buffer.lines.filter(isUserMessageLine);
    return readEndIndex < messages.length - 1 ? messages.length - Math.max(0, readEndIndex + 1) : 0;
}

beforeEach(() => {
    buffers.set({});
    clearHiddenLineIdTracking();
    const reducers = createApiStoreReducers();
    const snap: BufferSnapshot = {
        id: BUFFER_ID, name: 'irc.glowing-bear.#chan', shortName: '#chan', number: 2,
        contentType: 'formatted', semanticType: 'channel', hidden: false, title: '',
        localVariables: { type: 'channel', plugin: 'irc', server: 'glowing-bear' }, lastReadLineId: -1,
    };
    reducers.buffers([snap]);
});

describe('UTF-8 offset conversion', () => {
    it('ASCII offsets map 1:1', () => {
        expect(byteOffsetToCharIndex('hello world', 6)).toBe(6);
        expect(byteOffsetToCharIndex('hello', 5)).toBe(5);
    });

    it('multi-byte code points shift byte offsets back to string indices', () => {
        const cmd = '/msg æøå hello'; // æøå = 2 bytes each
        expect(utf8Length('æøå')).toBe(6);
        // byte offset of 'hello' = 5 + 6 + 1 = 12
        expect(byteOffsetToCharIndex(cmd, 12)).toBe(9);
        expect(cmd.slice(9, 14)).toBe('hello');
    });

    it('emoji (surrogate pairs) convert correctly', () => {
        const cmd = 'a😀b'; // a=1, 😀=4 bytes, b=1
        expect(byteOffsetToCharIndex(cmd, 1)).toBe(1);
        expect(byteOffsetToCharIndex(cmd, 5)).toBe(3); // 'b' is UTF-16 index 3
        expect(byteOffsetToCharIndex(cmd, 2)).toBeNull(); // mid-code-point
        expect(charIndexToCodePointOffset(cmd, 2)).toBe(2); // cursor after emoji = 2 code points
    });

    it('out-of-range offsets are rejected', () => {
        expect(byteOffsetToCharIndex('abc', 4)).toBeNull();
        expect(byteOffsetToCharIndex('abc', -1)).toBeNull();
    });
});

describe('fetchHistory', () => {
    it('prepends oldest-first with stable lineIds and dedupes overlaps', async () => {
        const session = fakeSession(() => ({ code: 200, body: [wireLine(20), wireLine(21)] }));
        const first = await fetchHistory(session, { bufferId: BUFFER_ID, count: 2 });
        expect(first.applied).toBe(true);
        expect(first.complete).toBe(false); // 2 of 2 requested — more may exist older
        // A live line that raced with the history response must not duplicate.
        createApiStoreReducers().lineAdded(BUFFER_ID, {
            id: 21 as never, epochMs: 1, displayed: true, highlight: false, notifyLevel: 1,
            prefix: '', message: 'msg 21 live', tags: ['notify_message'],
        });
        // Empty second fetch: asserts the earlier state is stable.
        const session2 = fakeSession(() => ({ code: 200, body: [] }));
        await fetchHistory(session2, { bufferId: BUFFER_ID, count: 10 });
        const buf = get(buffers)[KEY]!;
        const ids = buf.lines.map((l) => l.lineId);
        expect(ids.filter((i) => i === 'weechat:21')).toHaveLength(1);
        expect(ids).toEqual(['weechat:20', 'weechat:21']); // oldest first, live race deduped
        // Deduped live lines are not tallied locally; WeeChat's hotlist
        // baseline/polling is authoritative for their unread counts (G4).
        expect(buf.localUnread).toBe(0);
    });

    it('drops the response when the buffer was cleared mid-request', async () => {
        let resolveReq: (r: ApiSessionResponse) => void = () => undefined;
        const session = {
            request: () => new Promise<ApiSessionResponse>((resolve) => { resolveReq = resolve; }),
        } as unknown as ApiSession;
        const p = fetchHistory(session, { bufferId: BUFFER_ID, count: 10 });
        createApiStoreReducers().bufferCleared(BUFFER_ID); // epoch bumps mid-flight
        resolveReq({ code: 200, body: [wireLine(1)] });
        const res = await p;
        expect(res.applied).toBe(false);
        expect(get(buffers)[KEY]!.lines).toHaveLength(0);
    });

    it('drops the response when the buffer closed mid-request', async () => {
        let resolveReq: (r: ApiSessionResponse) => void = () => undefined;
        const session = {
            request: () => new Promise<ApiSessionResponse>((resolve) => { resolveReq = resolve; }),
        } as unknown as ApiSession;
        const p = fetchHistory(session, { bufferId: BUFFER_ID, count: 10 });
        createApiStoreReducers().bufferClosed(BUFFER_ID);
        resolveReq({ code: 200, body: [wireLine(1)] });
        const res = await p;
        expect(res.applied).toBe(false);
    });

    it('non-200 (closed buffer 404) yields nothing', async () => {
        const session = fakeSession(() => ({ code: 404, body: { error: 'Buffer not found' } }));
        const res = await fetchHistory(session, { bufferId: BUFFER_ID, count: 10 });
        expect(res.applied).toBe(false);
        expect(res.lines).toHaveLength(0);
    });

    it('skips smart-filtered lines from history (displayed:false / irc_smart_filter)', async () => {
        const session = fakeSession(() => ({
            code: 200,
            body: [
                { ...wireLine(1, 'filtered'), displayed: false },
                { ...wireLine(2, 'tagged'), tags: ['irc_smart_filter'] },
                wireLine(3, 'visible'),
            ],
        }));
        const res = await fetchHistory(session, { bufferId: BUFFER_ID, count: 10 });
        expect(res.applied).toBe(true);
        const buf = get(buffers)[KEY]!;
        expect(buf.lines.map((l) => l.text)).toEqual(['visible']);
        // requestedLines counts every line the server sent (hidden included)
        // so the paging window advances past smart-filtered regions.
        expect(buf.requestedLines).toBe(3);
    });

    it('a fully hidden fetch still advances the window (blank-buffer regression)', async () => {
        const session = fakeSession(() => ({
            code: 200,
            body: [
                { ...wireLine(1, 'join'), displayed: false },
                { ...wireLine(2, 'part'), tags: ['irc_smart_filter'] },
            ],
        }));
        const res = await fetchHistory(session, { bufferId: BUFFER_ID, count: 2 });
        expect(res.applied).toBe(true);
        const buf = get(buffers)[KEY]!;
        expect(buf.lines).toHaveLength(0);
        // The window must advance (requestedLines) and NOT be marked complete,
        // otherwise the buffer stays blank with no way to page further.
        expect(buf.requestedLines).toBe(2);
        expect(res.complete).toBe(false);
    });

    it('deduped lines are not counted twice in requestedLines', async () => {
        const session = fakeSession(() => ({
            code: 200,
            body: [wireLine(1, 'a'), { ...wireLine(2, 'join'), displayed: false }],
        }));
        await fetchHistory(session, { bufferId: BUFFER_ID, count: 2 });
        // Overlapping refetch of the same newest-2 window: nothing is new.
        const session2 = fakeSession(() => ({
            code: 200,
            body: [wireLine(1, 'a'), { ...wireLine(2, 'join'), displayed: false }],
        }));
        await fetchHistory(session2, { bufferId: BUFFER_ID, count: 2 });
        expect(get(buffers)[KEY]!.requestedLines).toBe(2);
    });

    it('pages past a hidden-only window into visible history', async () => {
        // First fetch: newest-2 window is all smart-filtered (blank buffer).
        const session = fakeSession(() => ({
            code: 200,
            body: [
                { ...wireLine(5, 'join'), displayed: false },
                { ...wireLine(6, 'part'), tags: ['irc_smart_filter'] },
            ],
        }));
        await fetchHistory(session, { bufferId: BUFFER_ID, count: 2 });
        expect(get(buffers)[KEY]!.lines).toHaveLength(0);
        // Doubled window (newest-4): older lines include a visible message.
        const session2 = fakeSession(() => ({
            code: 200,
            body: [
                { ...wireLine(5, 'join'), displayed: false },
                { ...wireLine(6, 'part'), tags: ['irc_smart_filter'] },
                wireLine(4, 'hello'),
                { ...wireLine(3, 'join'), displayed: false },
            ],
        }));
        const res = await fetchHistory(session2, { bufferId: BUFFER_ID, count: 4 });
        expect(res.applied).toBe(true);
        const buf = get(buffers)[KEY]!;
        // The visible line renders; window counts all 4 raw lines (no double-count).
        expect(buf.lines.map((l) => l.text)).toEqual(['hello']);
        expect(buf.requestedLines).toBe(4);
    });

    it('an entirely hidden history completes at the start of history', async () => {
        const session = fakeSession(() => ({
            code: 200,
            body: [{ ...wireLine(1, 'join'), displayed: false }], // 1 of 2: start reached
        }));
        const res = await fetchHistory(session, { bufferId: BUFFER_ID, count: 2 });
        const buf = get(buffers)[KEY]!;
        expect(res.complete).toBe(true); // caller sets allLinesFetched → paging stops
        expect(buf.lines).toHaveLength(0);
        expect(buf.requestedLines).toBe(1);
    });

    it('reconnect clears hidden-id tracking so ids are not deduped against a previous session', async () => {
        const hidden = { ...wireLine(1, 'join'), displayed: false };
        const session = fakeSession(() => ({ code: 200, body: [hidden] }));
        await fetchHistory(session, { bufferId: BUFFER_ID, count: 1 });
        // New session, same buffer id and epoch 0: the same line id is fresh data.
        clearHiddenLineIdTracking();
        buffers.set({});
        createApiStoreReducers().buffers([{
            id: BUFFER_ID, name: 'irc.glowing-bear.#chan', shortName: '#chan', number: 2,
            contentType: 'formatted', semanticType: 'channel', hidden: false, title: '',
            localVariables: { type: 'channel', plugin: 'irc', server: 'glowing-bear' }, lastReadLineId: -1,
        }]);
        const session2 = fakeSession(() => ({ code: 200, body: [hidden] }));
        await fetchHistory(session2, { bufferId: BUFFER_ID, count: 1 });
        expect(get(buffers)[KEY]!.requestedLines).toBe(1);
    });

    // The reported bug, driven through the real bootstrap + paging path.
    it('paging history does not turn the loaded lines into unread ones', async () => {
        // Bootstrap snapshot: no lines, and WeeChat reports no read marker (-1).
        expect(get(buffers)[KEY]!.readBoundaryKnown).toBe(false);

        const newest = fakeSession(() => ({
            code: 200,
            body: Array.from({ length: 100 }, (_, i) => wireMessage(101 + i)),
        }));
        await fetchHistory(newest, { bufferId: BUFFER_ID, count: 100 });
        expect(displayedUnread(get(buffers)[KEY]!)).toBe(0);

        // Second "Fetch more lines" page: a wider window of older history.
        const older = fakeSession(() => ({
            code: 200,
            body: Array.from({ length: 70 }, (_, i) => wireMessage(31 + i)),
        }));
        await fetchHistory(older, { bufferId: BUFFER_ID, count: 170 });

        const buf = get(buffers)[KEY]!;
        expect(buf.lines.filter(isUserMessageLine)).toHaveLength(170);
        expect(buf.readBoundaryKnown).toBe(true);
        expect(displayedUnread(buf)).toBe(0);
    });

    it('leaves the boundary unresolved when the unread count exceeds the retained history', async () => {
        // WeeChat's marker is older than anything fetched and the hotlist reports
        // more unread than there are lines: no window can prove where the unread
        // region starts, so nothing may be claimed as read or as new.
        // The hotlist only feeds the boundary for buffers the user is not
        // currently viewing — the active one is managed by setActiveBuffer.
        activeBufferId.set('');
        previousBufferId.set('');
        const entry: HotlistSnapshot = {
            priority: 1, date: '2026-10-04T12:00:00.000Z', counts: { low: 0, message: 12, private: 0, highlight: 0 },
        };
        createApiStoreReducers().hotlist(new Map([[BUFFER_ID, entry]]));
        const session = fakeSession(() => ({
            code: 200,
            body: Array.from({ length: 5 }, (_, i) => wireMessage(101 + i)),
        }));
        await fetchHistory(session, { bufferId: BUFFER_ID, count: 5 });

        const buf = get(buffers)[KEY]!;
        expect(buf.readBoundaryKnown).toBe(false);
        expect(getReadBoundaryIndex(buf)).toBeNull();
    });

    // Bootstrap order: buffers and their history land before the hotlist baseline,
    // so a zero count during the sync phase must not be read as "this buffer is
    // read" — that would lock the boundary and hide the unread that arrives next.
    it('history that lands before the hotlist baseline does not claim the buffer is read', async () => {
        const generation = beginSyncPhase();
        activeBufferId.set('');
        previousBufferId.set('');
        try {
            const session = fakeSession(() => ({
                code: 200,
                body: Array.from({ length: 5 }, (_, i) => wireMessage(101 + i)),
            }));
            await fetchHistory(session, { bufferId: BUFFER_ID, count: 5 });
            // Counts are not authoritative yet, so nothing may be claimed as read.
            expect(get(buffers)[KEY]!.readBoundaryKnown).toBe(false);

            createApiStoreReducers().hotlist(new Map([[BUFFER_ID, {
                priority: 1, date: '2026-10-04T12:00:00.000Z', counts: { low: 0, message: 2, private: 0, highlight: 0 },
            }]]));
        } finally {
            endSyncPhase(generation);
        }

        // Closing the phase is the protocol event that places the boundary from the
        // baseline that has just become authoritative: two of the five lines unread.
        const buf = get(buffers)[KEY]!;
        expect(buf.readBoundaryKnown).toBe(true);
        expect(getReadBoundaryIndex(buf)).toBe(2);
        expect(displayedUnread(buf)).toBe(2);
    });

    it('a buffer activated during the sync phase is resolved once the baseline lands', async () => {
        const generation = beginSyncPhase();
        try {
            // Bootstrap activates the resumed buffer before any history is loaded,
            // then the chat view fetches a window while the phase is still open.
            setActiveBuffer(KEY);
            const session = fakeSession(() => ({
                code: 200,
                body: Array.from({ length: 5 }, (_, i) => wireMessage(101 + i)),
            }));
            await fetchHistory(session, { bufferId: BUFFER_ID, count: 5 });
            expect(get(buffers)[KEY]!.readBoundaryKnown).toBe(false);

            // The real baseline: WeeChat reports this buffer as read.
            createApiStoreReducers().hotlist(new Map([[BUFFER_ID, {
                priority: 1, date: '2026-10-04T12:00:00.000Z', counts: { low: 0, message: 0, private: 0, highlight: 0 },
            }]]));
        } finally {
            endSyncPhase(generation);
        }

        // With the baseline applied the retained history is read: no separator above
        // the lines the user is looking at.
        const buf = get(buffers)[KEY]!;
        expect(buf.readBoundaryKnown).toBe(true);
        expect(displayedUnread(buf)).toBe(0);
    });

    it('a sync phase that closes without a baseline resolves nothing', async () => {
        const generation = beginSyncPhase();
        const session = fakeSession(() => ({
            code: 200,
            body: Array.from({ length: 5 }, (_, i) => wireMessage(101 + i)),
        }));
        await fetchHistory(session, { bufferId: BUFFER_ID, count: 5 });
        // Attempt failed: the phase closes but no counts were ever applied.
        endSyncPhase(generation);

        expect(get(buffers)[KEY]!.readBoundaryKnown).toBe(false);
    });
});

describe('sendInput', () => {
    it('204 is accepted; the buffer id is sent', async () => {
        let seenPath = '';
        let seenBody: Record<string, unknown> | undefined;
        const session = {
            request: (req: { path: string; body?: unknown }) => {
                seenPath = req.path; seenBody = req.body as Record<string, unknown>;
                return Promise.resolve({ code: 204, body: null });
            },
        } as unknown as ApiSession;
        const out = await sendInput(session, BUFFER_ID, '/join #new');
        expect(out.accepted).toBe(true);
        expect(seenPath).toBe('/api/input');
        expect(seenBody).toEqual({ command: '/join #new', buffer_id: BUFFER_ID });
    });

    it('404 is rejected with the server error detail', async () => {
        const session = fakeSession(() => ({ code: 404, body: { error: 'Buffer not found' } }));
        const out = await sendInput(session, BUFFER_ID, '/me hi');
        expect(out.accepted).toBe(false);
        expect(out.error).toContain('Buffer not found');
    });
});

describe('requestCompletion', () => {
    const completionBody = (over: Record<string, unknown> = {}) => ({
        code: 200,
        body: {
            context: 'auto', base_word: 'ali', position_replace: 5, add_space: false,
            list: ['alice', 'alison'], ...over,
        },
    });

    it('maps candidates and byte-based replacement range onto the command', async () => {
        const session = fakeSession(() => completionBody());
        const res = await requestCompletion(session, { bufferId: BUFFER_ID, command: '/msg ali hi', cursor: 9 });
        expect(res.ok).toBe(true);
        expect(res.candidates).toEqual(['alice', 'alison']);
        expect(res.replaceStart).toBe(5);
        expect(res.replaceEnd).toBe(8); // base_word 'ali' = 3 bytes
    });

    it('multi-byte commands convert byte offsets to string indices', async () => {
        const session = fakeSession(() => completionBody({ base_word: 'æøå', position_replace: 5 }));
        const res = await requestCompletion(session, { bufferId: BUFFER_ID, command: '/msg æøå x', cursor: 8 });
        expect(res.ok).toBe(true);
        expect(res.replaceStart).toBe(5);
        expect(res.replaceEnd).toBe(8); // 3 chars = 6 bytes
    });

    it('sends the cursor as a code-point offset', async () => {
        let seenBody: Record<string, unknown> | undefined;
        const session = {
            request: (req: { body?: unknown }) => {
                seenBody = req.body as Record<string, unknown>;
                return Promise.resolve(completionBody());
            },
        } as unknown as ApiSession;
        // cursor after the emoji (JS index 6) = 6 code points? 'a😀b ali' → chars a,😀,b,' ',a,l,i
        await requestCompletion(session, { bufferId: BUFFER_ID, command: 'a😀b ali', cursor: 6 });
        expect(seenBody!.position).toBe(5); // Array.from('a😀b al') = 5 code points
    });

    it('invalid payloads fail without throwing', async () => {
        const session = fakeSession(() => ({ code: 200, body: { context: 'x' } }));
        const res = await requestCompletion(session, { bufferId: BUFFER_ID, command: 'ali', cursor: 3 });
        expect(res.ok).toBe(false);
        expect(res.error).toContain('invalid completion payload');
    });
});

describe('rankCandidates', () => {
    it('moves recently spoken nicks first, preserving base order otherwise', () => {
        const spokeAt = new Map([['alison', 100], ['alice', 200]]);
        expect(rankCandidates(['alice', 'alison', 'bob'], spokeAt)).toEqual(['alice', 'alison', 'bob']);
    });

    it('strips configured completer suffixes before matching spokeAt', () => {
        const spokeAt = new Map([['bob', 500]]);
        expect(rankCandidates(['alice', 'bob: '], spokeAt)).toEqual(['bob: ', 'alice']);
    });

    it('no recency data keeps server order', () => {
        expect(rankCandidates(['a', 'b'], new Map())).toEqual(['a', 'b']);
    });
});

describe('completionInsert', () => {
    it('adds a trailing space to a bare nick candidate (older relay API)', () => {
        expect(completionInsert('Bear:', false, 'auto')).toBe('Bear: ');
    });

    it('leaves a nick candidate that already ends in a space (recent WeeChat)', () => {
        expect(completionInsert('gbbot2: ', false, 'auto')).toBe('gbbot2: ');
    });

    it('respects add_space for command contexts', () => {
        expect(completionInsert('version', true, 'command')).toBe('version ');
        expect(completionInsert('probebot', true, 'command_arg')).toBe('probebot ');
        expect(completionInsert('foo', false, 'command_arg')).toBe('foo');
    });
});
