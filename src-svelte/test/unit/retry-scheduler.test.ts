/**
 * The shared retry scheduler.
 *
 * The ladder is the part that must not drift. Legacy counted attempts from 1 and
 * passed `reconnectDelay(attempts - 1)`; the API orchestrator counted from 0 and
 * passed `reconnectDelay(attempt)`. Both produced 30 s first, so an off-by-one in
 * the unification would not show up on the first retry — it would silently shift
 * every later interval by one step. These tests pin the whole sequence.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { clearErrors, connectionState, setNextReconnectAt } from '#lib/stores/connectionStore.ts';
import { settings } from '#lib/stores/settings.ts';
import { clearToasts, toastStore } from '#lib/toast.ts';
import { clearCaptureIntent, hasCaptureIntent } from '#lib/stores/retainedChat.ts';
import {
    cancelPendingRetry,
    pendingRetryState,
    restartRetryLadder,
    retryAttemptNumber,
    scheduleRetry,
    type RetryAttempt,
} from '#lib/stores/connectionLifecycle.ts';
import type { ConnectionProfile } from '#lib/stores/connectionLifecycle.ts';

const PROFILE: ConnectionProfile = {
    host: 'relay.example',
    port: 9001,
    path: 'weechat',
    password: 'testpassword123',
    tls: false,
    noCompression: true,
};

function attemptSpy() {
    const calls: string[] = [];
    const attempt: RetryAttempt = {
        profile: PROFILE,
        error: 'connection closed (code 1006)',
        wipe: () => calls.push('wipe'),
        open: () => calls.push('open'),
    };
    return { attempt, calls };
}

describe('the shared retry scheduler', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        restartRetryLadder();
        setNextReconnectAt(undefined);
        clearToasts();
        clearCaptureIntent();
        clearErrors();
        connectionState.update((s) => ({ ...s, wasEverConnected: true, userDisconnect: false }));
        // Reset both gates: a leaked useTotp from the veto test would send every
        // later schedule down the terminal path and look like a ladder bug.
        settings.update((s) => ({ ...s, autoconnect: true, useTotp: false }));
    });

    afterEach(() => {
        cancelPendingRetry();
        clearToasts();
        vi.useRealTimers();
    });

    it('walks 30s -> 45s -> 67.5s -> 101.25s and caps at 300s', () => {
        // 227812.5 is not a rounding error: 30000 * 1.5^5 is genuinely fractional,
        // and the countdown rounds it up for display.
        const expected = [30_000, 45_000, 67_500, 101_250, 151_875, 227_812.5, 300_000, 300_000];
        const seen: number[] = [];

        for (let i = 0; i < expected.length; i++) {
            const { attempt } = attemptSpy();
            scheduleRetry(attempt, () => undefined);
            const next = get(connectionState).nextReconnectAt;
            seen.push(next ? next - Date.now() : -1);
            // Fire the armed attempt so the next schedule counts the next step.
            vi.advanceTimersByTime(expected[i] + 10);
        }

        expect(seen).toEqual(expected);
    });

    it('arms exactly one attempt per failure, in order', () => {
        const { attempt, calls } = attemptSpy();
        scheduleRetry(attempt, () => undefined);
        vi.advanceTimersByTime(30_000);
        expect(calls).toEqual(['wipe', 'open']);
    });

    it('wipes before opening the next attempt', () => {
        // Reordering the wipe after the open would destroy the buffers the new
        // attempt has just published.
        const { attempt, calls } = attemptSpy();
        scheduleRetry(attempt, () => undefined);
        expect(calls).toEqual(['wipe']);
        vi.advanceTimersByTime(30_000);
        expect(calls).toEqual(['wipe', 'open']);
    });

    it('does not invent a cause while a retry is live', () => {
        // "Connection closed" is a transport-level failure. While the loop is
        // running, the honest sentence is "Connection lost. Retrying…" and naming
        // the transient cause here would put a guess on screen beside it.
        scheduleRetry(attemptSpy().attempt, () => undefined);
        expect(get(connectionState).errors.serverUnreachable).toBeFalsy();
    });

    it('declares a retry pending in the same step that arms it', () => {
        scheduleRetry(attemptSpy().attempt, () => undefined);
        // Before any timer runs: the banner derives "Retrying…" and its countdown
        // from this status, so writing it later is what hid the legacy backoff.
        expect(get(connectionState).status).toBe('reconnecting');
        expect(pendingRetryState()).toMatchObject({ active: true });
    });

    it('declares the loss terminal when autoconnect is off', () => {
        settings.update((s) => ({ ...s, autoconnect: false }));
        const { attempt, calls } = attemptSpy();
        const scheduled = scheduleRetry(attempt, () => undefined);

        expect(scheduled).toBe(false);
        expect(pendingRetryState().active).toBe(false);
        vi.advanceTimersByTime(120_000);
        // Nothing was armed, so nothing opens. What it did do is close the session:
        // a loss that will not be retried must not leave the stores describing a
        // live connection.
        expect(calls).toEqual(['wipe']);
        expect(get(connectionState).status).toBe('error');
    });

    it('names the cause once the loop has stopped', () => {
        // The same message that must NOT be named while a retry is live. With the
        // loop gone, "the relay could not be reached" is the only thing left to
        // say — and it is what the API transport already said while legacy left
        // the banner reading the generic "Connection lost.".
        settings.update((s) => ({ ...s, autoconnect: false }));
        scheduleRetry(attemptSpy().attempt, () => undefined);
        expect(get(connectionState).errors.serverUnreachable).toBe(true);
    });

    it('refuses an automatic retry when the relay needs a verification code', () => {
        // A TOTP code is single-use on both relays — the legacy handshake feeds it
        // into the password hash too — so an automatic retry would present a spent
        // credential and fail. The manual path already refuses it via
        // retryAvailability(); the automatic path must not be more optimistic.
        // This used to be two separate guards, one per transport, and only the API
        // one produced a named terminal failure.
        settings.update((s) => ({ ...s, useTotp: true }));
        const { attempt, calls } = attemptSpy();
        const scheduled = scheduleRetry(attempt, () => undefined);

        expect(scheduled).toBe(false);
        vi.advanceTimersByTime(120_000);
        expect(calls).toEqual(['wipe']);
        expect(get(connectionState).status).toBe('error');
    });

    it('replaces a pending attempt instead of stacking a second one beside it', () => {
        const first = attemptSpy();
        const second = attemptSpy();
        scheduleRetry(first.attempt, () => undefined);
        scheduleRetry(second.attempt, () => undefined);

        // The replacement also moved the ladder on, so this attempt is due at the
        // second step, not the first.
        vi.advanceTimersByTime(45_000);
        // The first schedule did its synchronous work when it was called; what the
        // second schedule replaced is its attempt, not its effects. Only one `open`
        // runs, and it is the second one's.
        expect(first.calls).toEqual(['wipe']);
        expect(second.calls).toEqual(['wipe', 'open']);
    });

    it('cancels a pending attempt without wiping or opening anything', () => {
        const { attempt, calls } = attemptSpy();
        scheduleRetry(attempt, () => undefined);
        cancelPendingRetry();

        expect(pendingRetryState().active).toBe(false);
        vi.advanceTimersByTime(120_000);
        expect(calls).toEqual(['wipe']);
    });

    it('counts the ladder from the beginning only when told to', () => {
        expect(retryAttemptNumber()).toBe(0);
        scheduleRetry(attemptSpy().attempt, () => undefined);
        expect(retryAttemptNumber()).toBe(1);

        restartRetryLadder();
        expect(retryAttemptNumber()).toBe(0);
    });

    it('marks capture intent for a session that had a bootstrap to retain', () => {
        // A loss before the first successful bootstrap has nothing to retain; a
        // loss after one must keep the window the reader was looking at.
        connectionState.update((s) => ({ ...s, wasEverConnected: true }));
        scheduleRetry(attemptSpy().attempt, () => undefined);
        expect(hasCaptureIntent()).toBe(true);
    });

    it('shows the countdown toast, which is the only presentation when no banner is up', () => {
        scheduleRetry(attemptSpy().attempt, () => undefined);
        const messages = get(toastStore).map((t) => t.message);
        expect(messages.some((m) => m?.includes('Disconnected from'))).toBe(true);
    });
});
