// Mock for @tauri-apps/plugin-notification — used in Vitest tests where the real package is not installed
// Uses vi.fn() so tests can assert calls

import { vi } from 'vitest';

export const isPermissionGranted = vi.fn(() => Promise.resolve(false));
export const requestPermission = vi.fn(() => Promise.resolve('denied'));
export const sendNotification = vi.fn();
export const registerActionTypes = vi.fn(() => Promise.resolve());
export const pending = vi.fn(() => Promise.resolve([]));
export const cancel = vi.fn(() => Promise.resolve());
export const cancelAll = vi.fn(() => Promise.resolve());
export const active = vi.fn(() => Promise.resolve([]));
export const removeActive = vi.fn(() => Promise.resolve());
export const removeAllActive = vi.fn(() => Promise.resolve());
export const createChannel = vi.fn(() => Promise.resolve());
export const removeChannel = vi.fn(() => Promise.resolve());
export const channels = vi.fn(() => Promise.resolve([]));
export const onNotificationReceived = vi.fn(() => Promise.resolve({ remove: () => {} }));
export const onAction = vi.fn(() => Promise.resolve({ remove: () => {} }));

export class Schedule {
    static at() { return {}; }
    static interval() { return {}; }
    static every() { return {}; }
}

export const Importance = { None: 0, Min: 1, Low: 2, Default: 3, High: 4 };
export const Visibility = { Secret: -1, Private: 0, Public: 1 };
