/**
 * Characterization coverage for buffer object identity.
 *
 * Equality-aware selectors are only as good as the publication discipline they read,
 * so this file records what the writers do TODAY — before any selector relies on it.
 * Two groups:
 *
 *   "preserves" — behaviour a selector may already depend on.
 *   "known cost" — behaviour that currently defeats reference identity. Each one is
 *   pinned here so a later selector cannot quietly assume the opposite. When one
 *   is fixed, its test is updated in the
 *   same commit, not deleted.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { get } from 'svelte/store';
import {
    buffers,
    servers,
    activeBufferId,
    previousBufferId,
    currentBuffer,
    setActiveBuffer,
    localUnreadBuffers,
    hotlistClearedBuffers,
    endSyncPhase,
} from '#lib/stores/models.ts';
import {
    getEffectiveUnread,
    sortBuffers,
    sortedVisibleBuffers,
} from '#lib/stores/models.ts';
import { hotlistEntries, sidebarOrder, sidebarRows } from '#lib/stores/bufferProjections.ts';
import { getDisplayName } from '#lib/utils.ts';
import type { BufferData, BufferPresentation, ProtocolMessage } from '#lib/types.ts';
import { createApiStoreReducers, flushApiLineBatch } from '#lib/api/api-store-reducers.ts';
import type { HotlistSnapshot, LineSnapshot } from '#lib/api/api-contracts.ts';
import type { ApiBufferId, ApiLineId } from '#lib/api/api-ids.ts';

// Indicator side effects are irrelevant here and must not reach canvas or audio.
vi.mock('#lib/notifications.ts', () => ({
    createHighlight: vi.fn(),
    playNotificationSound: vi.fn(),
    updateTitle: vi.fn(),
    updateFavico: vi.fn(),
    startIndicatorOwner: () => () => {},
    refreshIndicators: vi.fn(),
}));
vi.mock('#lib/windowFocus.ts', () => ({
    initWindowFocusTracking: vi.fn(() => Promise.resolve(() => {})),
    isWindowFocused: () => false,
}));
const settingsMock = vi.hoisted(() => {
    let value: Record<string, unknown> = {
        hostField: '', port: '9001', tls: false, password: '',
        savepassword: false, autoconnect: false, useTotp: false,
        theme: 'dark', fontfamily: '', fontsize: '', customCSS: '',
        iToken: '', iAlb: '', onlyUnread: false, noembed: false,
        alwaysnicklist: false, orderbyserver: false,
        readlineBindings: false, useFavico: false, soundnotification: false,
        enableMathjax: false, enableQuickKeys: false, showNicklist: true,
        showQuickKeys: false, showJumpKeys: false, highlightWords: '',
        hotlistsync: true,
    };
    const subs = new Set<(val: Record<string, unknown>) => void>();
    return {
        settings: {
            subscribe: (fn: (val: Record<string, unknown>) => void) => {
                subs.add(fn);
                fn(value);
                return () => { subs.delete(fn); };
            },
        },
        apply: (patch: Record<string, unknown>) => {
            value = { ...value, ...patch };
            for (const fn of [...subs]) fn(value);
        },
        reset: () => { value = { ...value, onlyUnread: false, orderbyserver: false }; },
    };
});

vi.mock('#lib/stores/settings.ts', () => ({
    settings: settingsMock.settings,
    updateSettings: settingsMock.apply,
    updatePartialSettings: settingsMock.apply,
}));

const {
    handleBufferLineAdded,
    handleEvent,
    handleHotlistInfo,
    handleNicklist,
    handleNicklistDiff,
    flushLineBatch,
} = await import('#lib/stores/handlers.ts');

function makeBuffer(id: string, overrides: Partial<BufferData> = {}): BufferData {
    return {
        id,
        fullName: overrides.fullName ?? `irc.server.${id}`,
        shortName: overrides.shortName ?? id,
        hidden: false,
        trimmedName: id,
        nameClasses: [],
        prefix: '#',
        number: Number(id.replace('0x', '')) || 1,
        title: [],
        rtitle: '',
        lines: [],
        requestedLines: 0,
        allLinesFetched: false,
        lastSeen: -1,
        localUnread: 0,
        unread: 0,
        notification: 0,
        notify: 3,
        nicklist: {},
        serverSortKey: 'irc.server.test',
        indent: true,
        bufferType: 2,
        type: 'channel',
        plugin: 'irc',
        server: 'server',
        hideBufferLineTimes: false,
        pinned: false,
        active: false,
        ...overrides,
    };
}

/** One `_buffer_line_added` message carrying `count` lines for `bufferId`. */
function lineMessage(bufferId: string, count: number, date = 1735689600000): ProtocolMessage {
    return {
        // `handleEvent` dispatches on `id`; without it the message is simply
        // unhandled and a test that floods through `handleEvent` would assert
        // "nothing repainted" against a flood that never happened.
        id: '_buffer_line_added',
        objects: [
            {
                pointer: bufferId,
                content: Array.from({ length: count }, (_unused, i) => ({
                    buffer: bufferId,
                    date: date + i,
                    date_long: 0,
                    prefix: '<testuser>',
                    message: `msg ${date + i}`,
                    tags_array: ['irc_privmsg'],
                    displayed: 1,
                    notify_level: 1,
                    highlight: 0,
                })),
            },
        ],
    } as unknown as ProtocolMessage;
}

