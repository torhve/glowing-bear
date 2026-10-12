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
import { connectionState, setNextReconnectAt } from '#lib/stores/connectionStore.ts';
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
        nameFailure: () => calls.push('nameFailure'),
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
        connectionState.update((s) => ({ ...s, wasEverConnected: true, userDisconnect: false }));
        settings.update((s) => ({ ...s, autoconnect: true }));
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
        expect(calls).toEqual(['nameFailure', 'wipe', 'open']);
    });

    it('names the failure and wipes before opening the next attempt', () => {
        // The order is the one both transports had: explain the failure, close the
        // session's state, then try again. Reordering the wipe after the open would
        // destroy the buffers the new attempt has just published.
        const { attempt, calls } = attemptSpy();
        scheduleRetry(attempt, () => undefined);
        expect(calls).toEqual(['nameFailure', 'wipe']);
        vi.advanceTimersByTime(30_000);
        expect(calls).toEqual(['nameFailure', 'wipe', 'open']);
    });

    it('declares a retry pending in the same step that arms it', () => {
        scheduleRetry(attemptSpy().attempt, () => undefined);
        // Before any timer runs: the banner derives "Retrying…" and its countdown
        // from this status, so writing it later is what hid the legacy backoff.
        expect(get(connectionState).status).toBe('reconnecting');
        expect(pendingRetryState()).toMatchObject({ active: true });
    });

    it('does not schedule anything when autoconnect is off', () => {
        settings.update((s) => ({ ...s, autoconnect: false }));
        const { attempt, calls } = attemptSpy();
        const scheduled = scheduleRetry(attempt, () => undefined);

        expect(scheduled).toBe(false);
        expect(calls).toEqual([]);
        expect(pendingRetryState().active).toBe(false);
        vi.advanceTimersByTime(120_000);
        expect(calls).toEqual([]);
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
        expect(first.calls).toEqual(['nameFailure', 'wipe']);
        expect(second.calls).toEqual(['nameFailure', 'wipe', 'open']);
    });

    it('cancels a pending attempt without wiping or opening anything', () => {
        const { attempt, calls } = attemptSpy();
        scheduleRetry(attempt, () => undefined);
        cancelPendingRetry();

        expect(pendingRetryState().active).toBe(false);
        vi.advanceTimersByTime(120_000);
        expect(calls).toEqual(['nameFailure', 'wipe']);
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
