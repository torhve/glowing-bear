import { describe, it, expect, vi, beforeEach } from 'vitest';
import { formatCount } from '#lib/faviconBadge.ts';

describe('formatCount', () => {
    it('returns the count as string for small numbers', () => {
        expect(formatCount(0)).toBe('0');
        expect(formatCount(1)).toBe('1');
        expect(formatCount(99)).toBe('99');
    });

    it('caps at 99+ for moderate overflow', () => {
        expect(formatCount(100)).toBe('99+');
        expect(formatCount(150)).toBe('99+');
        expect(formatCount(999)).toBe('99+');
    });

    it('uses K notation for thousands', () => {
        expect(formatCount(1000)).toBe('1k+');
        expect(formatCount(1500)).toBe('1k+');
        expect(formatCount(2000)).toBe('2k+');
        expect(formatCount(9999)).toBe('9k+');
    });

    it('handles very large numbers', () => {
        expect(formatCount(1000000)).toBe('999k+');
        expect(formatCount(9999999)).toBe('999k+');
    });
});

// For integration testing, we mock the entire faviconBadge module
const mockDrawOnCanvas = vi.fn();
const mockReset = vi.fn();

vi.mock('#lib/faviconBadge.ts', async () => {
    const actual = await vi.importActual('#lib/faviconBadge.ts');
    return {
        ...actual,
        initFavicon: vi.fn(),
        drawBadge: (...args: unknown[]) => mockDrawOnCanvas(...args),
        resetBadge: (...args: unknown[]) => mockReset(...args),
    };
});

// indicatorState.ts subscribes to these while the module graph is still loading,
// so they must exist before the test body runs — and they must be *live*: a
// mock whose subscribe() is merely re-implemented per test never notifies the
// derived stores, which then read the value they captured at import forever.
const buffersMock = vi.hoisted(() => {
    let value: Record<string, unknown> = {};
    const subs = new Set<(v: Record<string, unknown>) => void>();
    return {
        subscribe: (fn: (v: Record<string, unknown>) => void) => {
            subs.add(fn);
            fn(value);
            return () => { subs.delete(fn); };
        },
        set: (next: Record<string, unknown>) => {
            value = next;
            for (const fn of [...subs]) fn(value);
        },
    };
});

const currentBufferMock = {
    subscribe: vi.fn((fn: (val: unknown) => void) => {
        fn(null);
        return () => {};
    }),
};

const settingsMock = vi.hoisted(() => {
    let value: Record<string, unknown> = { useFavico: true };
    const subs = new Set<(v: Record<string, unknown>) => void>();
    return {
        subscribe: (fn: (v: Record<string, unknown>) => void) => {
            subs.add(fn);
            fn(value);
            return () => { subs.delete(fn); };
        },
        set: (next: Record<string, unknown>) => {
            value = next;
            for (const fn of [...subs]) fn(value);
        },
    };
});

vi.mock('#lib/stores/models.ts', () => ({
    buffers: buffersMock,
    currentBuffer: currentBufferMock,
    setActiveBuffer: vi.fn(),
}));

vi.mock('#lib/stores/settings.ts', () => ({
    settings: settingsMock,
}));

describe('favicon badge integration', () => {
    let notifications: typeof import('#lib/notifications.ts');

    beforeEach(async () => {
        vi.clearAllMocks();
        buffersMock.set({});
        settingsMock.set({ useFavico: true });
        notifications = await import('#lib/notifications.ts');
    });

    it('initializes favicon by calling initFavicon', () => {
        notifications.initNotifications();
        // initFavicon is mocked — just verify no error
    });

    it('draws notification badge when notifications exist', async () => {
        const mockBuffs: Record<string, import('#lib/types.ts').BufferData> = {
            buf1: { unread: 0, notification: 3 } as import('#lib/types.ts').BufferData,
        };
        buffersMock.set(mockBuffs);

        notifications.updateFavico();

        expect(mockDrawOnCanvas).toHaveBeenCalledWith(3, 'notification');
    });

    it('draws unread badge when no notifications but unread exists', async () => {
        const mockBuffs: Record<string, import('#lib/types.ts').BufferData> = {
            buf1: { unread: 5, notification: 0 } as import('#lib/types.ts').BufferData,
        };
        buffersMock.set(mockBuffs);

        notifications.updateFavico();

        expect(mockDrawOnCanvas).toHaveBeenCalledWith(5, 'unread');
    });

    it('clears app badge when no unread or notifications', async () => {
        const mockBuffs: Record<string, import('#lib/types.ts').BufferData> = {
            buf1: { unread: 0, notification: 0 } as import('#lib/types.ts').BufferData,
        };
        buffersMock.set(mockBuffs);

        notifications.updateFavico();

        // Should not call drawBadge — goes to else branch
        expect(mockDrawOnCanvas).not.toHaveBeenCalled();
    });

    it('prefers notification count over unread', async () => {
        const mockBuffs: Record<string, import('#lib/types.ts').BufferData> = {
            buf1: { unread: 10, notification: 2 } as import('#lib/types.ts').BufferData,
        };
        buffersMock.set(mockBuffs);

        notifications.updateFavico();

        expect(mockDrawOnCanvas).toHaveBeenCalledWith(2, 'notification');
    });

    it('respects useFavico setting', async () => {
        settingsMock.set({ useFavico: false });

        notifications.updateFavico();

        expect(mockDrawOnCanvas).not.toHaveBeenCalled();
    });

    it('calls resetBadge on disconnect', async () => {
        notifications.onDisconnect();

        expect(mockReset).toHaveBeenCalled();
    });
});
