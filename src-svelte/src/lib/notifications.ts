// Notification service for Glowing Bear
// Ported from notifications.js

import { settings, updateSettings } from './stores/settings';
import { setActiveBuffer } from './stores/models';
import { badgeState, documentTitle, type BadgeState } from './stores/indicatorState';
import { get } from 'svelte/store';
import type { BufferData } from './types';
import { initFavicon, drawBadge, resetBadge, invalidateFaviconBadge } from './faviconBadge';
import { isTauri, setBadgeCount } from './tauriWindow';
import { initWindowFocusTracking } from './windowFocus';
import { DEBUG_NOTIFICATIONS } from '#lib/debug.ts';

// Notification permission state
let notificationPermission: 'granted' | 'denied' | 'default' = 'default';

// Track active notifications (browser path only)
const activeNotifications: Map<string, Notification> = new Map();

// Tauri notification module (lazily loaded)
let tauriNotif: typeof import('@tauri-apps/plugin-notification') | null = null;

async function ensureTauriNotification(): Promise<void> {
    if (tauriNotif !== null || !isTauri()) return;
    try {
        tauriNotif = await import('@tauri-apps/plugin-notification');
    } catch (e) {
        console.warn('Tauri notification plugin unavailable:', e);
    }
}

// Register listener for notification actions (mobile-only: interactive buttons)
async function setupTauriNotificationListener(): Promise<void> {
    if (!isTauri() || !tauriNotif) return;
    try {
        await tauriNotif.onAction((notification: import('@tauri-apps/plugin-notification').Options) => {
            const bufferId = notification.extra?.bufferId as string | undefined;
            if (bufferId) {
                setActiveBuffer(bufferId);
            }
        });
    } catch {
        /* Windows toast notifications don't support action callbacks */
    }
}

/**
 * Request notification permission — uses Tauri native API in Tauri, browser API otherwise
 */
export async function requestNotificationPermission(): Promise<boolean> {
    if (DEBUG_NOTIFICATIONS) console.log('[notification] requestNotificationPermission called');
    await ensureTauriNotification();

    if (tauriNotif) {
        try {
            let granted = await tauriNotif.isPermissionGranted();
            if (!granted) {
                const permission = await tauriNotif.requestPermission();
                granted = permission === 'granted';
            }
            notificationPermission = granted ? 'granted' : 'denied';
            updateSettings({ notificationPermission });
            return granted;
        } catch (e) {
            console.error('Error requesting Tauri notification permission:', e);
            return false;
        }
    }

    if (!('Notification' in window)) {
        console.warn('This browser does not support desktop notification');
        return false;
    }

    try {
        notificationPermission = await Notification.requestPermission() as 'granted' | 'denied' | 'default';
        updateSettings({ notificationPermission });
        return notificationPermission === 'granted';
    } catch (e) {
        console.error('Error requesting notification permission:', e);
        return false;
    }
}

/**
 * Check if notifications are supported
 */
export function isNotificationSupported(): boolean {
    return 'Notification' in window || isTauri();
}

/**
 * Create a desktop notification for a highlight — uses Tauri native in Tauri, browser API otherwise
 */
export async function createHighlight(buffer: BufferData, message: string): Promise<void> {
    if (DEBUG_NOTIFICATIONS) console.log('[notification] createHighlight called:', buffer.shortName || buffer.fullName, message.substring(0, 50));
    await ensureTauriNotification();

    if (tauriNotif) {
        if (notificationPermission !== 'granted') {
            if (DEBUG_NOTIFICATIONS) console.log('[notification] Tauri notification skipped: permission not granted');
            return;
        }
        const bufferName = buffer.shortName || buffer.fullName;
        try {
            if (DEBUG_NOTIFICATIONS) console.log('[notification] sending Tauri notification:', `[${bufferName}]`, message.substring(0, 50));
            tauriNotif.sendNotification({
                title: `[${bufferName}]`,
                body: message.substring(0, 200),
                extra: { bufferId: buffer.id },
            });
        } catch (e) {
            console.error('Error sending Tauri notification:', e);
        }
        return;
    }

    if (!isNotificationSupported() || notificationPermission !== 'granted') {
        return;
    }

    const bufferName = buffer.shortName || buffer.fullName;
    const title = `[${bufferName}]`;
    const options: NotificationOptions = {
        body: message.substring(0, 200),
        icon: '/glowing_bear_128x128.png',
        tag: buffer.id,
        requireInteraction: false
    };

    try {
        if (DEBUG_NOTIFICATIONS) console.log('[notification] creating browser notification:', title);
        const notification = new Notification(title, options);
        const tag = buffer.id;

        // Store reference for later cancellation
        activeNotifications.set(tag, notification);

        // Click handler - switch to the buffer
        notification.onclick = () => {
            if (DEBUG_NOTIFICATIONS) console.log('[notification] clicked, buffer.id:', buffer.id);
            const result = setActiveBuffer(buffer.id);
            if (!result) {
                console.warn('[notification] setActiveBuffer failed for buffer.id:', buffer.id, '— storing in localStorage as fallback');
                try {
                    localStorage.setItem('gb_pendingNotificationBuffer', JSON.stringify({ bufferId: buffer.id, timestamp: Date.now() }));
                } catch (e) {
                    console.error('[notification] failed to store pending buffer:', e);
                }
            }
            notification.close();
            activeNotifications.delete(tag);
            window.focus();
        };

        // Auto-close after 15 seconds
        setTimeout(() => {
            notification.close();
            activeNotifications.delete(tag);
        }, 15000);
    } catch (e) {
        console.error('Error creating notification:', e);
    }
}

