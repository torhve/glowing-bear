// Notification service for Glowing Bear
// Ported from notifications.js

import { settings } from './stores/settings';
import { buffers, activeBufferId } from './stores/models';
import { get } from 'svelte/store';
import type { BufferData } from './types';
import Favico from 'favico.js';

// Notification permission state
let notificationPermission = 'default';

// Track active notifications
const activeNotifications: Map<string, Notification> = new Map();

// Favico.js badge instance
let favicoBadge: InstanceType<typeof Favico> | null = null;

/**
 * Request notification permission from the browser
 */
export async function requestNotificationPermission(): Promise<boolean> {
    if (!('Notification' in window)) {
        console.warn('This browser does not support desktop notification');
        return false;
    }

    try {
        notificationPermission = await Notification.requestPermission();
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
    return 'Notification' in window;
}

/**
 * Create a desktop notification for a highlight
 */
export function createHighlight(buffer: BufferData, message: string): void {
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
            activeBufferId.set(buffer.id);
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
}

/**
 * Update the document title
 */
export function updateTitle(buffer: BufferData): void {
    const bufferName = buffer.shortName || buffer.fullName;
    const topic = buffer.rtitle || '';
    
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
    if (!s.useFavico || !favicoBadge) {
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
        // Red badge for notifications
        favicoBadge.badge(totalNotifications);
    } else if (totalUnread > 0) {
        // Green badge for unread
        favicoBadge.badge(totalUnread);
    } else {
        // Reset badge
        favicoBadge.reset();
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
 * Initialize the notification system
 */
export function initNotifications(): void {
    // Request permission if not already granted
    if ('Notification' in window && notificationPermission === 'default') {
        requestNotificationPermission().catch(() => {});
    }

    favicoBadge = new Favico({ animation: 'none' });
}

/**
 * Clean up notifications on disconnect
 */
export function onDisconnect(): void {
    cancelAll();
    if (favicoBadge) {
        favicoBadge.reset();
    }
    if (typeof document !== 'undefined') {
        document.title = 'Glowing Bear';
    }
}


