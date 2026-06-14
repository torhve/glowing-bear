import { describe, it, expect, vi, beforeEach } from 'vitest';
import { initNotifications, updateFavico, onDisconnect } from '$lib/notifications';
import { buffers } from '$lib/stores/models';
import { settings } from '$lib/stores/settings';
import type { BufferData } from '$lib/types';

// Mock Favico
const mockBadge = vi.fn();
const mockReset = vi.fn();
vi.mock('favico.js', () => ({
    default: vi.fn(() => ({
        badge: mockBadge,
        reset: mockReset,
    })),
}));

// Mock stores
vi.mock('$lib/stores/models', () => ({
    buffers: {
        subscribe: vi.fn((fn: (val: unknown) => void) => {
            fn({});
            return () => {};
        }),
    },
}));

vi.mock('$lib/stores/settings', () => ({
    settings: {
        subscribe: vi.fn((fn: (val: Record<string, unknown>) => void) => {
            fn({ useFavico: true });
            return () => {};
        }),
    },
}));

describe('favicon badge', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('initializes favico badge instance', () => {
        initNotifications();
        // Should create Favico instance — side effect only
        expect(mockBadge).not.toHaveBeenCalled();
    });

    it('shows notification badge when notifications exist', async () => {
        const mockBuffs: Record<string, BufferData> = {
            buf1: { unread: 0, notification: 3 } as BufferData,
        };
        (buffers.subscribe as ReturnType<typeof vi.fn>).mockImplementation((fn) => {
            fn(mockBuffs);
            return () => {};
        });

        initNotifications();
        updateFavico();

        expect(mockBadge).toHaveBeenCalledWith(3);
        expect(mockReset).not.toHaveBeenCalled();
    });

    it('shows unread badge when no notifications but unread exists', async () => {
        const mockBuffs: Record<string, BufferData> = {
            buf1: { unread: 5, notification: 0 } as BufferData,
        };
        (buffers.subscribe as ReturnType<typeof vi.fn>).mockImplementation((fn) => {
            fn(mockBuffs);
            return () => {};
        });

        initNotifications();
        updateFavico();

        expect(mockBadge).toHaveBeenCalledWith(5);
    });

    it('resets badge when no unread or notifications', async () => {
        const mockBuffs: Record<string, BufferData> = {
            buf1: { unread: 0, notification: 0 } as BufferData,
        };
        (buffers.subscribe as ReturnType<typeof vi.fn>).mockImplementation((fn) => {
            fn(mockBuffs);
            return () => {};
        });

        initNotifications();
        updateFavico();

        expect(mockReset).toHaveBeenCalled();
        expect(mockBadge).not.toHaveBeenCalled();
    });

    it('prefers notification count over unread', async () => {
        const mockBuffs: Record<string, BufferData> = {
            buf1: { unread: 10, notification: 2 } as BufferData,
        };
        (buffers.subscribe as ReturnType<typeof vi.fn>).mockImplementation((fn) => {
            fn(mockBuffs);
            return () => {};
        });

        initNotifications();
        updateFavico();

        // Should show notification count (2), not unread (10)
        expect(mockBadge).toHaveBeenCalledWith(2);
    });

    it('respects useFavico setting', async () => {
        (settings.subscribe as ReturnType<typeof vi.fn>).mockImplementation((fn) => {
            fn({ useFavico: false });
            return () => {};
        });

        initNotifications();
        updateFavico();

        expect(mockBadge).not.toHaveBeenCalled();
        expect(mockReset).not.toHaveBeenCalled();
    });

    it('cleans up on disconnect', async () => {
        initNotifications();
        onDisconnect();

        expect(mockReset).toHaveBeenCalled();
    });
});
