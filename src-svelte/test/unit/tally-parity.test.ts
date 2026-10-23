/**
 * Cross-transport parity for the unread and notification tally.
 *
 * The rule is written twice: inline in the legacy line handler, and as
 * `tallyLine` in the API reducers, which its own comment calls a port of the
 * legacy rules. Each copy has its own tests — `handlers-notification.test.ts`
 * on one side, the tally gates in `api-store-reducers.test.ts` on the other —
 * and no test asserts they agree. That is the condition under which the three
 * copies of the line trim drifted apart, so agreement is established here
 * before anything is shared.
 *
 * Every case drives one line through both transports and compares the three
 * counters. The matrix is the gate structure itself: notify level, the buffer's
 * own notify setting, buffer type, highlight, active or not, sync phase open
 * with a known or unknown boundary, and relay status buffers.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { get } from 'svelte/store';
import {
    buffers, activeBufferId, createBuffer, recalculateLinesPerScreen,
    beginSyncPhase, endSyncPhase,
} from '#lib/stores/models.ts';
import { handleBufferLineAdded } from '#lib/stores/handlers.ts';
import { createApiStoreReducers, flushApiLineBatch } from '#lib/api/api-store-reducers.ts';
import type { BufferSnapshot, LineSnapshot } from '#lib/api/api-contracts.ts';
import type { ApiBufferId, ApiLineId } from '#lib/api/api-ids.ts';
import { apiBuffer, apiLine } from './apiFixtures.ts';
import type { ProtocolMessage } from '#lib/types.ts';

vi.mock('#lib/notifications.ts', async () => (await import('./helpers/mockNotifications.ts')).mockNotifications());
vi.mock('#lib/windowFocus.ts', () => ({
    isWindowFocused: () => false,
}));

const LEGACY_ID = '0x100';
const API_ID = 1759000000000001 as ApiBufferId;
const API_KEY = String(API_ID);

interface Case {
    label: string;
    /** The buffer's own notify setting: 0 none, 1 message, 2 highlight, 3 all. */
    notify: 0 | 1 | 2 | 3;
    /** The line's notify level: 0 backfill, 1 message, 2 private, 3 highlight. */
    notifyLevel: 0 | 1 | 2 | 3;
    highlight: boolean;
    /** local_variables.type, the semantic buffer type both transports read. */
    bufferType: string;
    /** local_variables.plugin; 'relay' marks a relay status buffer. */
    plugin: string;
    active: boolean;
    syncing: boolean;
    boundaryKnown: boolean;
    displayed: boolean;
}

interface Counters {
    localUnread: number;
    unread: number;
    notification: number;
    lines: number;
}

const CASES: Case[] = [
    { label: 'channel message, notify all', notify: 3, notifyLevel: 1, highlight: false, bufferType: 'channel', plugin: 'irc', active: false, syncing: false, boundaryKnown: true, displayed: true },
    { label: 'channel message, notify highlight-only', notify: 2, notifyLevel: 1, highlight: false, bufferType: 'channel', plugin: 'irc', active: false, syncing: false, boundaryKnown: true, displayed: true },
    { label: 'channel message, notify message-only', notify: 1, notifyLevel: 1, highlight: false, bufferType: 'channel', plugin: 'irc', active: false, syncing: false, boundaryKnown: true, displayed: true },
    { label: 'channel message, notify none', notify: 0, notifyLevel: 1, highlight: false, bufferType: 'channel', plugin: 'irc', active: false, syncing: false, boundaryKnown: true, displayed: true },
    { label: 'backfill line, notify level 0', notify: 3, notifyLevel: 0, highlight: false, bufferType: 'channel', plugin: 'irc', active: false, syncing: false, boundaryKnown: true, displayed: true },
    { label: 'PM in a query buffer', notify: 3, notifyLevel: 2, highlight: false, bufferType: 'query', plugin: 'irc', active: false, syncing: false, boundaryKnown: true, displayed: true },
    { label: 'PM in a private buffer', notify: 2, notifyLevel: 2, highlight: false, bufferType: 'private', plugin: 'irc', active: false, syncing: false, boundaryKnown: true, displayed: true },
    { label: 'PM with notify none', notify: 0, notifyLevel: 2, highlight: false, bufferType: 'query', plugin: 'irc', active: false, syncing: false, boundaryKnown: true, displayed: true },
    { label: 'highlight in a channel', notify: 3, notifyLevel: 3, highlight: true, bufferType: 'channel', plugin: 'irc', active: false, syncing: false, boundaryKnown: true, displayed: true },
    { label: 'notify level 2 in a channel without a highlight', notify: 3, notifyLevel: 2, highlight: false, bufferType: 'channel', plugin: 'irc', active: false, syncing: false, boundaryKnown: true, displayed: true },
    { label: 'line in the active buffer', notify: 3, notifyLevel: 2, highlight: true, bufferType: 'query', plugin: 'irc', active: true, syncing: false, boundaryKnown: true, displayed: true },
    { label: 'relay status buffer', notify: 3, notifyLevel: 2, highlight: true, bufferType: 'channel', plugin: 'relay', active: false, syncing: false, boundaryKnown: true, displayed: true },
    { label: 'sync open, boundary unknown', notify: 3, notifyLevel: 1, highlight: false, bufferType: 'channel', plugin: 'irc', active: false, syncing: true, boundaryKnown: false, displayed: true },
    { label: 'sync open, boundary known', notify: 3, notifyLevel: 1, highlight: false, bufferType: 'channel', plugin: 'irc', active: false, syncing: true, boundaryKnown: true, displayed: true },
    { label: 'sync open, highlight, boundary unknown', notify: 3, notifyLevel: 3, highlight: true, bufferType: 'channel', plugin: 'irc', active: false, syncing: true, boundaryKnown: false, displayed: true },
    { label: 'undisplayed line', notify: 3, notifyLevel: 1, highlight: false, bufferType: 'channel', plugin: 'irc', active: false, syncing: false, boundaryKnown: true, displayed: false },
];

