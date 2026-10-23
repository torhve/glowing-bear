import { describe, it, expect, vi } from 'vitest';

// Mock settings store to avoid localStorage access at module load time
vi.mock('#lib/stores/settings.ts', async () => (await import('./helpers/mockSettings.ts')).mockSettings({port: '9001', fontsize: '', noembed: false, orderbyserver: false, useFavico: false, soundnotification: false, enableQuickKeys: false}));

// Mock notifications before importing handlers
vi.mock('#lib/notifications.ts', async () => (await import('./helpers/mockNotifications.ts')).mockNotifications());

const { injectDateChangeMessageIfNeeded } = await import('#lib/stores/models.ts');

describe('Date change injection', () => {
    it('produces valid rich text with 2-digit color code', () => {
        const buffer = {
            id: '0x1234',
            bufferType: 0,
            lines: [] as any[],
            lastSeen: 0,
            plugin: 'irc',
            server: 'test'
        } as any;

        const oldDate = new Date(2026, 5, 14); // June 14
        const newDate = new Date(2026, 5, 15); // June 15

        injectDateChangeMessageIfNeeded(buffer, false, oldDate, newDate);

        expect(buffer.lines.length).toBe(1);
        const line = buffer.lines[0];

        // The prefix should contain the box drawing character
        expect(line.prefixtext).toContain('\u2500');

        // The content should include the day name and date
        expect(line.text).toContain('Monday');
        expect(line.text).toContain('June 15');
    });

    it('does not inject for free buffers (bufferType === 1)', () => {
        const buffer = {
            id: '0x1234',
            bufferType: 1,
            lines: [] as any[],
            lastSeen: 0,
            plugin: 'irc',
            server: 'test'
        } as any;

        const oldDate = new Date(2026, 5, 14);
        const newDate = new Date(2026, 5, 15);

        injectDateChangeMessageIfNeeded(buffer, false, oldDate, newDate);

        expect(buffer.lines.length).toBe(0);
    });

    it('does not inject when dates are on the same day', () => {
        const buffer = {
            id: '0x1234',
            bufferType: 0,
            lines: [] as any[],
            lastSeen: 0,
            plugin: 'irc',
            server: 'test'
        } as any;

        const oldDate = new Date(2026, 5, 14, 10, 0, 0);
        const newDate = new Date(2026, 5, 14, 15, 0, 0);

        injectDateChangeMessageIfNeeded(buffer, false, oldDate, newDate);

        expect(buffer.lines.length).toBe(0);
    });

    it('includes year when crossing year boundary', () => {
        const buffer = {
            id: '0x1234',
            bufferType: 0,
            lines: [] as any[],
            lastSeen: 0,
            plugin: 'irc',
            server: 'test'
        } as any;

        const oldDate = new Date(2025, 11, 31);
        const newDate = new Date(2026, 0, 1);

        injectDateChangeMessageIfNeeded(buffer, false, oldDate, newDate);

        expect(buffer.lines.length).toBe(1);
        expect(buffer.lines[0].text).toContain('2026');
    });

    it('increments lastSeen when manually triggered', () => {
        const buffer = {
            id: '0x1234',
            bufferType: 0,
            lines: [] as any[],
            lastSeen: 42,
            plugin: 'irc',
            server: 'test'
        } as any;

        const oldDate = new Date(2026, 5, 14);
        const newDate = new Date(2026, 5, 15);

        injectDateChangeMessageIfNeeded(buffer, true, oldDate, newDate);

        expect(buffer.lastSeen).toBe(43);
    });

    it('does not increment lastSeen when not manually triggered', () => {
        const buffer = {
            id: '0x1234',
            bufferType: 0,
            lines: [] as any[],
            lastSeen: 42,
            plugin: 'irc',
            server: 'test'
        } as any;

        const oldDate = new Date(2026, 5, 14);
        const newDate = new Date(2026, 5, 15);

        injectDateChangeMessageIfNeeded(buffer, false, oldDate, newDate);

        expect(buffer.lastSeen).toBe(42);
    });
});
