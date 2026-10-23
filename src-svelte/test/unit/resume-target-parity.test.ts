/**
 * One rule decides which buffer a recovery lands on.
 *
 * Three paths used to answer that question separately: the legacy buffer-info
 * pass, the API buffer-snapshot reducer, and the retained-window handoff. The
 * legacy answer was also wrong on the wire. It looked for
 * `shortName === "core" && plugin === "weechat"`, and no buffer WeeChat reports
 * has either value — the core buffer arrives as `full_name` `core.weechat`,
 * `short_name` `weechat`, `plugin` `core`
 * (`test/fixtures/api-dossier/probes/probe-legacy-buffer-fields.mjs`). The rule
 * matched nothing, and the path still landed on core because core happens to be
 * the first key the store is built in. A fallback that works by accident is a
 * fallback that breaks when the order does.
 *
 * These specs drive all three real paths over the same buffer state, with core
 * deliberately *not* first, and require them to agree.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { activeBufferId, buffers, createBuffer, setActiveBuffer } from '#lib/stores/models.ts';
import { handleBufferInfo } from '#lib/stores/handlers.ts';
import { createApiStoreReducers } from '#lib/api/api-store-reducers.ts';
import { applyRetainedHandoff, captureRetainedState, planRetainedHandoff } from '#lib/stores/retainedChat.ts';
import { clearActiveConnectionProfile, setActiveConnectionProfile } from '#lib/connectionProfile.ts';
import { CORE_BUFFER_FULL_NAME, getLastBuffer, recordLastBuffer } from '#lib/stores/bufferResume.ts';
import { apiBuffer } from './apiFixtures.ts';
import type { ApiBufferId } from '#lib/api/api-ids.ts';
import type { BufferData, ProtocolMessage } from '#lib/types.ts';

vi.mock('#lib/stores/settings.ts', async () => (await import('./helpers/mockSettings.ts')).mockSettings());
vi.mock('#lib/notifications.ts', async () => (await import('./helpers/mockNotifications.ts')).mockNotifications());

const CHANNEL = 'irc.gbtest.#glowing-bear';
const CORE = CORE_BUFFER_FULL_NAME;
const KEY_CHANNEL = '1791000000000501';
const KEY_CORE = '1791000000000502';
const KEY_OTHER = '1791000000000503';
const ID_CHANNEL = 1791000000000501 as ApiBufferId;
const ID_CORE = 1791000000000502 as ApiBufferId;

/** The storage key `bufferResume.ts` reads; asserted empty rather than trusted. */
const LAST_BUFFER_KEY = 'gb-last-buffer';

/** A buffer built the way the relay reports it, wire spellings included. */
function seed(key: string, fullName: string, shortName: string, plugin: string): BufferData {
    const buffer = createBuffer({
        pointers: [key],
        full_name: fullName,
        short_name: shortName,
        number: plugin === 'core' ? 1 : 10,
        local_variables:
            plugin === 'core'
                ? { plugin: 'core', name: 'weechat' }
                : { type: 'channel', plugin: 'irc', server: 'gbtest', channel: shortName },
    });
    buffers.update((current) => ({ ...current, [key]: buffer }));
    return buffer;
}

/** One `_buffer_info` hdata reply, rows in the order the relay sent them. */
function bufferInfoMessage(rows: Array<{ key: string; fullName: string; shortName: string; plugin: string }>): ProtocolMessage {
    return {
        id: '1',
        objects: [
            {
                content: rows.map((row) => ({
                    pointers: [row.key],
                    local_variables:
                        row.plugin === 'core'
                            ? { plugin: 'core', name: row.shortName }
                            : { type: 'channel', plugin: 'irc', server: 'gbtest', channel: row.shortName },
                    notify: 3,
                    number: 1,
                    full_name: row.fullName,
                    short_name: row.shortName,
                    title: '',
                    hidden: 0,
                    type: 1,
                })),
            },
        ],
    } as unknown as ProtocolMessage;
}

const CHANNEL_ROW = { key: KEY_CHANNEL, fullName: CHANNEL, shortName: '#glowing-bear', plugin: 'irc' };
const CORE_ROW = { key: KEY_CORE, fullName: CORE, shortName: 'weechat', plugin: 'core' };

/** Reset to a fresh session: no buffers, nothing active, nothing saved. */
function freshSession(): void {
    buffers.set({});
    activeBufferId.set('');
    applyRetainedHandoff();
    clearActiveConnectionProfile();
}