function hotlistMessage(entries: { buffer: string; unread: number; notification?: number }[]): ProtocolMessage {
    return {
        objects: [
            {
                pointer: '0x0',
                content: entries.map((e) => ({
                    buffer: e.buffer,
                    count: [0, e.unread, e.notification ?? 0, 0],
                })),
            },
        ],
    } as unknown as ProtocolMessage;
}

/** Count notifications a store emits while `body` runs (the initial read is not counted). */
function countNotifications<T>(store: { subscribe: (fn: (v: T) => void) => () => void }, body: () => void): number {
    let notifications = 0;
    let primed = false;
    const unsub = store.subscribe(() => {
        if (primed) notifications += 1;
    });
    // subscribe() invokes the callback once synchronously; that initial read is
    // not a publication, so priming happens before `body` runs.
    primed = true;
    try {
        body();
    } finally {
        unsub();
    }
    return notifications;
}

beforeEach(() => {
    vi.useFakeTimers();
    endSyncPhase();
    buffers.set({});
    servers.set({});
    activeBufferId.set('');
    previousBufferId.set('');
    localUnreadBuffers.set(new Set());
    hotlistClearedBuffers.set(new Set());
});

afterEach(() => {
    vi.useRealTimers();
});

describe('buffer reference preservation (current behaviour)', () => {
    it('a background-buffer line add leaves every other buffer object identical', () => {
        const a = makeBuffer('0x1', { active: true });
        const b = makeBuffer('0x2');
        const c = makeBuffer('0x3');
        buffers.set({ '0x1': a, '0x2': b, '0x3': c });
        activeBufferId.set('0x1');

        handleBufferLineAdded(lineMessage('0x2', 3));
        flushQueuedLines();

        const after = get(buffers);
        expect(after['0x1']).toBe(a);
        expect(after['0x3']).toBe(c);
        expect(after['0x2']).not.toBe(b);
        expect(after['0x2']!.lines.length).toBe(3);
    });

    it('replaces the lines array but keeps the retained line objects', () => {
        const b = makeBuffer('0x2');
        buffers.set({ '0x2': b });
        activeBufferId.set('');

        handleBufferLineAdded(lineMessage('0x2', 2));
        flushQueuedLines();
        const firstLines = get(buffers)['0x2']!.lines;
        const firstLine = firstLines[0]!;

        handleBufferLineAdded(lineMessage('0x2', 1, 1735689700000));
        flushQueuedLines();

        const after = get(buffers)['0x2']!;
        expect(after.lines).not.toBe(firstLines);
        expect(after.lines[0]).toBe(firstLine);
    });

    it('setActiveBuffer re-references only the buffer left and the buffer entered', async () => {
        const { setActiveBuffer } = await import('#lib/stores/models.ts');
        const a = makeBuffer('0x1', { active: true });
        const b = makeBuffer('0x2');
        const c = makeBuffer('0x3');
        const d = makeBuffer('0x4');
        buffers.set({ '0x1': a, '0x2': b, '0x3': c, '0x4': d });
        activeBufferId.set('0x1');

        setActiveBuffer('0x2');

        const after = get(buffers);
        expect(after['0x1']).not.toBe(a);
        expect(after['0x2']).not.toBe(b);
        expect(after['0x3']).toBe(c);
        expect(after['0x4']).toBe(d);
    });
});

