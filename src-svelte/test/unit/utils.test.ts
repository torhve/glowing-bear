import { describe, it, expect, beforeEach, vi } from 'vitest';
import { get } from 'svelte/store';
import { bufferMatchesSearch, completeNick } from '$lib/utils';
import { buffers, activeBufferId, wconfig, sortBuffers } from '$lib/stores/models';
import type { BufferData } from '$lib/types';

describe('bufferMatchesSearch', () => {
    const mockBuffer = {
        fullName: '#general',
        shortName: '#general',
        trimmedName: 'general',
    };

    it('matches on full name', () => {
        expect(bufferMatchesSearch(mockBuffer, '#general')).toBe(true);
    });

    it('matches on short name', () => {
        expect(bufferMatchesSearch(mockBuffer, '#general')).toBe(true);
    });

    it('matches on trimmed name', () => {
        expect(bufferMatchesSearch(mockBuffer, 'general')).toBe(true);
    });

    it('is case-insensitive', () => {
        expect(bufferMatchesSearch(mockBuffer, '#GENERAL')).toBe(true);
        expect(bufferMatchesSearch(mockBuffer, 'General')).toBe(true);
    });

    it('returns false for non-matching search', () => {
        expect(bufferMatchesSearch(mockBuffer, '#other')).toBe(false);
    });

    it('matches all when search is empty', () => {
        expect(bufferMatchesSearch(mockBuffer, '')).toBe(true);
    });

    it('matches partial strings', () => {
        expect(bufferMatchesSearch(mockBuffer, 'gene')).toBe(true);
    });
});

describe('sortBuffers with pinned', () => {
    function makeBuffer(overrides: Partial<BufferData> = {}): BufferData {
        return {
            id: '0x' + Math.random().toString(16).slice(2),
            fullName: overrides.fullName || '#test',
            shortName: overrides.shortName || '#test',
            hidden: false,
            trimmedName: 'test',
            nameClasses: [],
            prefix: '',
            number: overrides.number || 0,
            title: [],
            rtitle: '#test',
            lines: [],
            requestedLines: 0,
            allLinesFetched: false,
            lastSeen: -1,
            unread: 0,
            notification: 0,
            notify: 3,
            nicklist: {},
            serverSortKey: 'irc.test.#test',
            indent: true,
            bufferType: 0,
            type: 'channel',
            plugin: 'irc',
            server: 'test',
            hideBufferLineTimes: false,
            pinned: overrides.pinned || false,
            active: false,
            ...overrides
        } as BufferData;
    }

    it('sorts pinned buffers before unpinned (no server grouping)', () => {
        const pinned = makeBuffer({ shortName: '#pinned', number: 5, pinned: true });
        const unpinned = makeBuffer({ shortName: '#unpinned', number: 2, pinned: false });
        const result = sortBuffers([unpinned, pinned], false);
        expect(result[0].shortName).toBe('#pinned');
        expect(result[1].shortName).toBe('#unpinned');
    });

    it('preserves relative order among pinned buffers', () => {
        const p1 = makeBuffer({ shortName: '#p1', number: 5, pinned: true });
        const p2 = makeBuffer({ shortName: '#p2', number: 3, pinned: true });
        const u1 = makeBuffer({ shortName: '#u1', number: 1 });
        const result = sortBuffers([p1, p2, u1], false);
        expect(result[0].shortName).toBe('#p2');
        expect(result[1].shortName).toBe('#p1');
        expect(result[2].shortName).toBe('#u1');
    });

    it('preserves relative order among unpinned buffers', () => {
        const p1 = makeBuffer({ shortName: '#p1', number: 1, pinned: true });
        const u1 = makeBuffer({ shortName: '#u1', number: 5 });
        const u2 = makeBuffer({ shortName: '#u2', number: 3 });
        const result = sortBuffers([p1, u1, u2], false);
        expect(result[0].shortName).toBe('#p1');
        expect(result[1].shortName).toBe('#u2');
        expect(result[2].shortName).toBe('#u1');
    });

    it('sorts all pinned before all unpinned (with server grouping)', () => {
        const serverA_pinned = makeBuffer({ shortName: 'A-pinned', number: 5, pinned: true, serverSortKey: 'irc.a.#a' });
        const serverA_unpinned = makeBuffer({ shortName: 'A-unpinned', number: 2, pinned: false, serverSortKey: 'irc.a.#a' });
        const serverB_pinned = makeBuffer({ shortName: 'B-pinned', number: 3, pinned: true, serverSortKey: 'irc.b.#b' });
        const serverB_unpinned = makeBuffer({ shortName: 'B-unpinned', number: 1, pinned: false, serverSortKey: 'irc.b.#b' });

        const result = sortBuffers([serverA_unpinned, serverA_pinned, serverB_unpinned, serverB_pinned], true);

        expect(result[0].shortName).toBe('A-pinned');
        expect(result[1].shortName).toBe('B-pinned');
        expect(result[2].shortName).toBe('A-unpinned');
        expect(result[3].shortName).toBe('B-unpinned');
    });

    it('all buffers work correctly when none are pinned', () => {
        const b1 = makeBuffer({ shortName: '#c', number: 3 });
        const b2 = makeBuffer({ shortName: '#a', number: 1 });
        const b3 = makeBuffer({ shortName: '#b', number: 2 });
        const result = sortBuffers([b1, b2, b3], false);
        expect(result.map((b: BufferData) => b.shortName)).toEqual(['#a', '#b', '#c']);
    });

    it('all buffers work correctly when all are pinned', () => {
        const b1 = makeBuffer({ shortName: '#c', number: 3, pinned: true });
        const b2 = makeBuffer({ shortName: '#a', number: 1, pinned: true });
        const b3 = makeBuffer({ shortName: '#b', number: 2, pinned: true });
        const result = sortBuffers([b1, b2, b3], false);
        expect(result.map((b: BufferData) => b.shortName)).toEqual(['#a', '#b', '#c']);
    });
});

