import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * The Tauri path is the only one that hands a notification click back to the app, and
 * plugin-notification 2.7 changed what that callback receives: an action carrying the
 * notification it was performed on, not the `Options` the notification was sent with.
 * The payload therefore moved from `notification.extra` to `event.notification?.extra`,
 * and a platform that reports no notification must not activate anything.
 */

// The action listener is registered only on the Tauri branch of initNotifications().
vi.mock('#lib/tauriWindow.ts', async (importOriginal) => {
    const actual = await importOriginal<typeof import('#lib/tauriWindow.ts')>();
    return { ...actual, isTauri: () => true };
});

vi.mock('#lib/windowFocus.ts', () => ({
    initWindowFocusTracking: vi.fn(() => Promise.resolve(() => {})),
    isWindowFocused: () => true,
}));

const setActiveBuffer = vi.hoisted(() => vi.fn(() => true));
vi.mock('#lib/stores/models.ts', async (importOriginal) => {
    const actual = await importOriginal<typeof import('#lib/stores/models.ts')>();
    return { ...actual, setActiveBuffer };
});

/** Structural, not imported: `@tauri-apps/plugin-notification` resolves to the vitest mock. */
type ActionPerformedLike = {
    actionId: string;
    inputValue: string | null;
    notification: { id: number; extra?: Record<string, unknown> } | null;
};

describe('a tapped Tauri notification hands its buffer to the app', () => {
    let tauriNotif: typeof import('./mocks/tauri-plugin-notification.ts');
    let notifications: typeof import('#lib/notifications.ts');

    beforeEach(async () => {
        vi.resetModules();
        vi.clearAllMocks();

        tauriNotif = await import('./mocks/tauri-plugin-notification.ts');
        notifications = await import('#lib/notifications.ts');
        await notifications.initNotifications();
    });

    /** The callback initNotifications() registered, invoked as the platform would. */
    function performAction(event: ActionPerformedLike): void {
        // The mock's inferred procedure takes no arguments, so the callback it was
        // registered with has to be read out loosely — and a listener that never
        // arrived must be reported, not reached through as an undefined call.
        const calls = tauriNotif.onAction.mock.calls as unknown as [
            ((event: ActionPerformedLike) => void) | undefined,
        ][];
        const firstCall = calls[0];
        const callback = firstCall?.[0];
        if (!callback) throw new Error('initNotifications() registered no notification action listener');
        callback(event);
    }

    it('activates the buffer carried on the notification that was tapped', () => {
        expect(tauriNotif.onAction).toHaveBeenCalledTimes(1);

        performAction({
            actionId: 'tap',
            inputValue: null,
            notification: { id: 7, extra: { bufferId: '42' } },
        });

        expect(setActiveBuffer).toHaveBeenCalledWith('42');
    });

    it('activates nothing when the platform reports no notification', () => {
        performAction({ actionId: 'tap', inputValue: null, notification: null });

        expect(setActiveBuffer).not.toHaveBeenCalled();
    });

    it('activates nothing when the notification carries no buffer id', () => {
        performAction({ actionId: 'tap', inputValue: null, notification: { id: 7, extra: {} } });

        expect(setActiveBuffer).not.toHaveBeenCalled();
    });
});