describe('currentBuffer publication (selective)', () => {
    it('does not notify active-buffer consumers when a background buffer receives lines', () => {
        buffers.set({ '0x1': makeBuffer('0x1', { active: true }), '0x2': makeBuffer('0x2') });
        activeBufferId.set('0x1');

        // Was 1 (pinned here before the change): `currentBuffer` subscribed to the
        // whole map and Svelte's `safe_not_equal` treats every object as changed
        // (`a !== b || typeof a === 'object'`), so re-setting the same BufferData
        // reference still notified. It is now driven by a numeric revision of the
        // active buffer object, which Svelte *can* compare, so a background
        // publication notifies nobody.
        const notifications = countNotifications(currentBuffer, () => {
            handleBufferLineAdded(lineMessage('0x2', 5));
            flushQueuedLines();
        });
        expect(notifications).toBe(0);
    });

    it('does not notify on a hotlist poll that changed nothing', () => {
        buffers.set({ '0x1': makeBuffer('0x1', { active: true }), '0x2': makeBuffer('0x2') });
        activeBufferId.set('0x1');

        // Was 1 per poll. The poll still republishes the map — and still clones
        // background buffers (a known cost below) — but the active buffer's object
        // is untouched, so its revision is unchanged and the selector is silent.
        const notifications = countNotifications(currentBuffer, () => {
            handleHotlistInfo(hotlistMessage([]));
        });
        expect(notifications).toBe(0);
    });

    it('still notifies when the active buffer itself receives a line', () => {
        buffers.set({ '0x1': makeBuffer('0x1', { active: true }), '0x2': makeBuffer('0x2') });
        activeBufferId.set('0x1');

        // The other half of the contract: selectivity must not swallow the
        // messages the user is looking at.
        const notifications = countNotifications(currentBuffer, () => {
            handleBufferLineAdded(lineMessage('0x1', 5));
            flushQueuedLines();
        });
        expect(notifications).toBe(1);
    });

    it('still notifies when the selection changes', async () => {
        const { setActiveBuffer } = await import('#lib/stores/models.ts');
        buffers.set({ '0x1': makeBuffer('0x1', { active: true }), '0x2': makeBuffer('0x2') });
        activeBufferId.set('0x1');
        get(currentBuffer);

        const notifications = countNotifications(currentBuffer, () => {
            setActiveBuffer('0x2');
        });
        expect(notifications).toBe(1);
        expect(get(currentBuffer)?.id).toBe('0x2');
    });
});

