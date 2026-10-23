import { describe, it, expect, beforeEach, vi } from 'vitest';
import { get } from 'svelte/store';
import {
    buffers,
    setActiveBuffer,
    getReadBoundaryIndex,
    applyServerReadMarker,
    resolveReadBoundaryAfterHistory,
    isUserMessageLine,
    createBuffer,
    createBufferLine,
} from '#lib/stores/models.ts';
import type { BufferData, BufferLine } from '#lib/types.ts';

// Mocks models.ts needs to load without localStorage or browser side effects.
vi.mock('#lib/stores/settings.ts', async () => (await import('./helpers/mockSettings.ts')).mockSettings({port: '9001', fontsize: '', noembed: false, orderbyserver: false, useFavico: false, soundnotification: false, enableQuickKeys: false}));

vi.mock('#lib/notifications.ts', async () => (await import('./helpers/mockNotifications.ts')).mockNotifications());

vi.mock('#lib/windowFocus.ts', () => ({
    initWindowFocusTracking: vi.fn(() => Promise.resolve(() => {})),
    isWindowFocused: () => typeof document !== 'undefined' && !document.hidden,
}));

vi.mock('#lib/stores/bufferResume.ts', () => ({
    lastBufferId: {
        subscribe: (fn: (val: string) => void) => { fn(''); return () => {}; },
        set: vi.fn(),
    },
    recordLastBuffer: vi.fn(),
    shouldResume: vi.fn().mockReturnValue(false),
}));


/** Every line in this file belongs to the one buffer the tests build. */
const BUFFER_ID = '10';

function line(id: number, text: string): BufferLine {
    return createBufferLine({
        buffer: BUFFER_ID,
        date: 1_000 + id,
        prefix: `nick${id % 3}`,
        message: text,
        tags_array: ['irc_privmsg'],
        displayed: 1,
        notify_level: 1,
        highlight: 0,
        id,
    });
}

function makeBuffer(id: string, lines: BufferLine[], hotlistTotal: number = 0): BufferData {
    const buffer = createBuffer({
        pointers: [id],
        full_name: '#test',
        short_name: '#test',
        number: 10,
        local_variables: { type: 'channel' },
    });
    buffer.lines = lines;
    // The hotlist total the relay would report for this buffer.
    buffer.unread = hotlistTotal;
    buffers.set({ ...get(buffers), [id]: buffer });
    return buffer;
}

function stored(id: string): BufferData {
    const buffer = get(buffers)[id];
    if (!buffer) throw new Error(`stored(): no buffer ${id} in the store`);
    return buffer;
}

/**
 * The badge the chat view actually renders: lines after the read boundary. An
 * unresolved boundary counts every retained line, which is exactly what
 * "Fetch more lines" used to inflate.
 */
function displayedUnread(buffer: BufferData): number {
    const readEndIndex = getReadBoundaryIndex(buffer);
    const messages = buffer.lines.filter(isUserMessageLine);
    // No boundary known: every retained line counts. Written out, because the
    // comparison below would otherwise read `null` as index 0 and quietly drop
    // the first line from the count.
    if (readEndIndex === null) return messages.length;
    return readEndIndex < messages.length - 1 ? messages.length - Math.max(0, readEndIndex + 1) : 0;
}

describe('read marker across history paging (API transport)', () => {
    beforeEach(() => {
        buffers.set({});
    });

    it('keeps a marker-free buffer without an unread badge through repeated history loads', () => {
        // Bootstrap snapshot: no lines, and WeeChat reports no read marker (-1).
        const buffer = makeBuffer('10', []);
        applyServerReadMarker(buffer, -1);
        setActiveBuffer('10');
        expect(displayedUnread(stored('10'))).toBe(0);

        // First "Fetch more lines" page.
        stored('10').lines.push(...Array.from({ length: 100 }, (_, i) => line(i + 1, `msg ${i + 1}`)));
        resolveReadBoundaryAfterHistory(stored('10'));
        expect(displayedUnread(stored('10'))).toBe(0);

        // Second page: the badge must not grow with the retained window.
        stored('10').lines.unshift(...Array.from({ length: 70 }, (_, i) => line(i - 69, `older ${i - 69}`)));
        resolveReadBoundaryAfterHistory(stored('10'));

        const after = stored('10');
        expect(after.lines.length).toBe(170);
        expect(after.readBoundaryKnown).toBe(true);
        expect(displayedUnread(after)).toBe(0);
    });

    it('anchors to the WeeChat marker as soon as the retained history contains it', () => {
        const buffer = makeBuffer('10', []);
        applyServerReadMarker(buffer, 105);
        setActiveBuffer('10');

        const current = stored('10');
        current.lines.push(...Array.from({ length: 10 }, (_, i) => line(101 + i, `msg ${101 + i}`)));
        resolveReadBoundaryAfterHistory(current);

        // The boundary is the marked line itself: the five lines after it are unread.
        expect(getReadBoundaryIndex(stored('10'))).toBe(4);
        expect(displayedUnread(stored('10'))).toBe(5);
    });

    it('resolves a marker outside the retained window from the hotlist, not by claiming every line is new', () => {
        const buffer = makeBuffer('10', []);
        applyServerReadMarker(buffer, 105); // older than the newest window fetched first
        setActiveBuffer('10');
        expect(stored('10').readBoundaryKnown).toBe(false);

        // The first page only holds newer lines, so the marker is still unanchorable.
        stored('10').lines.push(...Array.from({ length: 20 }, (_, i) => line(501 + i, `msg ${501 + i}`)));
        resolveReadBoundaryAfterHistory(stored('10'));

        // WeeChat has no hotlist entry for this buffer, so the retained history is
        // read: no separator, no badge.
        expect(getReadBoundaryIndex(stored('10'))).toBe(19);
        expect(displayedUnread(stored('10'))).toBe(0);

        // A wider fetch reaches older history; the committed boundary stays put and
        // the older lines do not become unread.
        stored('10').lines.unshift(...Array.from({ length: 400 }, (_, i) => line(101 + i, `older ${101 + i}`)));
        resolveReadBoundaryAfterHistory(stored('10'));
        expect(getReadBoundaryIndex(stored('10'))).toBe(419);
        expect(displayedUnread(stored('10'))).toBe(0);
    });

    it('ignores a later snapshot that carries an older marker than the one this session committed', () => {
        makeBuffer('10', [line(1, 'a'), line(2, 'b'), line(3, 'c')]);
        applyServerReadMarker(stored('10'), 1);
        expect(getReadBoundaryIndex(stored('10'))).toBe(0);

        // The user reads to the bottom and leaves: this session commits a newer boundary.
        setActiveBuffer('10');
        setActiveBuffer('9');
        expect(getReadBoundaryIndex(stored('10'))).toBe(2);

        applyServerReadMarker(stored('10'), 1);
        expect(stored('10').serverReadLineId).toBe(1);
        expect(getReadBoundaryIndex(stored('10'))).toBe(2);
        expect(displayedUnread(stored('10'))).toBe(0);
    });

    it('leaves an empty buffer unresolved, and lines that arrive afterwards are still unread', () => {
        makeBuffer('10', []);
        setActiveBuffer('10');
        expect(stored('10').readBoundaryKnown).toBe(false);

        // History that WeeChat considers read must not become unread.
        stored('10').lines.push(line(1, 'a'), line(2, 'b'));
        resolveReadBoundaryAfterHistory(stored('10'));
        expect(displayedUnread(stored('10'))).toBe(0);

        // A genuinely new line lands after the committed boundary.
        stored('10').lines.push(line(3, 'live'));
        expect(displayedUnread(stored('10'))).toBe(1);
    });
});
