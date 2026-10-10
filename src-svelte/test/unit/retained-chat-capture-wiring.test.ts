/**
 * Capture wiring: which transport wipe retains, and exactly when.
 *
 * Commit 3 connects `retainedChat` to the transports without changing what any
 * user sees. What it must not get wrong is *ordering* and *intent*:
 *
 *   - Each wipe drains its own queued line batch internally. A capture placed
 *     before that drain silently loses the last batch — the lines that arrived
 *     in the same frame as the disconnect.
 *   - A capture placed after `buffers.set({})` captures nothing.
 *   - A wipe cannot tell an unexpected loss from an explicit Leave, so the call
 *     site declares intent and the wipe consumes it. Explicit paths must never
 *     mark it, and a stale intent must not survive into a later wipe.
 *
 * These tests drive the real wipe functions rather than a reimplementation of
 * them, which is the only way the ordering assertions mean anything.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { activeBufferId, buffers, createBuffer, setActiveBuffer } from '#lib/stores/models.ts';
import { connectionState } from '#lib/stores/connectionStore.ts';
import { clearActiveConnectionProfile, setActiveConnectionProfile } from '#lib/connectionProfile.ts';
import { disconnect as facadeDisconnect } from '#lib/stores/connectionManager.ts';
import { flushLineBatch, handleEvent } from '#lib/stores/handlers.ts';
import { createApiStoreReducers, flushApiLineBatch } from '#lib/api/api-store-reducers.ts';
import type { LineSnapshot } from '#lib/api/api-contracts.ts';
import type { ApiBufferId } from '#lib/api/api-ids.ts';
import type { ProtocolMessage } from '#lib/types.ts';
import * as api from '#lib/stores/apiConnection.ts';
import * as legacy from '#lib/stores/legacyConnection.ts';
import {
    captureRetainedState,
    clearCaptureIntent,
    getLastRelease,
    getRetainedSnapshot,
    hasCaptureIntent,
    markCaptureIntent,
    releaseIfProfileChanged,
    releaseRetainedSnapshot,
} from '#lib/stores/retainedChat.ts';

// The wipe ends with a notification hook; this suite is about state, not sound.
vi.mock('#lib/notifications.ts', () => ({
    createHighlight: vi.fn(),
    playNotificationSound: vi.fn(),
    updateTitle: vi.fn(),
    updateFavicon: vi.fn(),
    updateFavico: vi.fn(),
    startIndicatorOwner: () => () => {},
    refreshIndicators: vi.fn(),
    onDisconnect: vi.fn(),
}));

const RELAY = 'https://relay.example:443';
const OTHER_RELAY = 'https://other.example:443';
const API_KEY = '1791000000000101';
const API_ID = 1791000000000101 as ApiBufferId;
const LEGACY_KEY = '0x7f0001';

function seed(key: string, fullName: string, shortName: string): void {
    buffers.update((current) => ({
        ...current,
        [key]: createBuffer({
            pointers: [key],
            full_name: fullName,
            short_name: shortName,
            number: 1,
            local_variables: { type: 'channel', server: 'gbtest', plugin: 'irc' },
        }),
    }));
}

function markSessionEstablished(): void {
    connectionState.update((current) => ({ ...current, wasEverConnected: true, userDisconnect: false }));
}

function apiLine(id: number): LineSnapshot {
    return {
        id: id as LineSnapshot['id'],
        y: id,
        date: '2026-01-01T00:00:00.000Z',
        epochMs: 1767225600000 + id,
        displayed: true,
        highlight: false,
        notifyLevel: 2,
        prefix: `<alice${id}>`,
        message: `queued line ${id}`,
        tags: ['irc_privmsg'],
    };
}

function legacyLineEvent(id: number): ProtocolMessage {
    return {
        id: '_buffer_line_added',
        objects: [{
            pointer: LEGACY_KEY,
            content: [{
                buffer: LEGACY_KEY,
                date: 1767225600,
                date_long: 1767225600,
                prefix: `<bob${id}>`,
                message: `queued line ${id}`,
                tags_array: ['irc_privmsg'],
                displayed: 1,
                notify_level: 2,
                highlight: 0,
                id,
            }],
        }],
    } as unknown as ProtocolMessage;
}

beforeEach(() => {
    buffers.set({});
    activeBufferId.set('');
    clearCaptureIntent();
    releaseRetainedSnapshot('explicit-leave');
    clearActiveConnectionProfile();
    connectionState.update((current) => ({ ...current, wasEverConnected: false, userDisconnect: false }));
});

describe('API wipe: capture sits between the drain and the clear', () => {
    it('retains a line that was still queued when the wipe ran', () => {
        setActiveConnectionProfile('relay.example', 443, undefined, true);
        seed(API_KEY, 'irc.gbtest.#glowing-bear', '#glowing-bear');
        setActiveBuffer(API_KEY);
        markSessionEstablished();

        // One line already applied, one still sitting in the frame's batch.
        const reducers = createApiStoreReducers();
        reducers.lineAdded(API_ID, apiLine(1));
        // Applied through the drain itself, not a wipe: a wipe would clear the
        // live store and the assertion below would prove nothing.
        flushApiLineBatch();
        expect(get(buffers)[API_KEY]?.lines).toHaveLength(1);

        reducers.lineAdded(API_ID, apiLine(2));
        markCaptureIntent();
        api.__resetAllStateForTest(7);

        const retained = getRetainedSnapshot();
        expect(retained, 'a wipe with intent must retain the session').not.toBeNull();
        // The queued line is in the snapshot, so capture ran AFTER the drain.
        expect(retained!.buffers.get(API_KEY)!.lines.map((l) => l.text)).toEqual([
            'queued line 1',
            'queued line 2',
        ]);
        // The live store is wiped, so capture ran BEFORE the clear.
        expect(get(buffers)).toEqual({});
        expect(retained!.generation).toBe(7);
        expect(retained!.profileKey).toBe(RELAY);
    });

    it('captures nothing when no loss intent was declared', () => {
        setActiveConnectionProfile('relay.example', 443, undefined, true);
        seed(API_KEY, 'irc.gbtest.#glowing-bear', '#glowing-bear');
        setActiveBuffer(API_KEY);
        markSessionEstablished();

        // `triggerManualReconnect()` and `disconnect()` both wipe without
        // intent: a retry of an already-retained session must not re-capture.
        api.__resetAllStateForTest();
        expect(getRetainedSnapshot()).toBeNull();
    });

    it('cannot be replaced or emptied by a second wipe of the same loss', () => {
        setActiveConnectionProfile('relay.example', 443, undefined, true);
        seed(API_KEY, 'irc.gbtest.#glowing-bear', '#glowing-bear');
        setActiveBuffer(API_KEY);
        createApiStoreReducers().lineAdded(API_ID, apiLine(1));
        flushApiLineBatch();
        markSessionEstablished();
        markCaptureIntent();
        api.__resetAllStateForTest(1);
        const token = getRetainedSnapshot()!.token;

        // Legacy's retry timer and the facade's second transport wipe both run
        // against stores that are already empty.
        api.__resetAllStateForTest(2);
        expect(getRetainedSnapshot()!.token).toBe(token);
        expect(getRetainedSnapshot()!.buffers.get(API_KEY)!.lines).toHaveLength(1);
        expect(hasCaptureIntent()).toBe(false);
    });
});

describe('legacy wipe: same boundary, its own drain', () => {
    it('retains a line that was still queued when the wipe ran', () => {
        setActiveConnectionProfile('relay.example', 443, undefined, true);
        seed(LEGACY_KEY, 'irc.gbtest.#glowing-bear', '#glowing-bear');
        setActiveBuffer(LEGACY_KEY);
        markSessionEstablished();

        // Legacy batches _buffer_line_added and flushes frame-aligned.
        handleEvent(legacyLineEvent(1));
        flushLineBatch();
        expect(get(buffers)[LEGACY_KEY]?.lines).toHaveLength(1);

        handleEvent(legacyLineEvent(2));
        markCaptureIntent();
        legacy.__resetAllStateForTest(4);

        const retained = getRetainedSnapshot();
        expect(retained, 'a wipe with intent must retain the session').not.toBeNull();
        expect(retained!.buffers.get(LEGACY_KEY)!.lines.map((l) => l.text)).toEqual([
            'queued line 1',
            'queued line 2',
        ]);
        expect(get(buffers)).toEqual({});
        expect(retained!.generation).toBe(4);
    });

    it('captures nothing when no loss intent was declared', () => {
        setActiveConnectionProfile('relay.example', 443, undefined, true);
        seed(LEGACY_KEY, 'irc.gbtest.#glowing-bear', '#glowing-bear');
        setActiveBuffer(LEGACY_KEY);
        markSessionEstablished();

        // `scheduleReconnect()`'s timer wipe and `disconnect()` pass no intent.
        legacy.__resetAllStateForTest();
        expect(getRetainedSnapshot()).toBeNull();
    });
});

describe('which orchestrator statuses count as a loss', () => {
    it('retains a reconnect after a session existed', () => {
        expect(api.shouldRetainOnStatus('reconnecting', true, true)).toBe(true);
    });

    it('does not retain a failed FIRST connect that only now schedules a retry', () => {
        // The orchestrator labels every attempt after the first 'reconnecting',
        // so the label alone is not evidence that anything was loaded.
        expect(api.shouldRetainOnStatus('reconnecting', false, true)).toBe(false);
        expect(api.shouldRetainOnStatus('failed', false, true)).toBe(false);
    });

    it('does not retain a terminal failure that never had a session', () => {
        expect(api.shouldRetainOnStatus('failed', false, false)).toBe(false);
        expect(api.shouldRetainOnStatus('failed', true, false)).toBe(false);
    });

    it('retains a terminal failure of a real session', () => {
        expect(api.shouldRetainOnStatus('failed', true, true)).toBe(true);
    });

    it('never retains the status our own disconnect produces', () => {
        expect(api.shouldRetainOnStatus('disconnected', true, true)).toBe(false);
        expect(api.shouldRetainOnStatus('connected', true, true)).toBe(false);
        expect(api.shouldRetainOnStatus('connecting', true, true)).toBe(false);
        expect(api.shouldRetainOnStatus('bootstrapping', true, true)).toBe(false);
        expect(api.shouldRetainOnStatus('idle', true, true)).toBe(false);
    });
});

describe('explicit departure through the facade', () => {
    it('retains nothing, even with a capture intent left over from an earlier loss', () => {
        setActiveConnectionProfile('relay.example', 443, undefined, true);
        seed(API_KEY, 'irc.gbtest.#glowing-bear', '#glowing-bear');
        setActiveBuffer(API_KEY);
        markSessionEstablished();

        // A stale intent must not survive into an intentional Leave: the facade
        // clears it before either transport wipe runs.
        markCaptureIntent();
        facadeDisconnect();

        expect(getRetainedSnapshot()).toBeNull();
        expect(hasCaptureIntent()).toBe(false);
        expect(get(buffers)).toEqual({});
    });

    it('releases a retained view as an explicit leave', () => {
        setActiveConnectionProfile('relay.example', 443, undefined, true);
        seed(API_KEY, 'irc.gbtest.#glowing-bear', '#glowing-bear');
        setActiveBuffer(API_KEY);
        expect(captureRetainedState(1).captured).toBe(true);

        facadeDisconnect();

        expect(getRetainedSnapshot()).toBeNull();
        expect(getLastRelease()).toEqual({ reason: 'explicit-leave', token: expect.any(Number) });
    });
});

describe('profile change while a view is retained', () => {
    it('releases a view that belongs to another relay', () => {
        setActiveConnectionProfile('relay.example', 443, undefined, true);
        seed(API_KEY, 'irc.gbtest.#glowing-bear', '#glowing-bear');
        setActiveBuffer(API_KEY);
        const token = captureRetainedState(1).token;

        setActiveConnectionProfile('other.example', 443, undefined, true);
        expect(releaseIfProfileChanged()).toBe(true);
        expect(getRetainedSnapshot()).toBeNull();
        expect(getLastRelease()).toEqual({ reason: 'profile-change', token: token! });
    });

    it('keeps the view when the new attempt targets the same relay', () => {
        setActiveConnectionProfile('relay.example', 443, undefined, true);
        seed(API_KEY, 'irc.gbtest.#glowing-bear', '#glowing-bear');
        setActiveBuffer(API_KEY);
        const outcome = captureRetainedState(1);
        expect(outcome.captured).toBe(true);

        // A retry is not a profile change: its successful bootstrap is where the
        // retained window gets handed off, so the view has to survive this call.
        setActiveConnectionProfile('relay.example', 443, undefined, true);
        expect(releaseIfProfileChanged()).toBe(false);
        expect(getRetainedSnapshot()!.token).toBe(outcome.token);
    });

    it('is a no-op when nothing is retained', () => {
        setActiveConnectionProfile('relay.example', 443, undefined, true);
        expect(releaseIfProfileChanged()).toBe(false);
    });

    it('clears a pending intent so a later wipe by the other transport captures nothing', () => {
        // The one path where mark and consume are NOT adjacent: an intent marked
        // for the old session, then the user targets another relay. Without the
        // release clearing it, a wipe belonging to the NEW session would capture
        // the new session's state under the old session's loss.
        setActiveConnectionProfile('relay.example', 443, undefined, true);
        seed(API_KEY, 'irc.gbtest.#glowing-bear', '#glowing-bear');
        setActiveBuffer(API_KEY);
        captureRetainedState(1);
        markCaptureIntent();

        setActiveConnectionProfile('other.example', 443, undefined, true);
        expect(releaseIfProfileChanged()).toBe(true);
        expect(hasCaptureIntent()).toBe(false);

        seed(LEGACY_KEY, 'irc.other.#new-channel', '#new-channel');
        setActiveBuffer(LEGACY_KEY);
        legacy.__resetAllStateForTest(9);
        expect(getRetainedSnapshot(), 'the new session must not inherit the old intent').toBeNull();
    });

    it('clears a pending intent even when no view was retained yet', () => {
        // A loss can mark intent and be released before its wipe ever ran; the
        // release's early return for an empty snapshot must not skip the clear.
        setActiveConnectionProfile('relay.example', 443, undefined, true);
        markCaptureIntent();
        releaseRetainedSnapshot('profile-change');
        expect(hasCaptureIntent()).toBe(false);
    });
});