describe('known identity costs (must be fixed before selectors rely on references)', () => {
    it('the legacy hotlist snapshot re-references every background buffer', () => {
        const a = makeBuffer('0x1', { active: true });
        const b = makeBuffer('0x2');
        const c = makeBuffer('0x3');
        buffers.set({ '0x1': a, '0x2': b, '0x3': c });
        activeBufferId.set('0x1');

        // An empty hotlist changes no count, yet handlers.ts:1197-1203 clones every
        // id except active and previous and :1337-1344 publishes all of them.
        handleHotlistInfo(hotlistMessage([]));

        const after = get(buffers);
        expect(after['0x1']).toBe(a);
        expect(after['0x2']).not.toBe(b);
        expect(after['0x3']).not.toBe(c);
        expect(after['0x2']!.unread).toBe(0);
        expect(after['0x3']!.unread).toBe(0);
    });

    it('the API hotlist reducer re-references only buffers present in the snapshot', () => {
        const idA = 1759000000000001 as ApiBufferId;
        const idB = 1759000000000002 as ApiBufferId;
        const keyA = String(idA);
        const keyB = String(idB);
        const a = makeBuffer(keyA);
        const b = makeBuffer(keyB, { active: true });
        buffers.set({ [keyA]: a, [keyB]: b });
        activeBufferId.set(keyB);

        const snapshot: HotlistSnapshot = {
            priority: 2,
            date: '2026-10-08T12:00:00.000Z',
            counts: { low: 0, message: 4, private: 0, highlight: 0 },
        };
        createApiStoreReducers().hotlist(new Map([[idA, snapshot]]));

        const after = get(buffers);
        expect(after[keyA]).not.toBe(a);
        expect(after[keyA]!.unread).toBe(4);
        expect(after[keyB]).toBe(b);
    });

    it('nick group objects survive a publication while their nicks array mutates', () => {
        const b = makeBuffer('0x2');
        buffers.set({ '0x2': b });

        handleNicklist(
            {
                objects: [
                    {
                        pointer: '0x2',
                        content: [
                            { pointers: ['0x2'], name: 'irc', visible: 'irc', group: 1 },
                            { pointers: ['0x2'], prefix: '@', visible: '1', name: 'alice', _diff: 43 },
                        ],
                    },
                ],
            } as unknown as ProtocolMessage,
            true,
        );
        const groupAfterFirst = get(buffers)['0x2']!.nicklist['irc']!;
        expect(groupAfterFirst.nicks.map((n) => n.name)).toEqual(['alice']);

        handleNicklistDiff(
            {
                objects: [
                    {
                        pointer: '0x2',
                        content: [
                            { pointers: ['0x2'], name: 'irc', visible: 'irc', group: 1, _diff: 43 },
                            { pointers: ['0x2'], prefix: '', visible: '1', name: 'bob', _diff: 43 },
                        ],
                    },
                ],
            } as unknown as ProtocolMessage,
        );

        const after = get(buffers)['0x2']!;
        // The published buffer is a new object, but `updateBufferDeep` copies
        // `nicklist` shallowly and the handler mutated the group in place first:
        // the group reference is unchanged while its contents grew.
        expect(after).not.toBe(b);
        expect(after.nicklist['irc']).toBe(groupAfterFirst);
        expect(after.nicklist['irc']!.nicks.map((n) => n.name)).toEqual(['alice', 'bob']);
        expect(groupAfterFirst.nicks.length).toBe(2);
    });

    it('the API line flush shares the lineIdsSeen Set with the previous publication', () => {
        const id = 1759000000000003 as ApiBufferId;
        const key = String(id);
        buffers.set({ [key]: makeBuffer(key) });
        const reducers = createApiStoreReducers();

        const line = (n: number): LineSnapshot => ({
            id: n as ApiLineId,
            epochMs: Date.parse('2026-10-08T12:00:00.000Z') + n,
            displayed: true,
            highlight: false,
            notifyLevel: 1,
            prefix: 'alice',
            message: `msg ${n}`,
            tags: ['notify_message'],
        });

        reducers.lineAdded(id, line(1));
        flushApiLineBatch();
        const published = get(buffers)[key]!;
        const seenAfterFirst = published.lineIdsSeen!;
        expect(seenAfterFirst.size).toBe(1);

        reducers.lineAdded(id, line(2));
        flushApiLineBatch();
        const after = get(buffers)[key]!;

        // `{ ...buffer, lines: [...buffer.lines] }` (api-store-reducers.ts:150) copies
        // the array but not the Set, so the older published buffer now reports two
        // ids it never had. Anything that treats `lineIdsSeen` as an immutable
        // snapshot of a publication is wrong today.
        expect(after.lineIdsSeen).toBe(seenAfterFirst);
        expect(seenAfterFirst.size).toBe(2);
        expect(published.lineIdsSeen!.size).toBe(2);
    });

    it('handleHotlistInfo mutates the published servers entries in place', () => {
        const b = makeBuffer('0x2');
        buffers.set({ '0x2': b });
        const serverEntry = { id: '0x2', unread: 0 };
        servers.set({ 'irc.server': serverEntry });
        activeBufferId.set('');

        handleHotlistInfo(hotlistMessage([{ buffer: '0x2', unread: 7 }]));

        const after = get(servers)['irc.server']!;
        expect(after).toBe(serverEntry);
        expect(after.unread).toBe(7);
        expect(serverEntry.unread).toBe(7);
    });
});

/**
 * Legacy `_buffer_line_added` batches through a rAF queue with a timer fallback.
 * Fake timers advance the rAF; the explicit flush covers a queue filled synchronously
 * so no test measures a half-applied batch.
 */
function flushQueuedLines(): void {
    vi.advanceTimersByTime(200);
    flushLineBatch();
}

/**
 * The invariant a selective current-buffer store depends on.
 *
 * A selector that stops publishing when "the active buffer did not change" is only
 * correct if the writers honour one of two contracts on every publication:
 *
 *   1. the active buffer's object reference is replaced when its content changed; or
 *   2. the reference is preserved only when nothing about it changed.
 *
 * The dangerous third case — same reference, mutated content — makes any equality
 * check report "nothing happened" for a change the user can see. These tests fail
 * if a writer introduces that case, which is why they land before the mechanism.
 */
