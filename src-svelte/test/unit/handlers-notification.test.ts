import { describe, it, expect, beforeEach, vi } from 'vitest';
import { get } from 'svelte/store';
import { buffers, activeBufferId, createBuffer } from '#lib/stores/models.ts';
import type { BufferData } from '#lib/types.ts';
import type { ProtocolMessage } from '#lib/types.ts';

// Mock settings store to avoid localStorage access at module load time
vi.mock('#lib/stores/settings.ts', () => ({
    settings: {
        subscribe: (fn: (val: any) => void) => {
            fn({
                hostField: '', port: '9001', tls: false, password: '',
                savepassword: false, autoconnect: false, useTotp: false,
                themeDark: 'dark', themeLight: 'light', fontfamily: '', fontsize: '', customCSS: '',
                iToken: '', iAlb: '', onlyUnread: false, noembed: false,
                alwaysnicklist: false, orderbyserver: false,
                readlineBindings: false, useFavico: false, soundnotification: false,
                enableMathjax: false, enableQuickKeys: false, showNicklist: true,
                showQuickKeys: false, showJumpKeys: false, highlightWords: '', hotlistsync: true
            });
            return () => {};
        }
    },
    updateSettings: vi.fn(),
    updatePartialSettings: vi.fn()
}));

// Mock notification functions before importing handlers
const mockCreateHighlight = vi.fn();
const mockPlayNotificationSound = vi.fn();
const mockUpdateTitle = vi.fn();
const mockUpdateFavico = vi.fn();

vi.mock('#lib/notifications.ts', () => ({
    createHighlight: mockCreateHighlight,
    playNotificationSound: mockPlayNotificationSound,
    updateTitle: mockUpdateTitle,
    updateFavico: mockUpdateFavico,
    startIndicatorOwner: () => () => {},
    refreshIndicators: vi.fn(),
}));

// Mock windowFocus so tests can control focus via document.hidden
vi.mock('#lib/windowFocus.ts', () => ({
    initWindowFocusTracking: vi.fn(() => Promise.resolve(() => {})),
    isWindowFocused: () => typeof document !== 'undefined' && !document.hidden,
}));

// Import handlers AFTER mocking settings and notifications
const { handleBufferLineAdded } = await import('#lib/stores/handlers.ts');

describe('PM/Highlight Notification Handling', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Reset stores
        const testBuffer = createBuffer({
            pointers: ['0x100'],
            full_name: '#test',
            short_name: '#test',
            number: 1,
            type: 2,
            local_variables: { type: 'channel', plugin: 'irc', server: 'server' },
        });
        buffers.set({ '0x100': testBuffer });
        
        activeBufferId.set('');
    });

    function createLineMessage(bufferId: string, tags: string[], highlight: number = 0, displayed: number = 1, notifyLevel: number = 0) {
        return {
            objects: [{
                pointer: bufferId,
                content: [{
                    buffer: bufferId,
                    date: Date.now(),
                    date_long: 0,
                    prefix: '\x19\u000304NickName\x19',
                    message: 'Test message',
                    tags_array: tags,
                    displayed,
                    notify_level: notifyLevel,
                    highlight
                }]
            }]
        } as ProtocolMessage;
    }

    it('increments notification count for PM (notify_level=2)', () => {
        const pmBuffer = createBuffer({
            pointers: ['0x200'],
            full_name: 'testuser',
            short_name: 'testuser',
            number: 0,
            type: 2,
            local_variables: { type: 'private', plugin: 'irc', server: 'server' },
        });
        buffers.update((b: Record<string, BufferData>) => ({ ...b, '0x200': pmBuffer }));

        handleBufferLineAdded(createLineMessage('0x200', ['private'], 0, 1, 2));

        const buf = get(buffers)['0x200'];
        expect(buf!.notification).toBe(1);
    });

    it('increments notification count for highlight (notify_level=3)', () => {
        handleBufferLineAdded(createLineMessage('0x100', [], 1, 1, 3));

        const buf = get(buffers)['0x100'];
        expect(buf!.notification).toBe(1);
    });

    it('does NOT increment notification for regular channel message (notify_level=0)', () => {
        handleBufferLineAdded(createLineMessage('0x100', [], 0, 1, 0));

        const buf = get(buffers)['0x100'];
        expect(buf!.notification).toBe(0);
    });

    it('increments unread count for message (notify_level=1)', () => {
        handleBufferLineAdded(createLineMessage('0x100', [], 0, 1, 1));

        const buf = get(buffers)['0x100'];
        expect(buf!.unread).toBe(1);
        expect(buf!.notification).toBe(0);
    });

    it('does NOT increment unread for backfill (notify_level=0)', () => {
        handleBufferLineAdded(createLineMessage('0x100', [], 0, 1, 0));

        const buf = get(buffers)['0x100'];
        expect(buf!.unread).toBe(0);
    });

    it('does NOT increment localUnread for backfill (notify_level=0)', () => {
        handleBufferLineAdded(createLineMessage('0x100', [], 0, 1, 0));

        const buf = get(buffers)['0x100'];
        expect(buf!.localUnread).toBe(0);
    });

    it('increments only notification (not unread) for highlight (notify_level=3)', () => {
        handleBufferLineAdded(createLineMessage('0x100', [], 1, 1, 3));

        const buf = get(buffers)['0x100'];
        expect(buf!.unread).toBe(0);
        expect(buf!.notification).toBe(1);
    });

    it('does not increment notification when buffer notify level is 0 (none)', () => {
        buffers.update((b: Record<string, BufferData>) => {
            const target = b['0x100'];
            if (!target) throw new Error('beforeEach did not create buffer 0x100');
            target.notify = 0;
            return b;
        });

        handleBufferLineAdded(createLineMessage('0x100', [], 0, 1, 2));

        const buf = get(buffers)['0x100'];
        expect(buf!.notification).toBe(0);
    });


    it('strips WeeChat formatting codes from prefix in notification body', () => {
        // Simulate hidden tab so notifications fire (jsdom has document.hidden=false by default)
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });

        handleBufferLineAdded({
            objects: [{
                pointer: '0x100',
                content: [{
                    buffer: '0x100',
                    date: Date.now(),
                    date_long: 0,
                    prefix: '\x19\u000304NickName\x19',
                    message: 'Test message',
                    tags_array: [],
                    displayed: 1,
                    notify_level: 3,
                    highlight: 1
                }]
            }]
        } as ProtocolMessage);

        expect(mockCreateHighlight).toHaveBeenCalledTimes(1);
        const [, body] = mockCreateHighlight.mock.calls[0]!;
        expect(body).toContain('NickName');
        expect(body).not.toContain('\x19');
        expect(body).not.toContain('\x03');
    });

    it('strips WeeChat formatting codes from message in notification body', () => {
        // Simulate hidden tab so notifications fire (jsdom has document.hidden=false by default)
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });

        handleBufferLineAdded({
            objects: [{
                pointer: '0x100',
                content: [{
                    buffer: '0x100',
                    date: Date.now(),
                    date_long: 0,
                    prefix: 'NickName',
                    message: '\x190304red text\x1900',
                    tags_array: [],
                    displayed: 1,
                    notify_level: 3,
                    highlight: 1
                }]
            }]
        } as ProtocolMessage);

        expect(mockCreateHighlight).toHaveBeenCalledTimes(1);
        const [, body] = mockCreateHighlight.mock.calls[0]!;
        expect(body).toContain('red text');
        expect(body).not.toContain('\x19');
        expect(body).not.toContain('\x03');
    });
});
