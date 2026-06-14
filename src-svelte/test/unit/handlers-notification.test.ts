import { describe, it, expect, beforeEach, vi } from 'vitest';
import { get } from 'svelte/store';
import { buffers, servers, activeBufferId } from '$lib/stores/models';
import type { BufferData } from '$lib/types';
import type { ProtocolMessage } from '$lib/types';

// Mock notification functions before importing handlers
const mockCreateHighlight = vi.fn();
const mockPlayNotificationSound = vi.fn();
const mockUpdateTitle = vi.fn();
const mockUpdateFavico = vi.fn();

vi.mock('$lib/notifications', () => ({
    createHighlight: mockCreateHighlight,
    playNotificationSound: mockPlayNotificationSound,
    updateTitle: mockUpdateTitle,
    updateFavico: mockUpdateFavico,
}));

// Import handlers AFTER mocking notifications
const { handleBufferLineAdded } = await import('$lib/stores/handlers');

describe('PM/Highlight Notification Handling', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Reset stores
        const testBuffer: BufferData = {
            id: '0x100',
            fullName: '#test',
            shortName: '#test',
            hidden: false,
            trimmedName: 'test',
            nameClasses: [],
            prefix: '#',
            number: 1,
            title: [],
            rtitle: '',
            lines: [],
            requestedLines: 0,
            allLinesFetched: false,
            lastSeen: -1,
            unread: 0,
            notification: 0,
            notify: 3,
            nicklist: {},
            serverSortKey: 'irc.server.test',
            indent: true,
            bufferType: 2,
            type: 'channel',
            plugin: 'irc',
            server: 'server',
            hideBufferLineTimes: false,
            pinned: false,
            active: false
        };
        buffers.set({ '0x100': testBuffer });
        
        servers.set({ 'irc.server': { id: '0x100', unread: 0 } });
        activeBufferId.set('');
    });

    function createLineMessage(bufferId: string, tags: string[], highlight: number = 0, displayed: number = 1) {
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
                    highlight
                }]
            }]
        } as ProtocolMessage;
    }

    it('increments notification count for PM with notify_private tag', () => {
        const pmBuffer: BufferData = {
            id: '0x200',
            fullName: 'testuser',
            shortName: 'testuser',
            hidden: false,
            trimmedName: 'testuser',
            nameClasses: [],
            prefix: '',
            number: 0,
            title: [],
            rtitle: '',
            lines: [],
            requestedLines: 0,
            allLinesFetched: false,
            lastSeen: -1,
            unread: 0,
            notification: 0,
            notify: 3,
            nicklist: {},
            serverSortKey: 'irc.server.testuser',
            indent: true,
            bufferType: 2,
            type: 'private',
            plugin: 'irc',
            server: 'server',
            hideBufferLineTimes: false,
            pinned: false,
            active: false
        };
        buffers.update(b => ({ ...b, '0x200': pmBuffer }));

        handleBufferLineAdded(createLineMessage('0x200', ['private', 'notify_private']));

        const buf = get(buffers)['0x200'];
        expect(buf!.notification).toBe(1);
    });

    it('increments notification count for highlight', () => {
        handleBufferLineAdded(createLineMessage('0x100', [], 1));

        const buf = get(buffers)['0x100'];
        expect(buf!.notification).toBe(1);
    });

    it('does NOT increment notification for regular channel message', () => {
        handleBufferLineAdded(createLineMessage('0x100', []));

        const buf = get(buffers)['0x100'];
        expect(buf!.notification).toBe(0);
    });

    it('increments unread count for notify_message tag (non-PM)', () => {
        handleBufferLineAdded(createLineMessage('0x100', ['notify_message'], 0, 1));

        const buf = get(buffers)['0x100'];
        expect(buf!.unread).toBe(1);
        expect(buf!.notification).toBe(0);
    });

    it('increments both unread AND notification for message with both tags', () => {
        handleBufferLineAdded(createLineMessage('0x100', ['notify_message', 'notify_private'], 1));

        const buf = get(buffers)['0x100'];
        expect(buf!.unread).toBe(1);
        expect(buf!.notification).toBe(1);
    });

    it('does not increment notification when buffer notify level is 0 (none)', () => {
        buffers.update(b => {
            b['0x100'].notify = 0;
            return b;
        });

        handleBufferLineAdded(createLineMessage('0x100', ['private', 'notify_private']));

        const buf = get(buffers)['0x100'];
        expect(buf!.notification).toBe(0);
    });

    it('increments server unread when buffer notification increments', () => {
        const pmBuffer: BufferData = {
            id: '0x200',
            fullName: 'testuser',
            shortName: 'testuser',
            hidden: false,
            trimmedName: 'testuser',
            nameClasses: [],
            prefix: '',
            number: 0,
            title: [],
            rtitle: '',
            lines: [],
            requestedLines: 0,
            allLinesFetched: false,
            lastSeen: -1,
            unread: 0,
            notification: 0,
            notify: 3,
            nicklist: {},
            serverSortKey: 'irc.server.testuser',
            indent: true,
            bufferType: 2,
            type: 'private',
            plugin: 'irc',
            server: 'server',
            hideBufferLineTimes: false,
            pinned: false,
            active: false
        };
        buffers.update(b => ({ ...b, '0x200': pmBuffer }));
        servers.update(s => ({ ...s, 'irc.server': { id: '0x100', unread: 0 } }));

        handleBufferLineAdded(createLineMessage('0x200', ['private', 'notify_private']));

        const srv = get(servers)['irc.server'];
        expect(srv!.unread).toBe(1);
    });
});