describe('publication invariant (guards a selective currentBuffer)', () => {
    /**
     * Compare the published snapshot of every buffer against the store after an
     * operation. A preserved reference must mean preserved content.
     */
    function expectNoSilentInPlaceMutation(before: Record<string, BufferData>): void {
        const after = get(buffers);
        for (const [id, prev] of Object.entries(before)) {
            const next = after[id];
            if (next === undefined) continue;
            if (next === prev) {
                expect(
                    JSON.stringify(next),
                    `buffer ${id} was republished as the same object with mutated content`,
                ).toEqual(JSON.stringify(prev));
            }
        }
    }

    function snapshot(): Record<string, BufferData> {
        return { ...get(buffers) };
    }

    it('legacy background flood leaves the active buffer object untouched', () => {
        const active = makeBuffer('0x1', { active: true });
        const background = makeBuffer('0x2');
        buffers.set({ '0x1': active, '0x2': background });
        activeBufferId.set('0x1');

        const before = snapshot();
        for (let i = 0; i < 5; i++) {
            handleBufferLineAdded(lineMessage('0x2', 1, 1735689600000 + i));
        }
        flushQueuedLines();

        expect(get(buffers)['0x1']).toBe(active);
        expectNoSilentInPlaceMutation(before);
    });

    it('an unchanged hotlist poll leaves every buffer object untouched', () => {
        const active = makeBuffer('0x1', { active: true, unread: 0 });
        const background = makeBuffer('0x2', { unread: 4 });
        buffers.set({ '0x1': active, '0x2': background });
        activeBufferId.set('0x1');

        const before = snapshot();
        handleHotlistInfo(hotlistMessage([{ buffer: '0x2', unread: 4 }]));

        expect(get(buffers)['0x1']).toBe(active);
        expectNoSilentInPlaceMutation(before);
    });

    it('a nick change on a background buffer leaves the active buffer object untouched', () => {
        const active = makeBuffer('0x1', { active: true });
        const background = makeBuffer('0x2');
        buffers.set({ '0x1': active, '0x2': background });
        activeBufferId.set('0x1');

        const before = snapshot();
        handleNicklistDiff(
            {
                objects: [{ pointer: '0x2', nick: 'tor', action: 'add' }],
            } as unknown as ProtocolMessage,
        );

        expect(get(buffers)['0x1']).toBe(active);
        expectNoSilentInPlaceMutation(before);
    });

    it('an API buffer-info snapshot republishes the buffer it mutated', () => {
        const reducers = createApiStoreReducers();
        const active = makeBuffer('1', { active: true, title: ['old topic'] });
        buffers.set({ '1': active });
        activeBufferId.set('1');

        reducers.buffers([
            {
                id: 1 as unknown as ApiBufferId,
                name: 'irc.server.1',
                shortName: '1',
                number: 1,
                contentType: 'formatted',
                semanticType: 'channel',
                hidden: false,
                title: 'new topic',
                modes: 'hv',
                inputPrompt: '',
                input: '',
                inputPosition: 0,
                inputMultiline: false,
                hasNicklist: true,
                nicklistCaseSensitive: false,
                nicklistDisplayGroups: false,
                timeDisplayed: true,
                localVariables: {},
                lastReadLineId: -1,
            } satisfies BufferSnapshot,
        ]);

        const published = get(buffers)['1']!;
        // The point of this test is the contract, not the current implementation:
        // a buffer whose visible metadata changed must not stay the same object,
        // because that is exactly the case an equality-aware selector would
        // classify as "nothing happened".
        expect(published.title.map((t) => t.text).join('')).toBe('new topic');
        expect(published).not.toBe(active);
        expect(active.title).toEqual(['old topic']);
    });
});

/**
 * The sidebar reads a compact projection, not the buffer map.
 *
 * These are semantic requirements, not implementation details: a message in a
 * buffer nobody is looking at must not repaint the sidebar, a count that changes
 * must repaint it, and `onlyUnread` membership follows the count rule.
 */
