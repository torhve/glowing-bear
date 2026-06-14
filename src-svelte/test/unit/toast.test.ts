import { describe, it, expect, vi, beforeEach } from 'vitest';
import { addToast, removeToast, clearToasts, toastStore } from '$lib/toast';
import { get } from 'svelte/store';

describe('Toast Store', () => {
    beforeEach(() => {
        clearToasts();
    });

    it('starts with empty toasts', () => {
        expect(get(toastStore)).toEqual([]);
    });

    it('adds a toast with default values', () => {
        addToast('Test message');
        const toasts = get(toastStore);
        expect(toasts).toHaveLength(1);
        expect(toasts[0].message).toBe('Test message');
        expect(toasts[0].type).toBe('info');
        expect(toasts[0].duration).toBe(5000);
        expect(toasts[0].id).toBe(1);
    });

    it('adds a toast with custom type', () => {
        addToast('Error occurred', { type: 'error' });
        const toasts = get(toastStore);
        expect(toasts[0].type).toBe('error');
    });

    it('adds a toast with custom duration', () => {
        addToast('Temporary message', { duration: 2000 });
        const toasts = get(toastStore);
        expect(toasts[0].duration).toBe(2000);
    });

    it('assigns unique IDs to each toast', () => {
        addToast('First');
        addToast('Second');
        const toasts = get(toastStore);
        expect(toasts[0].id).not.toBe(toasts[1].id);
    });

    it('removes a toast by ID', () => {
        addToast('Keep this');
        const firstId = get(toastStore)[get(toastStore).length - 1].id;
        addToast('Remove this');
        const secondId = get(toastStore)[get(toastStore).length - 1].id;
        removeToast(secondId);
        const toasts = get(toastStore);
        expect(toasts).toHaveLength(1);
        expect(toasts[0].id).toBe(firstId);
    });

    it('clears all toasts', () => {
        addToast('First');
        addToast('Second');
        addToast('Third');
        clearToasts();
        expect(get(toastStore)).toEqual([]);
    });

    it('auto-removes toast after duration', async () => {
        vi.useFakeTimers();
        addToast('Auto-remove', { duration: 1000 });
        expect(get(toastStore)).toHaveLength(1);
        vi.advanceTimersByTime(1000);
        await Promise.resolve();
        expect(get(toastStore)).toHaveLength(0);
        vi.useRealTimers();
    });

    it('does not auto-remove if duration is 0', () => {
        addToast('Permanent', { duration: 0 });
        expect(get(toastStore)).toHaveLength(1);
    });
});
