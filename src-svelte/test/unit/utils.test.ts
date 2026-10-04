import { describe, it, expect, beforeEach, vi } from 'vitest';
import { get } from 'svelte/store';
import { bufferMatchesSearch } from '#lib/utils.ts';
import { buffers, activeBufferId, wconfig, sortBuffers } from '#lib/stores/models.ts';
import type { BufferData } from '#lib/types.ts';

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
        const serverA_pinned = makeBuffer({ shortName: 'A-pinned', number: 5, pinned: true, server: 'alpha' });
        const serverA_unpinned = makeBuffer({ shortName: 'A-unpinned', number: 2, pinned: false, server: 'alpha' });
        const serverB_pinned = makeBuffer({ shortName: 'B-pinned', number: 3, pinned: true, server: 'beta' });
        const serverB_unpinned = makeBuffer({ shortName: 'B-unpinned', number: 1, pinned: false, server: 'beta' });

        const result = sortBuffers([serverA_unpinned, serverA_pinned, serverB_unpinned, serverB_pinned], true);

        // Pinned tier first (sorted by plugin+server, then number within each server)
        expect(result[0].shortName).toBe('A-pinned');
        expect(result[1].shortName).toBe('B-pinned');
        // Unpinned tier second
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