describe('sidebar projection', () => {
    /** Build a `count`-buffer map with `0x1` active. */
    function seedSidebar(count: number) {
        const map: Record<string, BufferData> = {};
        for (let i = 1; i <= count; i++) {
            map[`0x${i}`] = makeBuffer(`0x${i}`, {
                shortName: i === 1 ? '#active' : `#bg${i}`,
                trimmedName: i === 1 ? '#active' : `#bg${i}`,
                fullName: i === 1 ? '#active' : `#bg${i}`,
                active: i === 1,
            });
        }
        buffers.set(map);
        activeBufferId.set('0x1');
    }

    /** Count sidebar publications while `body` runs (the initial read is not counted). */
    function countSidebarPublications(body: () => void): number {
        return countNotifications(sidebarRows, body);
    }

    /**
     * A real message in a background buffer DOES change that row — its unread
     * badge appears — so one publication is the correct outcome, and a batch of
     * them is still one publication because the transport coalesces the batch.
     * What must not happen is the structural re-sort: the buffer's position in
     * the sidebar is unchanged by arriving traffic.
     */
    it('a background message repaints the row once and never re-sorts', () => {
        seedSidebar(100);
        const before = get(sidebarRows);
        const orderBefore = [...get(sidebarOrder)];

        const publications = countSidebarPublications(() => {
            for (let i = 0; i < 5; i++) {
                handleEvent(lineMessage('0x2', 1, 1735689600000 + i));
            }
            flushLineBatch();
        });

        expect(publications).toBe(1);
        expect(get(sidebarRows)).not.toBe(before);
        expect(getEffectiveUnread(get(sidebarRows).find((r) => r.id === '0x2')!)).toBe(5);

        const orderPublications = countNotifications(sidebarOrder, () => {
            handleEvent(lineMessage('0x3', 1, 1735689700000));
            flushLineBatch();
        });
        expect(orderPublications).toBe(0);
        expect(get(sidebarOrder)).toEqual(orderBefore);
    });

    it('an unchanged hotlist poll does not repaint the sidebar', () => {
        seedSidebar(100);
        const before = get(sidebarRows);

        const publications = countSidebarPublications(() => {
            handleHotlistInfo(hotlistMessage([]));
        });

        expect(publications).toBe(0);
        expect(get(sidebarRows)).toBe(before);
    });

    it('a row is presentation only — it never carries message history', () => {
        seedSidebar(10);
        const row = get(sidebarRows)[0]!;

        expect(row).not.toHaveProperty('lines');
        expect(row).not.toHaveProperty('nicklist');
        expect(row).not.toHaveProperty('lineIdsSeen');
    });

    it('a changed unread count repaints the sidebar', () => {
        seedSidebar(20);
        const before = get(sidebarRows);

        // A background buffer: the hotlist poll deliberately skips the active
        // buffer, whose counts are managed by selection instead.
        const publications = countSidebarPublications(() => {
            handleHotlistInfo(hotlistMessage([{ buffer: '0x2', unread: 0, notification: 2 }]));
        });

        expect(publications).toBe(1);
        expect(get(sidebarRows)).not.toBe(before);
        expect(getEffectiveUnread(get(sidebarRows).find((r) => r.id === '0x2')!)).toBe(2);
    });

    it('onlyUnread membership follows the count rule', () => {
        seedSidebar(20);
        settingsMock.apply({ onlyUnread: true });

        // Every buffer is read and none is pinned: only the active buffer remains.
        expect(get(sidebarRows).map((r) => r.id)).toEqual(['0x1']);

        countSidebarPublications(() => {
            handleHotlistInfo(hotlistMessage([{ buffer: '0x2', unread: 0, notification: 1 }]));
        });
        expect(get(sidebarRows).map((r) => r.id)).toEqual(['0x1', '0x2']);

        // Reading a buffer removes it from the hotlist; the sidebar follows the
        // count, not the fact that a message once arrived.
        setActiveBuffer('0x2');
        expect(get(sidebarRows).map((r) => r.id)).toEqual(['0x2']);

        settingsMock.apply({ onlyUnread: false });
    });

    it('quick-key order is the sorted list, not the filtered one', () => {
        seedSidebar(20);
        settingsMock.apply({ onlyUnread: true });

        const filtered = get(sidebarRows).map((r) => r.id);
        const order = get(sidebarOrder);

        expect(filtered.length).toBeLessThan(order.length);
        // A quick key is a position in the sorted buffer list, so hiding rows
        // cannot move one onto a different buffer.
        expect(order).toEqual(Array.from({ length: 20 }, (_unused, i) => `0x${i + 1}`));

        settingsMock.apply({ onlyUnread: false });
    });

    it('an unchanged hotlist poll does not repaint the hotlist strip', () => {
        seedSidebar(100);
        handleHotlistInfo(hotlistMessage([{ buffer: '0x2', unread: 0, notification: 2 }]));
        const before = get(hotlistEntries);

        const publications = countNotifications(hotlistEntries, () => {
            handleHotlistInfo(hotlistMessage([{ buffer: '0x2', unread: 0, notification: 2 }]));
        });

        expect(publications).toBe(0);
        expect(get(hotlistEntries)).toBe(before);
    });

    it('the hotlist keeps its own count rule', () => {
        seedSidebar(10);
        // localUnread alone is invisible to the hotlist: it reads WeeChat's
        // notification/unread, not the sidebar's effective-unread aggregate.
        buffers.update((map) => {
            const copy = { ...map };
            copy['0x3'] = { ...copy['0x3']!, localUnread: 4 };
            return copy;
        });
        expect(get(hotlistEntries).map((r) => r.id)).toEqual([]);

        handleHotlistInfo(hotlistMessage([{ buffer: '0x4', unread: 1, notification: 0 }]));
        expect(get(hotlistEntries).map((r) => r.id)).toEqual(['0x4']);
    });

    it('a rename repaints the sidebar exactly once', () => {
        seedSidebar(20);

        const publications = countSidebarPublications(() => {
            handleEvent({
                id: '_buffer_renamed',
                objects: [{
                    pointer: '0x0',
                    content: [{ pointers: ['0x2'], full_name: '#renamed', short_name: '#renamed' }],
                }],
            } as unknown as ProtocolMessage);
        });

        expect(publications).toBe(1);
        expect(getDisplayName(get(sidebarRows).find((r) => r.id === '0x2')!)).toBe('renamed');
    });
});

