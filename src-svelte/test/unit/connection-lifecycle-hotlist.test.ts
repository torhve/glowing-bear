/**
 * The shared hotlist poll and the shared manual-reconnect preamble.
 *
 * Both used to exist once per transport. The interesting failure mode is not the
 * duplication, it is what a duplicated timer does when its transport is replaced
 * rather than disconnected: `quiesce()` bumps the connection generation so the old
 * socket's `onclose` returns early, and that early return skips the `resetAllState`
 * that used to clear the timers. The poll therefore kept running against a relay the
 * user had left. These tests pin the ownership, and the last one pins the fix.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { settings } from '#lib/stores/settings.ts';
import { addToast, clearToasts, toastStore } from '#lib/toast.ts';
import { connectionState, setNextReconnectAt } from '#lib/stores/connectionStore.ts';
import {
    beginManualReconnect,
    debounceHotlistQuery,
    setHotlistPollInterval,
    showDisconnectToast,
    startHotlistPoll,
    stopHotlistPoll,
    transportAdapterFor,
    type ConnectionProfile,
} from '#lib/stores/connectionLifecycle.ts';
// Registers the REAL adapters. This file deliberately uses no adapter stubs: the
// claim under test is that a transport's own quiesce() stops the shared poll.
import '#lib/stores/connectionManager.ts';

const PROFILE: ConnectionProfile = {
    host: 'relay.example',
    port: 9001,
    path: 'weechat',
    password: 'testpassword123',
    tls: false,
    noCompression: true,
};

describe('the shared hotlist poll', () => {
    let polls = 0;
    const poll = () => { polls += 1; };

    beforeEach(() => {
        vi.useFakeTimers();
        polls = 0;
        setHotlistPollInterval(15_000);
        settings.update((s) => ({ ...s, hotlistsync: true }));
    });

    afterEach(() => {
        // A poll armed by one test would run into the next one.
        stopHotlistPoll();
        vi.useRealTimers();
    });

    it('is armed once and fires on the configured interval', () => {
        startHotlistPoll(poll);
        vi.advanceTimersByTime(45_000);
        expect(polls).toBe(3);
    });

    it('honours the hotlistsync setting, which only one transport used to do', () => {
        // The legacy transport gated its poll on `hotlistsync`; the API transport
        // polled unconditionally, so switching the setting off only ever worked
        // against one of the two relays.
        settings.update((s) => ({ ...s, hotlistsync: false }));
        startHotlistPoll(poll);
        vi.advanceTimersByTime(60_000);
        expect(polls).toBe(0);
    });

    it('re-arms a live poll when the interval changes, instead of waiting for a reconnect', () => {
        startHotlistPoll(poll);
        vi.advanceTimersByTime(15_000);
        expect(polls).toBe(1);

        setHotlistPollInterval(5_000);
        vi.advanceTimersByTime(5_000);
        // A running interval keeps the period it was armed with, so without an
        // explicit re-arm this stays 1 and the new value only applies next session.
        expect(polls).toBe(2);
    });

    it('stops when told to, and drops a coalesced query that was still waiting', () => {
        startHotlistPoll(poll);
        debounceHotlistQuery(poll);

        stopHotlistPoll();

        // Neither the interval nor the query that was already coalesced survives
        // the stop: a hotlist query that lands after the transport is gone
        // answers about a relay the user has left.
        vi.advanceTimersByTime(120_000);
        expect(polls).toBe(0);
    });

    it('cannot outlive the transport that armed it', () => {
        // The leak this ownership exists to close. Replacing a transport quiesces
        // it, and quiescing bumps the connection generation so the old socket's
        // onclose returns early — skipping the resetAllState() that used to clear
        // the poll. Removing stopHotlistPoll() from the transport's quiesce()
        // makes this fail.
        startHotlistPoll(poll);
        vi.advanceTimersByTime(15_000);
        expect(polls).toBe(1);

        const adapter = transportAdapterFor('api');
        expect(adapter, 'the real API adapter should be registered').toBeDefined();
        adapter!.quiesce();

        vi.advanceTimersByTime(120_000);
        expect(polls).toBe(1);
    });
});

describe('the shared manual-reconnect preamble', () => {
    beforeEach(() => {
        clearToasts();
        connectionState.update((s) => ({ ...s, userDisconnect: false }));
        setNextReconnectAt(Date.now() + 30_000);
    });

    afterEach(() => {
        clearToasts();
        setNextReconnectAt(undefined);
    });

    it('removes the disconnect toast, not whatever toast happens to be last', () => {
        // Both transports used to remove `toasts[toasts.length - 1]`. That is the
        // countdown toast only when nothing else arrived after it; an unrelated
        // toast would be dismissed by a reconnect click.
        showDisconnectToast(PROFILE, () => undefined);
        addToast('Copied to clipboard', { type: 'info', duration: 4000 });

        beginManualReconnect(PROFILE, false);

        const messages = get(toastStore).map((t) => t.message);
        expect(messages).toContain('Copied to clipboard');
        expect(messages.some((m) => m?.includes('Disconnected from'))).toBe(false);
    });

    it('stops advertising the attempt it is replacing', () => {
        beginManualReconnect(PROFILE, false);
        expect(get(connectionState).nextReconnectAt).toBeUndefined();
    });

    it('restarts the ladder only when asked to', () => {
        connectionState.update((s) => ({ ...s, reconnectAttempts: 4 }));
        beginManualReconnect(PROFILE, false);
        expect(get(connectionState).reconnectAttempts).toBe(4);

        beginManualReconnect(PROFILE, true);
        expect(get(connectionState).reconnectAttempts).toBe(0);
    });
});
