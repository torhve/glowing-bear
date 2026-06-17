import { describe, it, expect, beforeEach, vi } from 'vitest';
import { get } from 'svelte/store';
import { buffers, activeBufferId } from '$lib/stores/models';
import type { BufferData, ProtocolMessage } from '$lib/types';

// Mock settings store to avoid localStorage access at module load time
vi.mock('$lib/stores/settings', () => ({
    settings: {
        subscribe: (fn: (val: any) => void) => {
            fn({
                hostField: '', port: '9001', tls: false, password: '',
                savepassword: false, autoconnect: false, useTotp: false,
                theme: 'dark', fontfamily: '', fontsize: '', customCSS: '',
                iToken: '', iAlb: '', onlyUnread: false, noembed: false,
              alwaysnicklist: false, orderbyserver: false,
                readlineBindings: false, useFavico: false, soundnotification: false,
                enableMathjax: false, enableQuickKeys: false, showNicklist: true,
                showQuickKeys: false, showJumpKeys: false, highlightWords: ''
            });
            return () => {};
        }
    },
    updateSettings: vi.fn(),
    updatePartialSettings: vi.fn()
}));

// Mock notification functions before importing handlers
vi.mock('$lib/notifications', () => ({
    createHighlight: vi.fn(),
    playNotificationSound: vi.fn(),
    updateTitle: vi.fn(),
    updateFavico: vi.fn(),
}));

const { handleBufferMoved } = await import('$lib/stores/handlers');

describe('handleBufferMoved', () => {
    function makeBuffer(id: string, number: number): BufferData {
        return {
            id,
            fullName: `#test${number}`,
            shortName: `#test${number}`,
            hidden: false,
            trimmedName: `test${number}`,
            nameClasses: [],
            prefix: '#',
            number,
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
            serverSortKey: `irc.test.#test${number}`,
            indent: true,
            bufferType: 0,
            type: 'channel',
            plugin: 'irc',
            server: 'test',
            hideBufferLineTimes: false,
            pinned: false,
            active: false
        } as BufferData;
    }

    function createMovedMessage(bufferPointer: string, newNumber: number): ProtocolMessage {
        return {
            id: '_buffer_moved',
            objects: [{
                content: [{
                    pointers: [bufferPointer],
                    number: newNumber
                }]
            }]
        } as unknown as ProtocolMessage;
    }

    beforeEach(() => {
        vi.clearAllMocks();
        buffers.set({
            '0x01': makeBuffer('0x01', 1),
            '0x02': makeBuffer('0x02', 2),
            '0x03': makeBuffer('0x03', 3),
            '0x04': makeBuffer('0x04', 4),
        });
        activeBufferId.set('');
    });

    it('shifts buffers right when moving a buffer to a lower number', () => {
        handleBufferMoved(createMovedMessage('0x04', 2));

        const all = get(buffers);
        expect(all['0x01']!.number).toBe(1);
        expect(all['0x02']!.number).toBe(3);
        expect(all['0x03']!.number).toBe(4);
        expect(all['0x04']!.number).toBe(2);
    });

    it('shifts buffers left when moving a buffer to a higher number', () => {
        handleBufferMoved(createMovedMessage('0x01', 4));

        const all = get(buffers);
        expect(all['0x01']!.number).toBe(4);
        expect(all['0x02']!.number).toBe(1);
        expect(all['0x03']!.number).toBe(2);
        expect(all['0x04']!.number).toBe(3);
    });

    it('handles adjacent move (old+1 = new) with correct shifting', () => {
        handleBufferMoved(createMovedMessage('0x02', 3));

        const all = get(buffers);
        expect(all['0x01']!.number).toBe(1);
        expect(all['0x02']!.number).toBe(3);
        expect(all['0x03']!.number).toBe(2);
        expect(all['0x04']!.number).toBe(4);
    });

    it('handles move to same position (no-op)', () => {
        handleBufferMoved(createMovedMessage('0x02', 2));

        const all = get(buffers);
        expect(all['0x01']!.number).toBe(1);
        expect(all['0x02']!.number).toBe(2);
        expect(all['0x03']!.number).toBe(3);
        expect(all['0x04']!.number).toBe(4);
    });

    it('does nothing when buffer pointer is not found', () => {
        handleBufferMoved(createMovedMessage('0x999', 2));

        const all = get(buffers);
        expect(all['0x01']!.number).toBe(1);
        expect(all['0x02']!.number).toBe(2);
        expect(all['0x03']!.number).toBe(3);
        expect(all['0x04']!.number).toBe(4);
    });

    it('does nothing when message is malformed', () => {
        const msg = { objects: [] } as unknown as ProtocolMessage;
        handleBufferMoved(msg);

        const all = get(buffers);
        expect(all['0x01']!.number).toBe(1);
    });
});
