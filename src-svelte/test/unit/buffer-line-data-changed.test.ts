import { describe, it, expect, beforeEach, vi } from 'vitest';
import { get } from 'svelte/store';
import { buffers, activeBufferId, createBuffer, createBufferLine } from '#lib/stores/models.ts';
import type { BufferData, ProtocolMessage, BufferLineMessage } from '#lib/types.ts';

vi.mock('#lib/stores/settings.ts', async () => (await import('./helpers/mockSettings.ts')).mockSettings({port: '9001', fontsize: '', noembed: false, orderbyserver: false, useFavico: false, soundnotification: false, enableQuickKeys: false}));

vi.mock('#lib/notifications.ts', async () => (await import('./helpers/mockNotifications.ts')).mockNotifications());

// Mock windowFocus so handlers module loads without runtime errors
vi.mock('#lib/windowFocus.ts', () => ({
    initWindowFocusTracking: vi.fn(() => Promise.resolve(() => {})),
    isWindowFocused: () => typeof document !== 'undefined' && !document.hidden,
}));

const { handleBufferLineDataChanged } = await import('#lib/stores/handlers.ts');

describe('handleBufferLineDataChanged', () => {
    const LINE1_DATE = 1_700_000_000_000;
    const LINE2_DATE = 1_700_000_001_000;

    function makeBuffer(id: string): BufferData {
        const buffer = createBuffer({
            pointers: [id],
            full_name: '#test',
            short_name: '#test',
            number: 1,
            local_variables: { type: 'channel', plugin: 'irc', server: 'test' },
        });
        buffer.lastSeen = 1;
        buffer.lines = [
            createBufferLine({
                buffer: id,
                date: LINE1_DATE,
                prefix: '\x19\u000304OldNick\x19',
                message: 'old message',
                tags_array: ['irc_privmsg'],
                displayed: 1,
                notify_level: 1,
                highlight: 0,
                bufferType: 'channel',
            }),
            createBufferLine({
                buffer: id,
                date: LINE2_DATE,
                prefix: '\x19\u000304OldNick\x19',
                message: 'middle message',
                tags_array: [],
                displayed: 1,
                notify_level: 1,
                highlight: 0,
                bufferType: 'channel',
            }),
        ];
        return buffer;
    }

    function createChangedMessage(bufferId: string, lineIndex: number): ProtocolMessage {
        const date = lineIndex === 0 ? LINE1_DATE : LINE2_DATE;
        return {
            id: '_buffer_line_data_changed',
            objects: [{
                content: [{
                    buffer: bufferId,
                    date,
                    date_long: date,
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
        expect(buf!.lines[0]?.text).toBe('edited message content');
        expect(buf!.lines[1]?.text).toBe('middle message');
    });

    it('updates the prefix text on the replaced line', () => {
        handleBufferLineDataChanged(createChangedMessage('0x01', 0));

        const buf = get(buffers)['0x01'];
        expect(buf!.lines[0]?.prefixtext).toContain('NewNick');
    });

    it('does not modify the other line when only one is edited', () => {
        handleBufferLineDataChanged(createChangedMessage('0x01', 0));

        const buf = get(buffers)['0x01'];
        expect(buf!.lines[1]?.text).toBe('middle message');
        expect(buf!.lines[1]?.tags).toEqual([]);
    });

    it('performs an immutable update — original array reference changes', () => {
        const beforeLines = get(buffers)['0x01']!.lines;
        handleBufferLineDataChanged(createChangedMessage('0x01', 0));
        const afterLines = get(buffers)['0x01']!.lines;

        // New array reference (Svelte reactivity)
        expect(afterLines).not.toBe(beforeLines);
        // The edited line (index 0) gets a fresh reference
        expect(afterLines[0]).not.toBe(beforeLines[0]);
        // Line objects are immutable, so unedited lines keep their reference
        expect(afterLines[1]).toBe(beforeLines[1]);
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
                        date: now, shortTime: '12:00',
                        buffer: '0x02', tags: [], highlight: false, displayed: true,
                        prefixtext: '', text: 'first', showHiddenBrackets: false
                    },
                    {
                        prefix: [{ text: '\x19\u000304B\x19', fgColor: { type: 'weechat', name: 'default' }, bgColor: { type: 'option', name: 'default' }, attrs: { name: null, override: {} } }],
                        content: [{ text: 'second', fgColor: { type: 'option', name: 'default' }, bgColor: { type: 'option', name: 'default' }, attrs: { name: null, override: {} } }],
                        date: now, shortTime: '12:00',
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
                    date_long: now,
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
        expect(buf!.lines[0]?.text).toBe('first');
        expect(buf!.lines[1]?.text).toBe('updated second');
    });

    it('does nothing when no matching line is found (wrong buffer)', () => {
        const msg = createChangedMessage('0x999', 0);
        handleBufferLineDataChanged(msg);

        const buf = get(buffers)['0x01'];
        expect(buf!.lines[0]?.text).toBe('old message');
    });

    it('does nothing when message has no content', () => {
        const msg = { objects: [] } as unknown as ProtocolMessage;
        handleBufferLineDataChanged(msg);

        const buf = get(buffers)['0x01'];
        expect(buf!.lines[0]?.text).toBe('old message');
    });

    it('handles empty objects array gracefully', () => {
        const msg = { objects: [{ content: null }] } as unknown as ProtocolMessage;
        handleBufferLineDataChanged(msg);

        const buf = get(buffers)['0x01'];
        expect(buf!.lines[0]?.text).toBe('old message');
    });
});