/**
 * Cancel all active notifications
 */
export function cancelAll(): void {
    activeNotifications.forEach((notification) => {
        notification.close();
    });
    activeNotifications.clear();
    if (tauriNotif) {
        tauriNotif.cancelAll().catch(() => {});
        tauriNotif.removeAllActive().catch(() => {});
    }
}

/**
 * Apply a title the indicator store has already decided on.
 *
 * The store suppresses unchanged values, so an assignment here means the tab
 * text genuinely changed — but the comparison is repeated against the DOM
 * because `document.title = x` still costs a text-node mutation and a style
 * recalculation on the <title> element, and something outside this module
 * (a browser extension, a test, the disconnect path) can have written it too.
 */
let appliedTitle: string | null = null;

export function applyDocumentTitle(title: string): void {
    if (typeof document === 'undefined') return;
    if (appliedTitle === title && document.title === title) return;
    appliedTitle = title;
    document.title = title;
}

/**
 * Apply a badge state the indicator store has already decided on.
 *
 * `null` means "no badge": clearing is an action, not an absence of one, and
 * skipping it is how a stale count survives a mark-read.
 */
export function applyBadge(state: BadgeState | null): void {
    if (typeof document === 'undefined') return;

    if (state === null) {
        resetBadge();
        try { navigator.clearAppBadge(); } catch { /* not supported */ }
        void setBadgeCount({ count: 0, type: 'unread' });
        return;
    }

    void drawBadge(state.count, state.kind);
    try { navigator.setAppBadge(state.count); } catch { /* not supported */ }
    void setBadgeCount({ count: state.count, type: state.kind });
}

/**
 * Start the single owner of the title and the badge.
 *
 * Transports publish state; nothing in a handler writes an indicator. The owner
 * subscribes to the three indicator stores and applies whatever actually
 * changed, so an unchanged hotlist poll that re-references every background
 * buffer produces no title write and no badge draw.
 *
 * Returns the stop function; the caller owns the lifecycle (the page effect) and
 * must call it on teardown, or a reconnect leaves a second owner subscribed and
 * the "one owner" property is gone.
 */
export function startIndicatorOwner(): () => void {
    const unsubs = [
        documentTitle.subscribe((title) => applyDocumentTitle(title)),
        badgeState.subscribe((state) => applyBadge(state)),
    ];
    return () => {
        for (const unsub of unsubs) unsub();
    };
}

/**
 * Force both indicators to be re-applied from current state.
 *
 * Appearance changes are explicit invalidations: a theme change can alter the
 * badge palette without changing any count, and a projection that compares
 * values cannot see that the picture it produced is now different.
 */
export function refreshIndicators(): void {
    applyDocumentTitle(get(documentTitle));
    invalidateFaviconBadge();
    applyBadge(get(badgeState));
}

/**
 * Update the document title from current state.
 *
 * Kept for explicit invalidation only (appearance changes). Ordinary traffic
 * reaches the title through the indicator owner, not through a handler.
 */
export function updateTitle(): void {
    applyDocumentTitle(get(documentTitle));
}

/**
 * Update the favicon badge from current state.
 *
 * Kept for explicit invalidation only; see `updateTitle`.
 */
export function updateFavico(): void {
    applyBadge(get(badgeState));
}

/**
 * Play a notification sound
 */
export function playNotificationSound(): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    try { ((window as any).__playNotificationSoundCalls = (window as any).__playNotificationSoundCalls || []).push('called'); } catch { /* noop */ }

    const s = get(settings);
    if (!s.soundnotification) {
        if (DEBUG_NOTIFICATIONS) console.log('[notification] playNotificationSound skipped: soundnotification disabled');
        return;
    }

    if (DEBUG_NOTIFICATIONS) console.log('[notification] playing notification sound');
    try {
        const audio = new Audio('/assets/audio/sonar.mp3');
        audio.volume = 0.5;
        audio.play().catch(e => {
            console.warn('Audio playback failed:', e);
        });
    } catch (e) {
        console.warn('Error playing notification sound:', e);
    }
}

/**
 * Initialize the notification system — async to ensure Tauri module loads before registering listeners
 */
export async function initNotifications(): Promise<void> {
    if (DEBUG_NOTIFICATIONS) console.log('[notification] initNotifications called');
    // Load persisted permission state from settings
    const s = get(settings);
    if (s.notificationPermission && s.notificationPermission !== 'default') {
        notificationPermission = s.notificationPermission;
    }

    // Initialize window focus tracking (generic web listeners + Tauri native events)
    void initWindowFocusTracking();

    // Set up Tauri native notifications if running in Tauri
    if (isTauri()) {
        await ensureTauriNotification();
        await setupTauriNotificationListener();
    }

    initFavicon();
}

/**
 * Clean up notifications on disconnect
 */
export function onDisconnect(): void {
    cancelAll();
    // Routed through the same appliers the owner uses, so the cached "title
    // currently on the tab" and the badge paint identity stay truthful. A direct
    // write here would leave both caches describing a value the DOM no longer
    // has, and a later no-op publication would then skip a write it owes.
    applyBadge(null);
    applyDocumentTitle('Glowing Bear');
}