function reset() {
    buffers.set({});
    activeBufferId.set('');
    recalculateLinesPerScreen(500);
}

function countersOf(buffer: { localUnread?: number; unread?: number; notification?: number; lines: unknown[] }): Counters {
    return {
        localUnread: buffer.localUnread ?? 0,
        unread: buffer.unread ?? 0,
        notification: buffer.notification ?? 0,
        lines: buffer.lines.length,
    };
}

/** The legacy path: `_buffer_line_added` straight into the handler. */
function legacyTally(c: Case): Counters {
    reset();
    const buffer = createBuffer({
        pointers: [LEGACY_ID],
        full_name: 'irc.test.#chan',
        short_name: '#chan',
        type: 2,
        notify: c.notify,
        local_variables: { type: c.bufferType, plugin: c.plugin, server: 'test' },
    });
    buffers.set({ [LEGACY_ID]: buffer });
    if (c.active) activeBufferId.set(LEGACY_ID);
    if (!c.boundaryKnown) get(buffers)[LEGACY_ID]!.readBoundaryKnown = false;

    const token = c.syncing ? beginSyncPhase() : null;
    try {
        handleBufferLineAdded({
            objects: [{
                pointer: LEGACY_ID,
                content: [{
                    buffer: LEGACY_ID,
                    date: 1_700_000_000,
                    date_long: 0,
                    prefix: '\x1901Nick\x19',
                    message: 'a line',
                    tags_array: ['irc_privmsg'],
                    displayed: c.displayed ? 1 : 0,
                    notify_level: c.notifyLevel,
                    highlight: c.highlight ? 1 : 0,
                    id: 50_001,
                }],
            }],
        } as unknown as ProtocolMessage);
    } finally {
        if (token !== null) endSyncPhase(token);
    }

    return countersOf(get(buffers)[LEGACY_ID]!);
}

/** The API path: a `line_added` event through the reducers and its line batch. */
function apiTally(c: Case): Counters {
    reset();
    const reducers = createApiStoreReducers();
    const snapshot = apiBuffer(API_ID, {
        name: 'irc.test.#chan',
        shortName: '#chan',
        number: 2,
        semanticType: c.bufferType as BufferSnapshot['semanticType'],
        title: '#chan',
        localVariables: { type: c.bufferType, plugin: c.plugin, server: 'test' },
        notify: c.notify,
    });
    reducers.buffers([snapshot]);
    // The bootstrap auto-selects a default buffer to view, which would make every
    // case here an active buffer and tally nothing. The selection has to be
    // overwritten after it, not before.
    activeBufferId.set(c.active ? API_KEY : '');
    if (!c.boundaryKnown) get(buffers)[API_KEY]!.readBoundaryKnown = false;

    const line = apiLine(50_001, {
        epochMs: 1_700_000_000_000,
        displayed: c.displayed,
        highlight: c.highlight,
        notifyLevel: c.notifyLevel,
        prefix: 'Nick',
        message: 'a line',
        tags: ['notify_message'],
    });

    const token = c.syncing ? beginSyncPhase() : null;
    try {
        reducers.lineAdded(API_ID, line);
        flushApiLineBatch();
    } finally {
        if (token !== null) endSyncPhase(token);
    }

    return countersOf(get(buffers)[API_KEY]!);
}

describe('the unread tally means the same thing on both transports', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        buffers.set({});
        activeBufferId.set('');
    });

    for (const c of CASES) {
        it(c.label, () => {
            const legacy = legacyTally(c);
            const api = apiTally(c);

            expect(api, `${c.label}\nlegacy: ${JSON.stringify(legacy)}\napi:    ${JSON.stringify(api)}`)
                .toEqual(legacy);
        });
    }
});
