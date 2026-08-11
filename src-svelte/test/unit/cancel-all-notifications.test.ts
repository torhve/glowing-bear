import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as TauriNotif from '@tauri-apps/plugin-notification';

// Mock isTauri before any module loads
vi.mock('$lib/tauriWindow', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/tauriWindow')>();
    return { ...actual, isTauri: () => true };
});

describe('cancelAll clears both pending and active Tauri notifications', () => {
    let tauriNotif: typeof TauriNotif;
    let notifications: typeof import('$lib/notifications');

    beforeEach(async () => {
        vi.resetModules();
        vi.clearAllMocks();

        tauriNotif = await import('@tauri-apps/plugin-notification');
        notifications = await import('$lib/notifications');

        // Trigger lazy-load of Tauri notification module inside notifications.ts
        await notifications.initNotifications();
    });

    it('calls both cancelAll and removeAllActive on disconnect', async () => {
        notifications.onDisconnect();

        expect(tauriNotif.cancelAll).toHaveBeenCalledTimes(1);
        expect(tauriNotif.removeAllActive).toHaveBeenCalledTimes(1);
    });
});
