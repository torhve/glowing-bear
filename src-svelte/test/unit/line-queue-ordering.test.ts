/**
 * Regression tests for the frame-coalesced line queue (handlers.ts):
 *  1. Non-line events dispatched via handleEvent see queued lines committed
 *     first (edits/clears must not be lost to the queue — the pre-coalescing
 *     ordering guarantee).
 *  2. handleLineInfo's skip of guaranteed-trimmed lines keeps requestedLines
 *     counting ALL received lines, which is what the history re-fetch gates
 *     (requestedLines < 100) rely on.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { get } from 'svelte/store';
import { buffers, activeBufferId, recalculateLinesPerScreen, createBuffer } from '$lib/stores/models';
import type { BufferLineMessage, ProtocolMessage } from '$lib/types';

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
                showQuickKeys: false, showJumpKeys: false, highlightWords: '', hotlistsync: true
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

vi.mock('$lib/windowFocus', () => ({
    initWindowFocusTracking: vi.fn(() => Promise.resolve(() => {})),
    isWindowFocused: () => true,
}));

vi.mock('$lib/stores/bufferResume', () => ({
    lastBufferId: {
        subscribe: (fn: (val: string) => void) => { fn(''); return () => {}; },
        set: vi.fn(),
    },
    recordLastBuffer: vi.fn(),
    shouldResume: vi.fn().mockReturnValue(false),
}));

const { handleEvent, handleLineInfo, flushLineBatch } = await import('$lib/stores/handlers');

const BASE_EPOCH = 1_700_000_000_000;

function linePayload(i: number): BufferLineMessage {
    return {
        buffer: '0xord',
        // 50ms steps keep the whole range within one local day (no date
        // separator lines — those are legitimate and would adjust the trim).
        date: BASE_EPOCH + i * 50,
        date_long: 0,
        prefix: `\x1901nick${i}\x19`,
        message: `line message ${i}`,
        tags_array: ['irc_privmsg', 'irc_msgtype', 'irc_msgtype_private'],
        displayed: 1,
        notify_level: 1,
        highlight: 0,
        id: 50_000 + i
    };
}

function makeLineAdded(lines: BufferLineMessage[]): ProtocolMessage {
    return {
        id: '_buffer_line_added',
        objects: [{ pointer: '0xord', content: lines }]
    } as unknown as ProtocolMessage;
}

function makeDataChanged(bufferId: string, date: number, message: string): ProtocolMessage {
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
                prefix: '\x1901newnick\x19',
                message
            } as BufferLineMessage]
        }]
    } as unknown as ProtocolMessage;
}

describe('line queue ordering + history skip semantics', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        buffers.set({});
        activeBufferId.set('');
        recalculateLinesPerScreen(500);
        const buffer = createBuffer({
            pointers: ['0xord'],
            full_name: 'ord',
            short_name: 'ord',
            type: 2,
            notify: 3,
            local_variables: { type: 'channel', plugin: 'irc', server: 'irc.test' }
        });
        buffers.set({ [buffer.id]: buffer });
        activeBufferId.set(buffer.id);
    });

    it('commits a queued line_added before a data_changed for that line (via handleEvent)', () => {
        // The line goes into the frame queue (not committed synchronously).
        const line = linePayload(1);
        handleEvent(makeLineAdded([line]));
        expect(get(buffers)['0xord']!.lines.length).toBe(0);

        // A non-line event must flush the queue first: the edit targets a
        // line that only exists after the flush.
        handleEvent(makeDataChanged('0xord', line.date, 'edited after queue'));

        const lines = get(buffers)['0xord']!.lines;
        expect(lines.length).toBe(1);
        expect(lines[0].text).toBe('edited after queue');
    });

    it('commits queued lines before _buffer_cleared (clear wins, no zombie lines)', () => {
        const line = linePayload(2);
        handleEvent(makeLineAdded([line]));
        handleEvent({ id: '_buffer_cleared', objects: [{ content: [{ pointers: ['0xord'] }] }] } as unknown as ProtocolMessage);

        expect(get(buffers)['0xord']!.lines.length).toBe(0);
        // Drain any residual queue so later tests see a clean state.
        flushLineBatch();
        expect(get(buffers)['0xord']!.lines.length).toBe(0);
    });

    it('handleLineInfo counts skipped (guaranteed-trimmed) lines in requestedLines', () => {
        // 3000 lines > maxBufferLines (1000 here): oldest 2000 will be trimmed.
        const content = [];
        for (let i = 0; i < 3000; i++) content.push(linePayload(3000 - i)); // newest first
        const msg = { objects: [{ pointer: '0xord', content }] } as unknown as ProtocolMessage;

        handleLineInfo(msg, true);

        const buf = get(buffers)['0xord']!;
        expect(buf.lines.length).toBeLessThanOrEqual(1000);
        // Re-fetch gate is `requestedLines < 100`: a fully-synced large buffer
        // must NOT look like it has little history.
        expect(buf.requestedLines).toBe(3000);
        expect(buf.requestedLines < 100).toBe(false);
    });

    it('small histories keep the re-fetch gate reachable (requestedLines < 100)', () => {
        const content = [];
        for (let i = 0; i < 50; i++) content.push(linePayload(50 - i));
        const msg = { objects: [{ pointer: '0xord', content }] } as unknown as ProtocolMessage;

        handleLineInfo(msg, true);

        const buf = get(buffers)['0xord']!;
        expect(buf.lines.length).toBe(50);
        expect(buf.requestedLines).toBe(50);
        expect(buf.requestedLines < 100).toBe(true);
    });
});
