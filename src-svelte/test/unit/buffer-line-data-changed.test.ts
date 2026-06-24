import { describe, it, expect, beforeEach, vi } from 'vitest';
import { get } from 'svelte/store';
import { buffers, activeBufferId } from '$lib/stores/models';
import type { BufferData, ProtocolMessage, BufferLineMessage } from '$lib/types';

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
                showQuickKeys: false, highlightWords: ''
            });
            return () => {};
        }
    },
    updateSettings: vi.fn(),
    updatePartialSettings: vi.fn()
}));

vi.mock('$lib/notifications', () => ({
    createHighlight: vi.fn(),
    playNotificationSound: vi.fn(),
    updateTitle: vi.fn(),
    updateFavico: vi.fn(),
}));

const { handleBufferLineDataChanged } = await import('$lib/stores/handlers');

describe('handleBufferLineDataChanged', () => {
    const LINE1_DATE = 1_700_000_000_000;
    const LINE2_DATE = 1_700_000_001_000;

    function makeBuffer(id: string): BufferData {
        return {
            id,
            fullName: '#test',
            shortName: '#test',
            hidden: false,
            trimmedName: 'test',
            nameClasses: [],
            prefix: '#',
            number: 1,
            title: [],
            rtitle: '',
            lines: [
                {
                    prefix: [{ text: '\x19\u000304OldNick\x19', fgColor: { type: 'weechat', name: 'default' }, bgColor: { type: 'option', name: 'default' }, attrs: { name: null, override: {} } }],
                    content: [{ text: 'old message', fgColor: { type: 'option', name: 'default' }, bgColor: { type: 'option', name: 'default' }, attrs: { name: null, override: {} } }],
                    date: LINE1_DATE,
                    shortTime: '12:00',
                    formattedTime: '12:00:00',
                    buffer: id,
                    tags: ['irc_privmsg'],
                    highlight: false,
                    displayed: true,
                    prefixtext: '\x19\u000304OldNick\x19',
                    text: 'old message',
                    showHiddenBrackets: false
                },
                {
                    prefix: [{ text: '\x19\u000304OldNick\x19', fgColor: { type: 'weechat', name: 'default' }, bgColor: { type: 'option', name: 'default' }, attrs: { name: null, override: {} } }],
                    content: [{ text: 'middle message', fgColor: { type: 'option', name: 'default' }, bgColor: { type: 'option', name: 'default' }, attrs: { name: null, override: {} } }],
                    date: LINE2_DATE,
                    shortTime: '12:00',
                    formattedTime: '12:00:00',
                    buffer: id,
                    tags: [],
                    highlight: false,
                    displayed: true,
                    prefixtext: '\x19\u000304OldNick\x19',
                    text: 'middle message',
                    showHiddenBrackets: false
                }
            ],
            requestedLines: 2,
            allLinesFetched: false,
            lastSeen: 1,
            localUnread: 0,
            unread: 0,
            notification: 0,
            notify: 3,
            nicklist: {},
            serverSortKey: 'irc.test.#test',
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

    function createChangedMessage(bufferId: string, lineIndex: number): ProtocolMessage {
        const date = lineIndex === 0 ? LINE1_DATE : LINE2_DATE;
        return {
            id: '_buffer_line_data_changed',
            objects: [{
                content: [{
                    buffer: bufferId,
                    date,
                    date_usec: 0,
                    date_printed: date,
                    date_usec_printed: 0,
                    displayed: 1,
                    notify_level: 1,
                    highlight: 0,
                    tags_array: ['irc_privmsg'],
                    prefix: `\x19\u000304NewNick\x19`,
                    message: 'edited message content'
                } as BufferLineMessage]
            }]
        } as unknown as ProtocolMessage;
    }

    beforeEach(() => {
        vi.clearAllMocks();
        buffers.set({ '0x01': makeBuffer('0x01') });
        activeBufferId.set('');
    });

    it('replaces the matching line with updated content', () => {
        handleBufferLineDataChanged(createChangedMessage('0x01', 0));

        const buf = get(buffers)['0x01'];
        expect(buf!.lines[0].text).toBe('edited message content');
        expect(buf!.lines[1].text).toBe('middle message');
    });

    it('updates the prefix text on the replaced line', () => {
        handleBufferLineDataChanged(createChangedMessage('0x01', 0));

        const buf = get(buffers)['0x01'];
        expect(buf!.lines[0].prefixtext).toContain('NewNick');
    });

    it('does not modify the other line when only one is edited', () => {
        handleBufferLineDataChanged(createChangedMessage('0x01', 0));

        const buf = get(buffers)['0x01'];
        expect(buf!.lines[1].text).toBe('middle message');
        expect(buf!.lines[1].tags).toEqual([]);
    });

    it('performs an immutable update — original array reference changes', () => {
        const beforeLines = get(buffers)['0x01']!.lines;
        handleBufferLineDataChanged(createChangedMessage('0x01', 0));
        const afterLines = get(buffers)['0x01']!.lines;

        // New array reference (Svelte reactivity)
        expect(afterLines).not.toBe(beforeLines);
        // Every line gets a fresh reference (shallow clone for Svelte reactivity)
        expect(afterLines[1]).not.toBe(beforeLines[1]);
    });

    it('handles multiple lines with same timestamp by picking last match', () => {
        const now = Date.now();
        buffers.update((b: Record<string, BufferData>) => ({
            ...b,
            '0x02': {
                ...makeBuffer('0x02'),
                id: '0x02',
                lines: [
                    {
                        prefix: [{ text: '\x19\u000304A\x19', fgColor: { type: 'weechat', name: 'default' }, bgColor: { type: 'option', name: 'default' }, attrs: { name: null, override: {} } }],
                        content: [{ text: 'first', fgColor: { type: 'option', name: 'default' }, bgColor: { type: 'option', name: 'default' }, attrs: { name: null, override: {} } }],
                        date: now, shortTime: '12:00', formattedTime: '12:00:00',
                        buffer: '0x02', tags: [], highlight: false, displayed: true,
                        prefixtext: '', text: 'first', showHiddenBrackets: false
                    },
                    {
                        prefix: [{ text: '\x19\u000304B\x19', fgColor: { type: 'weechat', name: 'default' }, bgColor: { type: 'option', name: 'default' }, attrs: { name: null, override: {} } }],
                        content: [{ text: 'second', fgColor: { type: 'option', name: 'default' }, bgColor: { type: 'option', name: 'default' }, attrs: { name: null, override: {} } }],
                        date: now, shortTime: '12:00', formattedTime: '12:00:00',
                        buffer: '0x02', tags: [], highlight: false, displayed: true,
                        prefixtext: '', text: 'second', showHiddenBrackets: false
                    }
                ]
            }
        }));

        // Message with same timestamp for both lines — should update the last one (index 1)
        const msg = {
            id: '_buffer_line_data_changed',
            objects: [{
                content: [{
                    buffer: '0x02',
                    date: now,
                    date_usec: 0,
                    date_printed: now,
                    date_usec_printed: 0,
                    displayed: 1,
                    notify_level: 1,
                    highlight: 0,
                    tags_array: [],
                    prefix: '\x19\u000304X\x19',
                    message: 'updated second'
                } as BufferLineMessage]
            }]
        } as unknown as ProtocolMessage;

        handleBufferLineDataChanged(msg);

        const buf = get(buffers)['0x02'];
        expect(buf!.lines[0].text).toBe('first');
        expect(buf!.lines[1].text).toBe('updated second');
    });

    it('does nothing when no matching line is found (wrong buffer)', () => {
        const msg = createChangedMessage('0x999', 0);
        handleBufferLineDataChanged(msg);

        const buf = get(buffers)['0x01'];
        expect(buf!.lines[0].text).toBe('old message');
    });

    it('does nothing when message has no content', () => {
        const msg = { objects: [] } as unknown as ProtocolMessage;
        handleBufferLineDataChanged(msg);

        const buf = get(buffers)['0x01'];
        expect(buf!.lines[0].text).toBe('old message');
    });

    it('handles empty objects array gracefully', () => {
        const msg = { objects: [{ content: null }] } as unknown as ProtocolMessage;
        handleBufferLineDataChanged(msg);

        const buf = get(buffers)['0x01'];
        expect(buf!.lines[0].text).toBe('old message');
    });
});