/** The legacy transport's own buffer-info pass. */
function legacyTarget(rows: Array<{ key: string; fullName: string; shortName: string; plugin: string }>): string | null {
    handleBufferInfo(bufferInfoMessage(rows));
    return get(activeBufferId) || null;
}

/** The API transport's authoritative buffer-snapshot reducer, snapshots in relay order. */
function apiTarget(rows: Array<{ key: string; fullName: string; shortName: string; plugin: string }>): string | null {
    createApiStoreReducers().buffers(
        rows.map((row) =>
            apiBuffer(Number(row.key) as ApiBufferId, {
                name: row.fullName,
                shortName: row.shortName,
                number: row.plugin === 'core' ? 1 : 10,
                semanticType: row.plugin === 'core' ? 'other' : 'channel',
                localVariables:
                    row.plugin === 'core'
                        ? { plugin: 'core', name: row.shortName }
                        : { type: 'channel', plugin: 'irc', server: 'gbtest', channel: row.shortName },
            }),
        ),
    );
    return get(activeBufferId) || null;
}

/**
 * The retained handoff: the user was reading a buffer the new session does not
 * have, so the plan has to choose a live fallback. `live` is the authoritative
 * list the new session publishes — channel first, so core is not first here
 * either — and `savedName` is the resume intent, stated explicitly because
 * `setActiveBuffer` writes that intent itself and would otherwise decide the
 * outcome for the wrong reason.
 */
function handoffTarget(
    live: Array<{ key: string; fullName: string; shortName: string; plugin: string }>,
    savedName: string | null = null,
): string | null {
    setActiveConnectionProfile('relay.example', 443, undefined, true);
    seed(KEY_CHANNEL, CHANNEL, '#glowing-bear', 'irc');
    seed(KEY_CORE, CORE, 'weechat', 'core');
    seed(KEY_OTHER, 'irc.gbtest.#other', '#other', 'irc');
    setActiveBuffer(KEY_OTHER);

    const captured = captureRetainedState(1);
    if (!captured.captured) throw new Error(`capture failed: ${captured.reason}`);
    buffers.set({});
    activeBufferId.set('');

    for (const row of live) seed(row.key, row.fullName, row.shortName, row.plugin);

    localStorage.removeItem(LAST_BUFFER_KEY);
    if (savedName !== null) recordLastBuffer(savedName);

    return planRetainedHandoff(live.map((row) => row.key))?.activeKey ?? null;
}

beforeEach(() => {
    freshSession();
    localStorage.removeItem(LAST_BUFFER_KEY);
    expect(getLastBuffer(), 'the harness must start with no resume intent').toBeNull();
});

describe('recovery targets agree across transports', () => {
    it('every path lands on core when core is not the first buffer', () => {
        // Core is last in the legacy rows, last in the API snapshot, and last in
        // the live keys the handoff is given. None of the three may rely on
        // position to find it.
        expect(legacyTarget([CHANNEL_ROW, CORE_ROW]), 'legacy buffer-info pass').toBe(KEY_CORE);
        freshSession();
        expect(apiTarget([CHANNEL_ROW, CORE_ROW]), 'API buffer snapshot reducer').toBe(KEY_CORE);
        freshSession();
        expect(handoffTarget([CHANNEL_ROW, CORE_ROW]), 'retained handoff').toBe(KEY_CORE);
    });

    it('the buffer the user was last reading beats core on every path', () => {
        recordLastBuffer(CHANNEL);

        expect(legacyTarget([CHANNEL_ROW, CORE_ROW]), 'legacy buffer-info pass').toBe(KEY_CHANNEL);
        freshSession();
        expect(apiTarget([CHANNEL_ROW, CORE_ROW]), 'API buffer snapshot reducer').toBe(KEY_CHANNEL);
        freshSession();
        expect(handoffTarget([CHANNEL_ROW, CORE_ROW], CHANNEL), 'retained handoff').toBe(KEY_CHANNEL);
    });

    it('with no core buffer, every path takes the first candidate it was given', () => {
        expect(legacyTarget([CHANNEL_ROW]), 'legacy buffer-info pass').toBe(KEY_CHANNEL);
        freshSession();
        expect(apiTarget([CHANNEL_ROW]), 'API buffer snapshot reducer').toBe(KEY_CHANNEL);
        freshSession();
        expect(handoffTarget([CHANNEL_ROW]), 'retained handoff').toBe(KEY_CHANNEL);
    });

    it('an empty session leaves no target rather than inventing one', () => {
        expect(legacyTarget([]), 'legacy buffer-info pass').toBeNull();
    });
});
