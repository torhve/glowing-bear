import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import {
    byteOffsetToCharIndex, charIndexToCodePointOffset, utf8Length,
    fetchHistory, sendInput, requestCompletion, rankCandidates,
} from '#lib/api/api-features.ts';
import { createApiStoreReducers } from '#lib/api/api-store-reducers.ts';
import { buffers } from '#lib/stores/models.ts';
import type { ApiSession, ApiSessionResponse } from '#lib/api/api-session.ts';
import type { ApiBufferId } from '#lib/api/api-ids.ts';
import type { BufferSnapshot } from '#lib/api/api-contracts.ts';

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

beforeEach(() => {
    buffers.set({});
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
        // requestedLines counts only lines kept for display.
        expect(buf.requestedLines).toBe(1);
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
