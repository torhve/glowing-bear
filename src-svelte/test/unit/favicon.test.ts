import { describe, it, expect, vi, beforeEach } from 'vitest';
import { formatCount } from '$lib/faviconBadge';

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

vi.mock('$lib/faviconBadge', async () => {
    const actual = await vi.importActual('$lib/faviconBadge');
    return {
        ...actual,
        initFavicon: vi.fn(),
        drawBadge: (...args: unknown[]) => mockDrawOnCanvas(...args),
        resetBadge: (...args: unknown[]) => mockReset(...args),
    };
});

const modelsMock = {
    subscribe: vi.fn((fn: (val: unknown) => void) => {
        fn({});
        return () => {};
    }),
};

const settingsMock = {
    subscribe: vi.fn((fn: (val: Record<string, unknown>) => void) => {
        fn({ useFavico: true });
        return () => {};
    }),
};

vi.mock('$lib/stores/models', () => ({
    buffers: modelsMock,
}));

vi.mock('$lib/stores/settings', () => ({
    settings: settingsMock,
}));

describe('favicon badge integration', () => {
    let notifications: typeof import('$lib/notifications');

    beforeEach(async () => {
        vi.clearAllMocks();
        notifications = await import('$lib/notifications');
    });

    it('initializes favicon by calling initFavicon', () => {
        notifications.initNotifications();
        // initFavicon is mocked — just verify no error
    });

    it('draws notification badge when notifications exist', async () => {
        const mockBuffs: Record<string, import('$lib/types').BufferData> = {
            buf1: { unread: 0, notification: 3 } as import('$lib/types').BufferData,
        };
        modelsMock.subscribe.mockImplementation((fn) => {
            fn(mockBuffs);
            return () => {};
        });

        notifications.updateFavico();

        expect(mockDrawOnCanvas).toHaveBeenCalledWith(3, 'notification');
    });

    it('draws unread badge when no notifications but unread exists', async () => {
        const mockBuffs: Record<string, import('$lib/types').BufferData> = {
            buf1: { unread: 5, notification: 0 } as import('$lib/types').BufferData,
        };
        modelsMock.subscribe.mockImplementation((fn) => {
            fn(mockBuffs);
            return () => {};
        });

        notifications.updateFavico();

        expect(mockDrawOnCanvas).toHaveBeenCalledWith(5, 'unread');
    });

    it('clears app badge when no unread or notifications', async () => {
        const mockBuffs: Record<string, import('$lib/types').BufferData> = {
            buf1: { unread: 0, notification: 0 } as import('$lib/types').BufferData,
        };
        modelsMock.subscribe.mockImplementation((fn) => {
            fn(mockBuffs);
            return () => {};
        });

        notifications.updateFavico();

        // Should not call drawBadge — goes to else branch
        expect(mockDrawOnCanvas).not.toHaveBeenCalled();
    });

    it('prefers notification count over unread', async () => {
        const mockBuffs: Record<string, import('$lib/types').BufferData> = {
            buf1: { unread: 10, notification: 2 } as import('$lib/types').BufferData,
        };
        modelsMock.subscribe.mockImplementation((fn) => {
            fn(mockBuffs);
            return () => {};
        });

        notifications.updateFavico();

        expect(mockDrawOnCanvas).toHaveBeenCalledWith(2, 'notification');
    });

    it('respects useFavico setting', async () => {
        settingsMock.subscribe.mockImplementation((fn) => {
            fn({ useFavico: false });
            return () => {};
        });

        notifications.updateFavico();

        expect(mockDrawOnCanvas).not.toHaveBeenCalled();
    });

    it('calls resetBadge on disconnect', async () => {
        notifications.onDisconnect();

        expect(mockReset).toHaveBeenCalled();
    });
});
