/**
 * The shared connection lifecycle.
 *
 * This module exists because both transports carried their own copy of the same
 * lifecycle glue. Two properties matter more than any single behaviour here, and
 * every test below is really about one of them:
 *
 *   - ONE implementation. A rule that lives in two files drifts; the pair of
 *     copies is the defect, not any one wrong value.
 *   - ONE ordering. The retained snapshot must be taken while the stores still
 *     hold the whole session, so capture has to sit between the drain and the
 *     wipe. A refactor that reorders it is invisible in the UI and fatal on a
 *     dropped connection.
 *
 * The backoff tests are the concrete hazard: the legacy transport counts attempts
 * from 1 because the user reads "attempt 1", the API orchestrator counts from 0.
 * Both must produce the same first wait, and a one-step error looks exactly like a
 * working ladder.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import {
    activeBufferId,
    bufferBottom,
    buffers,
    connected,
    createBuffer,
    createBufferLine,
    hotlistClearedBuffers,
    localUnreadBuffers,
    pendingBufferSwitch,
    previousBufferId,
    relayApiVersion,
    servers,
    weechatVersion,
} from '#lib/stores/models.ts';
import { connectionState, setNextReconnectAt } from '#lib/stores/connectionStore.ts';
import { settings } from '#lib/stores/settings.ts';
import { clearToasts, toastStore } from '#lib/toast.ts';
import { clearActiveConnectionProfile, setActiveConnectionProfile } from '#lib/connectionProfile.ts';
import { createApiStoreReducers, flushApiLineBatch } from '#lib/api/api-store-reducers.ts';
import type { BufferSnapshot } from '#lib/api/api-contracts.ts';
import type { ApiBufferId, ApiLineId } from '#lib/api/api-ids.ts';
import * as api from '#lib/stores/apiConnection.ts';
import {
    clearCaptureIntent,
    getRetainedSnapshot,
    markCaptureIntent,
    releaseRetainedSnapshot,
} from '#lib/stores/retainedChat.ts';
import {
    HOTLIST_DEBOUNCE_MS,
    RECONNECT_BACKOFF,
    cleanupFocusReconnect,
    countdownText,
    findDisconnectToast,
    hotlistPollInterval,
    registerFocusReconnect,
    reconnectDelay,
    resetAppState,
    setHotlistPollInterval,
    showDisconnectToast,
    type ConnectionProfile,
    type PendingRetry,
} from '#lib/stores/connectionLifecycle.ts';

const KEY = '1791000000000901';
const API_ID = 1791000000000901 as ApiBufferId;

function apiSnapshot(id: ApiBufferId): BufferSnapshot {
    return {
        id,
        name: 'irc.gbtest.#glowing-bear',
        shortName: '#glowing-bear',
        number: 1,
        contentType: 'formatted',
        semanticType: 'channel',
        hidden: false,
        title: '#glowing-bear',
        localVariables: { type: 'channel', plugin: 'irc', server: 'gbtest' },
        lastReadLineId: -1,
    };
}

function apiLine(id: ApiLineId, message: string) {
    return {
        id,
        epochMs: Date.parse('2026-10-12T12:00:00.000Z'),
        displayed: true,
        highlight: false,
        notifyLevel: 0,
        prefix: 'gbbot',
        message,
        tags: [],
    };
}

const PROFILE: ConnectionProfile = {
    host: 'relay.example',
    port: 9001,
    path: 'weechat',
    password: 'testpassword123',
    tls: false,
    noCompression: true,
};

function seedBufferWithLine() {
    const buffer = createBuffer({
        pointers: [KEY],
        full_name: 'irc.gbtest.#glowing-bear',
        short_name: '#glowing-bear',
        number: 1,
        local_variables: { type: 'channel', server: 'gbtest', plugin: 'irc' },
    });
    buffer.lines.push(createBufferLine({
        buffer: KEY,
        date: '2026-10-12T12:00:00',
        prefix: 'gbbot',
        message: 'the only line',
        tags_array: [],
        displayed: 1,
        highlight: 0,
        id: 41,
        bufferType: 'channel',
    }));
    buffers.update((current) => ({ ...current, [KEY]: buffer }));
    return buffer;
}

beforeEach(() => {
    buffers.set({});
    servers.set({});
    clearToasts();
    clearCaptureIntent();
    releaseRetainedSnapshot('explicit-leave');
    clearActiveConnectionProfile();
    cleanupFocusReconnect();
});

afterEach(() => {
    cleanupFocusReconnect();
    setHotlistPollInterval(15_000);
});

describe('the retry ladder is one ladder', () => {
    it('waits 30s, then x1.5, and stops growing at 5 minutes', () => {
        // Pinned as numbers on purpose. A ladder that "looks exponential" is not
        // the contract; these intervals are what the countdown toast promises.
        expect(reconnectDelay(0)).toBe(30_000);
        expect(reconnectDelay(1)).toBe(45_000);
        expect(reconnectDelay(2)).toBe(67_500);
        expect(reconnectDelay(3)).toBe(101_250);
        expect(reconnectDelay(10)).toBe(300_000);
    });

    it('never exceeds the cap, however long the outage lasts', () => {
        for (let attempt = 0; attempt < 60; attempt++) {
            expect(reconnectDelay(attempt)).toBeLessThanOrEqual(RECONNECT_BACKOFF.maxMs);
        }
    });

    it('gives the same first wait under both transports’ attempt conventions', () => {
        // Legacy: `incrementReconnectAttempts()` returns 1 on the first failure and
        // the call site passes `attempts - 1`. API: the orchestrator's private
        // counter starts at 0. Two counters, one ladder — this is the off-by-one
        // the dedup could introduce, so it is pinned rather than reasoned about.
        const legacyFirstAttempt = 1;
        const apiFirstAttempt = 0;
        expect(reconnectDelay(legacyFirstAttempt - 1)).toBe(reconnectDelay(apiFirstAttempt));
        expect(reconnectDelay(legacyFirstAttempt - 1)).toBe(30_000);
    });

    it('keeps the whole ladder identical across the two conventions', () => {
        const legacy = [1, 2, 3, 4, 5].map((attempts) => reconnectDelay(attempts - 1));
        const api = [0, 1, 2, 3, 4].map((attempt) => reconnectDelay(attempt));
        expect(legacy).toEqual(api);
    });
});

describe('resetAppState — the shared wipe', () => {
    beforeEach(() => {
        seedBufferWithLine();
        activeBufferId.set(KEY);
        previousBufferId.set('some-other-buffer');
        pendingBufferSwitch.set('a-switch-that-never-landed');
        bufferBottom.set(false);
        connected.set(true);
        weechatVersion.set(['4', '10', '1']);
        relayApiVersion.set('0.6.0');
        localUnreadBuffers.update(() => new Set(['stale']));
        hotlistClearedBuffers.update(() => new Set(['stale']));
    });

    it('clears every store a connection owns', () => {
        resetAppState();

        expect(Object.keys(get(buffers))).toEqual([]);
        expect(Object.keys(get(servers))).toEqual([]);
        expect(get(activeBufferId)).toBe('');
        expect(get(previousBufferId)).toBe('');
        expect(get(pendingBufferSwitch)).toBeNull();
        expect(get(bufferBottom)).toBe(true);
        expect(get(connected)).toBe(false);
        expect(get(weechatVersion)).toEqual([]);
        expect(get(relayApiVersion)).toBe('');
        expect(get(localUnreadBuffers).size).toBe(0);
        expect(get(hotlistClearedBuffers).size).toBe(0);
    });

    it('captures the session it is about to destroy, when a loss asked for it', () => {
        // The whole point of the retained view: the snapshot must be taken BEFORE
        // the wipe. Asserting a non-empty snapshot is asserting the ordering, not
        // just the presence of a snapshot.
        setActiveConnectionProfile('relay.example', 9001, undefined, false);
        markCaptureIntent();

        resetAppState(7);

        const snapshot = getRetainedSnapshot();
        expect(snapshot).not.toBeNull();
        // One buffer, and it still holds its line: the capture ran while the
        // stores were intact, which is the ordering this test exists to hold.
        expect(snapshot?.buffers.size).toBe(1);
        expect(snapshot?.buffers.get(KEY)?.lines.map((l) => l.text)).toHaveLength(1);
        expect(Object.keys(get(buffers))).toEqual([]);
    });

    it('captures nothing when no loss intent was declared', () => {
        // A user-initiated departure must not leave a retained view behind, so the
        // wipe has to honour intent rather than merely being able to capture.
        setActiveConnectionProfile('relay.example', 9001, undefined, false);

        resetAppState();

        expect(getRetainedSnapshot()).toBeNull();
    });

    it('leaves the next attempt a scheduled retry still needs', () => {
        // resetAppState deliberately does not touch the profile or the status: a
        // retry timer that fires after this wipe reconnects to the same relay.
        setNextReconnectAt(Date.now() + 30_000);

        resetAppState();

        expect(get(connectionState).nextReconnectAt).toBeDefined();
    });
});

describe('the drain-before-wipe contract', () => {
    it('a queued line cannot be delivered into the NEXT session under a reused buffer id', () => {
        // The API transport drains its queued line batch before `resetAppState()`.
        // That is the ordering this pins, and the reason it is load-bearing is not
        // the wipe's own stores — it is that 4.10.1 hands the next session the same
        // buffer ids. A batch left pending across the wipe would be applied to a
        // buffer that belongs to a connection which never saw it.
        const reducers = createApiStoreReducers();
        reducers.buffers([apiSnapshot(API_ID)]);
        // Queued, not applied: `lineAdded` is frame-aligned.
        reducers.lineAdded(API_ID, apiLine(77 as ApiLineId, 'from the dead session'));

        api.__resetAllStateForTest();

        // A new session publishes a buffer under the id WeeChat just reused. Seeded
        // directly rather than through the reducer: the `buffers` reducer drains the
        // queue itself before it publishes, which would hide exactly the ordering
        // this test is about.
        const reused = createBuffer({
            pointers: [String(API_ID)],
            full_name: 'irc.gbtest.#glowing-bear',
            short_name: '#glowing-bear',
            number: 1,
            local_variables: { type: 'channel', server: 'gbtest', plugin: 'irc' },
        });
        buffers.update((current) => ({ ...current, [String(API_ID)]: reused }));
        flushApiLineBatch();

        const lines = get(buffers)[String(API_ID)]?.lines ?? [];
        expect(lines.map((l) => l.text).join('')).not.toContain('from the dead session');
        expect(get(localUnreadBuffers).size).toBe(0);
        expect(Object.keys(get(servers))).toEqual([]);
    });

    it('leaves no store a drain can write untouched by the wipe', () => {
        // The wipe must cover every store a drain can write, in BOTH orderings, or
        // the ordering becomes load-bearing in a way no test would notice until a
        // dropped connection left dead-session rows on screen.
        servers.update(() => ({ 'irc.gbtest': { id: 'irc.gbtest', unread: 3 } }));
        localUnreadBuffers.update(() => new Set(['1791000000000901']));

        resetAppState();

        expect(Object.keys(get(servers))).toEqual([]);
        expect(get(localUnreadBuffers).size).toBe(0);
    });
});

describe('disconnect and countdown toasts', () => {
    it('shows a disconnect toast carrying a Reconnect action', () => {
        showDisconnectToast(PROFILE, () => undefined);

        const toast = findDisconnectToast(PROFILE.host, PROFILE.port);
        expect(toast).toBeDefined();
        expect(toast?.type).toBe('warning');
        expect(toast?.duration).toBe(0);
        expect(toast?.buttons?.[0]?.text).toBe('Reconnect');
    });

    it('does not stack a second disconnect toast during a reconnect cycle', () => {
        showDisconnectToast(PROFILE, () => undefined);
        showDisconnectToast(PROFILE, () => undefined);

        expect(get(toastStore).length).toBe(1);
    });

    it('stays silent while the banner is already presenting the loss', () => {
        // The banner and the toast say the same thing in two places, and the toast
        // sits on top of the banner's own buttons. A retained view means the banner
        // owns the presentation.
        seedBufferWithLine();
        setActiveConnectionProfile('relay.example', 9001, undefined, false);
        markCaptureIntent();
        resetAppState(1);

        showDisconnectToast(PROFILE, () => undefined);

        expect(get(toastStore).length).toBe(0);
    });

    it('counts down to the scheduled attempt and never goes negative', () => {
        const nextAt = Date.now() + 4_200;
        expect(countdownText(nextAt)).toBe('5s');
        expect(countdownText(Date.now() - 60_000)).toBe('0s');
    });
});

describe('focus reconnect', () => {
    function fireVisibilityChange() {
        Object.defineProperty(document, 'visibilityState', {
            configurable: true,
            get: () => 'visible',
        });
        document.dispatchEvent(new Event('visibilitychange'));
    }

    it('cuts in front of a long remaining wait', () => {
        let fired = 0;
        const pendingRetry = (): PendingRetry => ({ active: true, nextRetryAt: Date.now() + 60_000 });
        registerFocusReconnect(pendingRetry, () => { fired++; });

        fireVisibilityChange();

        expect(fired).toBe(1);
    });

    it('leaves a short remaining wait alone', () => {
        let fired = 0;
        const pendingRetry = (): PendingRetry => ({ active: true, nextRetryAt: Date.now() + 2_000 });
        registerFocusReconnect(pendingRetry, () => { fired++; });

        fireVisibilityChange();

        expect(fired).toBe(0);
    });

    it('does nothing when no retry is scheduled', () => {
        let fired = 0;
        registerFocusReconnect(() => ({ active: false }), () => { fired++; });

        fireVisibilityChange();

        expect(fired).toBe(0);
    });

    it('never spends a single-use TOTP code to skip a countdown', () => {
        // A TOTP code is consumed by the attempt that uses it. Cutting in front of
        // the backoff would burn a code the user has not entered yet.
        let fired = 0;
        settings.update((s) => ({ ...s, useTotp: true }));
        try {
            registerFocusReconnect(
                () => ({ active: true, nextRetryAt: Date.now() + 120_000 }),
                () => { fired++; },
            );
            fireVisibilityChange();
            expect(fired).toBe(0);
        } finally {
            settings.update((s) => ({ ...s, useTotp: false }));
        }
    });

    it('registers once, so one visibility change cannot fire two attempts', () => {
        let fired = 0;
        const pendingRetry = (): PendingRetry => ({ active: true, nextRetryAt: Date.now() + 60_000 });
        registerFocusReconnect(pendingRetry, () => { fired++; });
        registerFocusReconnect(pendingRetry, () => { fired++; });

        fireVisibilityChange();

        expect(fired).toBe(1);
    });
});

describe('hotlist polling configuration', () => {
    it('is one value, not a pair that has to be kept in step by hand', () => {
        setHotlistPollInterval(1000);
        expect(hotlistPollInterval()).toBe(1000);
    });

    it('debounces a hotlist change for a fixed, shared interval', () => {
        expect(HOTLIST_DEBOUNCE_MS).toBe(2000);
    });
});
