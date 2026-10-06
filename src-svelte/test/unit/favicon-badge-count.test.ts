import { describe, it, expect, beforeEach, vi } from 'vitest';
import { writable } from 'svelte/store';

/**
 * `updateFavico()` decides WHICH number the icon shows, and that decision is
 * what makes the badge's redraw cache sound: the cache keys on the count it was
 * last given, so if the app handed it the wrong count the cache would faithfully
 * reproduce the wrong picture.
 *
 * Notifications outrank unread here, which is also why an E2E test that produces
 * only unread can end up asserting nothing about the icon at all.
 */

const drawBadge = vi.fn();
const resetBadge = vi.fn();

vi.mock('#lib/faviconBadge.ts', () => ({
    initFavicon: vi.fn(),
    drawBadge: (...args: unknown[]) => drawBadge(...args),
    resetBadge: (...args: unknown[]) => resetBadge(...args),
}));

vi.mock('#lib/tauriWindow.ts', () => ({
    isTauri: () => false,
    setBadgeCount: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('#lib/stores/settings.ts', () => ({
    settings: {
        subscribe: (fn: (val: any) => void) => {
            fn({ useFavico: true, theme: 'dark', customCSS: '' });
            return () => {};
        },
    },
    updateSettings: vi.fn(),
    updatePartialSettings: vi.fn(),
}));

const bufferStore = writable<Record<string, unknown>>({});

vi.mock('#lib/stores/models.ts', () => ({
    buffers: { subscribe: (fn: (v: any) => void) => bufferStore.subscribe(fn) },
    currentBuffer: { subscribe: (fn: (v: any) => void) => fn(null) },
    setActiveBuffer: vi.fn(),
    servers: { subscribe: (fn: (v: any) => void) => fn({}) },
}));

import { updateFavico } from '#lib/notifications.ts';

function setBuffers(entries: Array<{ unread: number; notification: number }>) {
    bufferStore.set(Object.fromEntries(
        entries.map((e, i) => [`buf${i}`, { pointer: i, unread: e.unread, notification: e.notification }]),
    ));
}

describe('updateFavico chooses the count the icon shows', () => {
    beforeEach(() => {
        drawBadge.mockClear();
        resetBadge.mockClear();
    });

    it('shows the notification total when any buffer has a notification', () => {
        setBuffers([{ unread: 5, notification: 2 }, { unread: 1, notification: 0 }]);
        updateFavico();
        expect(drawBadge).toHaveBeenCalledTimes(1);
        expect(drawBadge).toHaveBeenCalledWith(2, 'notification');
        expect(resetBadge).not.toHaveBeenCalled();
    });

    it('falls back to the unread total when there are no notifications', () => {
        setBuffers([{ unread: 5, notification: 0 }, { unread: 1, notification: 0 }]);
        updateFavico();
        expect(drawBadge).toHaveBeenCalledTimes(1);
        expect(drawBadge).toHaveBeenCalledWith(6, 'unread');
    });

    it('resets the icon instead of drawing when nothing is unread', () => {
        setBuffers([{ unread: 0, notification: 0 }]);
        updateFavico();
        expect(drawBadge).not.toHaveBeenCalled();
        expect(resetBadge).toHaveBeenCalledTimes(1);
    });

    it('hands the badge a different count when the count it displays changes', () => {
        setBuffers([{ unread: 0, notification: 1 }]);
        updateFavico();
        setBuffers([{ unread: 9, notification: 2 }]);
        updateFavico();
        expect(drawBadge.mock.calls.map((c) => c[0])).toEqual([1, 2]);
        expect(drawBadge.mock.calls.map((c) => c[1])).toEqual(['notification', 'notification']);
    });
});