describe('completeNick', () => {
    function makeNick(name: string, spokeAt: number = Date.now()): any {
        return { name, spokeAt };
    }

    function setupChannelBuffer(nicks: any[]) {
        const buffer: BufferData = {
            id: '0x100', fullName: '#test', shortName: '#test', hidden: false,
            trimmedName: 'test', nameClasses: [], prefix: '#', number: 1,
            title: [], rtitle: '#test', lines: [], requestedLines: 0,
            allLinesFetched: false, lastSeen: -1, unread: 0, notification: 0,
            notify: 3, nicklist: { root: { nicks } }, serverSortKey: 'irc.test.#test',
            indent: true, bufferType: 0, type: 'channel', plugin: 'irc',
            server: 'test', hideBufferLineTimes: false, pinned: false, active: false
        } as BufferData;
        buffers.set({ '0x100': buffer });
        activeBufferId.set('0x100');
        wconfig.set({
            'weechat.completion.nick_completer': ':',
            'weechat.completion.nick_add_space': 'on'
        });
    }

    function setupPMBuffer(nicks: any[]) {
        const buffer: BufferData = {
            id: '0x200', fullName: 'testuser', shortName: 'testuser', hidden: false,
            trimmedName: 'testuser', nameClasses: [], prefix: '', number: 2,
            title: [], rtitle: 'testuser', lines: [], requestedLines: 0,
            allLinesFetched: false, lastSeen: -1, unread: 0, notification: 0,
            notify: 3, nicklist: { root: { nicks } }, serverSortKey: 'irc.test.testuser',
            indent: true, bufferType: 2, type: 'private', plugin: 'irc',
            server: 'test', hideBufferLineTimes: false, pinned: false, active: false
        } as BufferData;
        buffers.set({ '0x200': buffer });
        activeBufferId.set('0x200');
        wconfig.set({
            'weechat.completion.nick_completer': ':',
            'weechat.completion.nick_add_space': 'on'
        });
    }

    beforeEach(() => {
        vi.clearAllMocks();
    });

    // Case D: nick completion in the middle (no trailing space before cursor)

    describe('middle completion (Case D)', () => {
        it('completes nick after text with suffix + space', () => {
            setupChannelBuffer([makeNick('gbbot'), makeNick('other')]);
            // Input: "hello g" cursor at end
            // beforeCaret = "hello g", afterCaret = ""
            const result = completeNick('hello g', 7, null);
            expect(result).not.toBeNull();
            expect(result!.text).toBe('hello gbbot ');
            expect(result!.cursor).toBe('hello gbbot '.length);
            // iterCandidate = original prefix for next Tab
            expect(result!.iterCandidate).toBe('g');
        });

        it('completes to first matching nick when multiple match', () => {
            const baseTime = Date.now();
            setupChannelBuffer([
                makeNick('gbbot3', baseTime + 2),
                makeNick('gbbot2', baseTime + 1),
                makeNick('gbbot', baseTime)
            ]);
            // Sorted by spokeAt desc (newest first): gbbot3, gbbot2, gbbot
            // First match for "gbbo": gbbot3 (newest)
            const result = completeNick('hello gbbo', 11, null);
            expect(result).not.toBeNull();
            expect(result!.text).toBe('hello gbbot3 ');
            expect(result!.iterCandidate).toBe('gbbo');
        });

        it('swallows space after caret', () => {
            setupChannelBuffer([makeNick('gbbot'), makeNick('other')]);
            // Input: "hello g " cursor before the trailing space
            // beforeCaret = "hello g", afterCaret = " other"
            const result = completeNick('hello g other', 7, null);
            expect(result).not.toBeNull();
            // Space after caret should be swallowed
            expect(result!.text).toBe('hello gbbot other');
        });

        it('returns null when no nick matches', () => {
            setupChannelBuffer([makeNick('gbbot'), makeNick('alice')]);
            const result = completeNick('hello z', 7, null);
            expect(result).toBeNull();
        });

        it('returns null when word at cursor is empty', () => {
            setupChannelBuffer([makeNick('gbbot')]);
            const result = completeNick('hello ', 6, null);
            expect(result).toBeNull();
        });

        it('returns null when there is no buffer', () => {
            activeBufferId.set('');
            const result = completeNick('hello g', 7, null);
            expect(result).toBeNull();
        });
    });

    // Case B: nick completion at beginning of input

    describe('beginning completion (Case B)', () => {
        it('completes nick at start of input with suffix + space', () => {
            setupChannelBuffer([makeNick('gbbot'), makeNick('other')]);
            const result = completeNick('gb', 2, null);
            expect(result).not.toBeNull();
            expect(result!.text).toBe('gbbot: ');
            expect(result!.cursor).toBe('gbbot: '.length);
            expect(result!.iterCandidate).toBe('gb');
        });

        it('completes to first matching nick at beginning', () => {
            const baseTime = Date.now();
            setupChannelBuffer([
                makeNick('gbbot3', baseTime + 2),
                makeNick('gbbot2', baseTime + 1),
                makeNick('gbbot', baseTime)
            ]);
            const result = completeNick('gbbo', 4, null);
            expect(result).not.toBeNull();
            expect(result!.text).toBe('gbbot3: ');
            expect(result!.iterCandidate).toBe('gbbo');
        });

        it('swallows space after caret at beginning', () => {
            setupChannelBuffer([makeNick('gbbot')]);
            const result = completeNick('gb other', 2, null);
            expect(result).not.toBeNull();
            expect(result!.text).toBe('gbbot: other');
        });

        it('returns null when no match at beginning', () => {
            setupChannelBuffer([makeNick('alice')]);
            const result = completeNick('x', 1, null);
            expect(result).toBeNull();
        });
    });

    // Case A: iterating nicks at beginning (after initial completion)

    describe('beginning iteration (Case A)', () => {
        it('cycles to next matching nick when iterating at beginning', () => {
            const baseTime = Date.now();
            setupChannelBuffer([
                makeNick('gbbot3', baseTime + 2),
                makeNick('gbbot2', baseTime + 1),
                makeNick('gbbot', baseTime)
            ]);
            // After first Tab: input = "gbbot3: "
            // Next Tab with iterCandidate="gbbo" should cycle to gbbot2
            const result = completeNick('gbbot3: ', 8, 'gbbo');
            expect(result).not.toBeNull();
            expect(result!.text).toBe('gbbot2: ');
            expect(result!.iterCandidate).toBe('gbbo');
        });

        it('wraps around at end of matching nick list', () => {
            const baseTime = Date.now();
            setupChannelBuffer([
                makeNick('gbbot', baseTime),
                makeNick('gbbot2', baseTime + 1),
                makeNick('gbbot3', baseTime + 2)
            ]);
            // Sorted by spokeAt desc (newest first): gbbot3, gbbot2, gbbot
            // Cycle (newest-first order): gbbot → gbbot3 → gbbot2 → gbbot (wrap)
            let result = completeNick('gbbot: ', 7, 'gbbo');
            expect(result!.text).toBe('gbbot3: ');

            result = completeNick('gbbot3: ', 8, 'gbbo');
            expect(result!.text).toBe('gbbot2: ');

            result = completeNick('gbbot2: ', 8, 'gbbo');
            expect(result!.text).toBe('gbbot: ');
        });

        it('does nothing when not iterating at beginning', () => {
            setupChannelBuffer([makeNick('gbbot')]);
            // Input has already-completed nick "gbbot: " but no iterCandidate
            const result = completeNick('gbbot: ', 7, null);
            expect(result).toBeNull();
        });
    });

    // Case C: iterating nicks in middle

    describe('middle iteration (Case C)', () => {
        it('cycles to next matching nick when iterating in middle', () => {
            const baseTime = Date.now();
            setupChannelBuffer([
                makeNick('gbbot3', baseTime + 2),
                makeNick('gbbot2', baseTime + 1),
                makeNick('gbbot', baseTime)
            ]);
            // After first Tab: input = "hello gbbot3 "
            // Next Tab with iterCandidate="gbbo" should cycle to gbbot2
            const result = completeNick('hello gbbot3 ', 14, 'gbbo');
            expect(result).not.toBeNull();
            expect(result!.text).toBe('hello gbbot2 ');
            expect(result!.iterCandidate).toBe('gbbo');
        });

        it('wraps around at end of matching list in middle', () => {
            const baseTime = Date.now();
            setupChannelBuffer([
                makeNick('gbbot', baseTime),
                makeNick('gbbot2', baseTime + 1),
                makeNick('gbbot3', baseTime + 2)
            ]);
            // Sorted by spokeAt desc: gbbot3, gbbot2, gbbot
            // Cycle: gbbot → gbbot3 → gbbot2 → gbbot
            let result = completeNick('hello gbbot ', 12, 'gbbo');
            expect(result!.text).toBe('hello gbbot3 ');

            result = completeNick('hello gbbot3 ', 13, 'gbbo');
            expect(result!.text).toBe('hello gbbot2 ');

            result = completeNick('hello gbbot2 ', 13, 'gbbo');
            expect(result!.text).toBe('hello gbbot ');
        });

        it('does nothing when not iterating in middle', () => {
            setupChannelBuffer([makeNick('gbbot')]);
            const result = completeNick('hello gbbot ', 12, null);
            expect(result).toBeNull();
        });
    });

    // Config: nick_completer can be ":" or ": " (if ends with space, suffix is different)

    describe('nick_completer config', () => {
        it('uses config suffix ":" (default) for beginning completion', () => {
            setupChannelBuffer([makeNick('alice')]);
            wconfig.set({
                'weechat.completion.nick_completer': ':',
                'weechat.completion.nick_add_space': 'on'
            });
            const result = completeNick('a', 1, null);
            expect(result!.text).toBe('alice: ');
        });

        it('uses config suffix ": " (with trailing space) for beginning', () => {
            setupChannelBuffer([makeNick('alice')]);
            wconfig.set({
                'weechat.completion.nick_completer': ': ',
                'weechat.completion.nick_add_space': 'on'
            });
            const result = completeNick('a', 1, null);
            // suffix ": " already ends with space, so no extra space added
            expect(result!.text).toBe('alice: ');
        });
    });

    // add_space config: controls whether space is added in middle completion

    describe('nick_add_space config', () => {
        it('adds no space in middle when add_space is off', () => {
            setupChannelBuffer([makeNick('gbbot')]);
            wconfig.set({
                'weechat.completion.nick_completer': ':',
                'weechat.completion.nick_add_space': 'off'
            });
            const result = completeNick('hello g', 7, null);
            expect(result!.text).toBe('hello gbbot');
        });

        it('adds space in middle when add_space is on', () => {
            setupChannelBuffer([makeNick('gbbot')]);
            wconfig.set({
                'weechat.completion.nick_completer': ':',
                'weechat.completion.nick_add_space': 'on'
            });
            const result = completeNick('hello g', 7, null);
            expect(result!.text).toBe('hello gbbot ');
        });
    });

    // PM buffers use same suffix logic as channels (config-driven, not special)

    describe('PM buffer', () => {
        it('completes with config suffix in PM buffer', () => {
            setupPMBuffer([makeNick('friend1'), makeNick('friend2')]);
            const result = completeNick('hel f', 5, null);
            expect(result).not.toBeNull();
            expect(result!.text).toBe('hel friend1 ');
        });
    });
});
