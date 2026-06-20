// Notification service for Glowing Bear
// Ported from notifications.js

import { settings, updateSettings } from './stores/settings';
import { buffers, currentBuffer, setActiveBuffer } from './stores/models';
import { get } from 'svelte/store';
import type { BufferData } from './types';
import { initFavicon, drawBadge, resetBadge } from './faviconBadge';
import { isTauri } from './tauriWindow';

// Notification permission state
let notificationPermission: 'granted' | 'denied' | 'default' = 'default';

// Track active notifications (browser path only)
const activeNotifications: Map<string, Notification> = new Map();

// Tauri notification module (lazily loaded)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tauriNotif: any = null;

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
        await tauriNotif.onAction((notification: { extra?: Record<string, unknown> }) => {
            const bufferId = notification.extra?.bufferId as string | undefined;
            if (bufferId) {
                setActiveBuffer(bufferId);
            }
        });
    } catch (e) {
        console.warn('Failed to setup Tauri notification listener:', e);
    }
}

/**
 * Request notification permission — uses Tauri native API in Tauri, browser API otherwise
 */
export async function requestNotificationPermission(): Promise<boolean> {
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
    await ensureTauriNotification();

    if (tauriNotif) {
        const bufferName = buffer.shortName || buffer.fullName;
        try {
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
        const notification = new Notification(title, options);
        const tag = buffer.id;

        // Store reference for later cancellation
        activeNotifications.set(tag, notification);

        // Click handler - switch to the buffer
        notification.onclick = () => {
            setActiveBuffer(buffer.id);
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
    if (tauriNotif?.cancelAll) {
        tauriNotif.cancelAll().catch(() => {});
    }
}

/**
 * Update the document title with total unread count across all buffers
 */
export function updateTitle(): void {
    const activeBuf = get(currentBuffer);
    const bufferName = activeBuf?.shortName || activeBuf?.fullName || '';
    const topic = activeBuf?.rtitle || '';

    // Get total unread count
    const allBuffers = get(buffers);
    let totalUnread = 0;
    for (const buf of Object.values(allBuffers) as BufferData[]) {
        totalUnread += buf.unread + buf.notification;
    }

    let prefix = '';
    if (totalUnread > 0) {
        prefix = `(${totalUnread}) `;
    }

    if (typeof document !== 'undefined') {
        document.title = `${prefix}Glowing Bear - ${bufferName}${topic ? ` - ${topic}` : ''}`;
    }
}

/**
 * Update the favicon badge
 */
export function updateFavico(): void {
    const s = get(settings);
    if (!s.useFavico) {
        return;
    }

    const allBuffers = get(buffers);
    let totalUnread = 0;
    let totalNotifications = 0;

    for (const buf of Object.values(allBuffers) as BufferData[]) {
        totalUnread += buf.unread;
        totalNotifications += buf.notification;
    }

  if (totalNotifications > 0) {
        drawBadge(totalNotifications, 'notification');
        try { navigator.setAppBadge(totalNotifications); } catch { /* not supported */ }
    } else if (totalUnread > 0) {
        drawBadge(totalUnread, 'unread');
        try { navigator.setAppBadge(totalUnread); } catch { /* not supported */ }
    } else {
        resetBadge();
        try { navigator.clearAppBadge(); } catch { /* not supported */ }
    }
}

/**
 * Play a notification sound
 */
export function playNotificationSound(): void {
    const s = get(settings);
    if (!s.soundnotification) {
        return;
    }

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
    // Load persisted permission state from settings
    const s = get(settings);
    if (s.notificationPermission && s.notificationPermission !== 'default') {
        notificationPermission = s.notificationPermission;
    }

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
    resetBadge();
    if (typeof document !== 'undefined') {
        document.title = 'Glowing Bear';
    }
}