describe('sidebar ordering equivalence (guards the swipe path)', () => {
    /**
     * The mobile vertical-swipe buffer switch used to read
     * `$sortedVisibleBuffers` inside its handler, which kept a component-lifetime
     * subscription to a full filter+sort that re-ran on every buffer publication
     * — including message-only traffic that cannot reorder anything. It now reads
     * `sidebarOrder`. That is only safe if the two orderings agree, so the swipe
     * still moves to the buffer the sidebar shows next to the current one.
     */
    function seedOrderingCase(orderbyserver: boolean) {
        settingsMock.apply({ orderbyserver });
        buffers.set({
            '0x1': makeBuffer('0x1', { server: 'freenode', serverSortKey: 'irc.freenode.#a' }),
            '0x2': makeBuffer('0x2', { server: 'libera', serverSortKey: 'irc.libera.#b', hidden: true }),
            '0x3': makeBuffer('0x3', { server: 'freenode', serverSortKey: 'irc.freenode.#c', pinned: true }),
            '0x4': makeBuffer('0x4', { server: 'libera', serverSortKey: 'irc.libera.#d' }),
        });
        activeBufferId.set('0x1');
    }

    it('sidebarOrder matches sortedVisibleBuffers for both ordering settings', () => {
        for (const orderbyserver of [false, true]) {
            seedOrderingCase(orderbyserver);

            const viaSort = get(sortedVisibleBuffers).map((b) => b.id);
            const viaProjection = get(sidebarOrder);

            expect(viaProjection).toEqual(viaSort);
            // Hidden buffers are excluded by both, so a swipe cannot land on one.
            expect(viaProjection).not.toContain('0x2');
            expect(viaProjection.length).toBe(3);
        }
    });

    it('a message-only change does not re-sort the sidebar', () => {
        seedOrderingCase(false);

        const orderBefore = [...get(sidebarOrder)];
        const publications = countNotifications(sidebarOrder, () => {
            const rows = countNotifications(sidebarRows, () => {
                handleEvent(lineMessage('0x4', 20));
                flushLineBatch();
            });
            // The row projection does follow the real count change, so the unread
            // badge is not hidden behind a memoized order.
            expect(rows).toBeGreaterThan(0);
            expect(get(sidebarRows).find((r) => r.id === '0x4')!.unread).toBeGreaterThan(0);
        });

        // Zero means the structural projection genuinely did not re-emit: no sort
        // runs for message traffic, and the order is byte-identical.
        expect(publications).toBe(0);
        expect(get(sidebarOrder)).toEqual(orderBefore);
    });
});
