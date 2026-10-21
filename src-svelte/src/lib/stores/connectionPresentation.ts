/**
 * What the connection banner says, derived from transport state — never written
 * by a transport.
 *
 * The banner is a *presentation* of the retry loop, not a second owner of it. It
 * reads the same stores the transports publish and the same classifier the
 * facade's Retry command uses, so the button and the model cannot disagree about
 * whether a retry is available.
 *
 * Note what is absent: there is no "attempts exhausted" state. Both transports
 * retry indefinitely on one shared ladder — `RECONNECT_BACKOFF` in
 * `connectionLifecycle.ts` grows the delay by 1.5× from 30 s and caps it at
 * 300 s — so a stalled session is never a finished one. Showing "attempt 3 of
 * 10" would invent a limit the code does not have, so the banner reports the
 * attempt count and the next attempt time, which are both real.
 */

import { derived, type Readable } from 'svelte/store';
import { connectionState, type ConnectionState } from '#lib/stores/connectionStore.ts';
import { retainedSnapshot } from '#lib/stores/retainedChat.ts';
import { activeConnectionProfile } from '#lib/connectionProfile.ts';
import { settings } from '#lib/stores/settings.ts';
import { retryAvailability } from '#lib/stores/connectionManager.ts';
import type { ConnectionError } from '#lib/types.ts';
import { CONNECTION_ERROR_BANNERS } from '#lib/utils/connectionErrorCatalog.ts';

export type BannerKind =
    /** Nothing to say: connected, or the connection form is on screen. */
    | 'none'
    /** A retry loop is live — an attempt in flight, or one scheduled. */
    | 'reconnecting'
    /** The loop stopped because it needs a credential only the user can supply. */
    | 'needs-credentials'
    /** Read-only retained chat with no retry loop running (autoconnect off). */
    | 'retained';

export interface ConnectionBannerModel {
    kind: BannerKind;
    /** Whether the chat shell is on screen instead of the connection form.
     *  Page-level layout (overflow locking, TopBar presence) keys off this rather
     *  than off `$connected`, so a retained view keeps the layout it had. */
    shellVisible: boolean;
    /** True when what is on screen is a retained snapshot rather than live data. */
    retained: boolean;
    /** Human-readable reason. Stale state must be legible as text, not colour. */
    reason: string;
    /** Attempts made in this retry loop. 0 when no loop has run. */
    attempt: number;
    /** Epoch ms of the next scheduled attempt, or null while one is in flight or
     *  no attempt is scheduled. */
    nextRetryAt: number | null;
    /** A handshake is currently in flight. */
    attemptInFlight: boolean;
    /** A Retry now command would be accepted by the facade. */
    canRetry: boolean;
}

/**
 * One sentence for a failure: the first named cause, else the status itself. Which
 * causes exist and in what precedence they are named lives in
 * `connectionErrorCatalog`, alongside the list of causes the connection form boxes
 * instead of the banner naming.
 */
function reasonFor(errors: ConnectionError, status: ConnectionState['status']): string {
    for (const row of CONNECTION_ERROR_BANNERS) {
        if (errors[row.flag]) return row.reason;
    }
    if (status === 'connecting') return 'Connecting…';
    if (status === 'reconnecting') return 'Connection lost. Retrying…';
    return 'Connection lost.';
}

export const connectionBanner: Readable<ConnectionBannerModel> = derived(
    // activeTransport is deliberately absent: every transport-selection change is
    // accompanied by a connectionState write, so the loop already re-derives. A
    // dependency nothing reads would only make the recompute look mysterious.
    [connectionState, retainedSnapshot, activeConnectionProfile, settings],
    ([$connectionState, $snapshot, $profile, $settings]): ConnectionBannerModel => {
        const status = $connectionState.status;
        const connected = status === 'connected';

        // A snapshot belonging to a different relay is never a reason to keep the
        // shell: the user is looking at another server's chat.
        const retained =
            !$snapshot || connected ? false : $snapshot.profileKey === $profile?.key;

        const shellVisible = connected || retained;

        if (!shellVisible || connected) {
            return {
                kind: 'none',
                shellVisible,
                retained: false,
                reason: '',
                attempt: $connectionState.reconnectAttempts,
                nextRetryAt: null,
                attemptInFlight: status === 'connecting',
                canRetry: false,
            };
        }

        // Same classifier the Retry command itself uses, so a disabled button and
        // a refused command are the same decision made once.
        const availability = retryAvailability();

        // Read from the reactive store rather than trusting retryAvailability()'s
        // own get(settings): the derived must re-run when the user toggles TOTP while
        // a retained view is on screen, and a non-reactive read would not ask it to.
        const needsCredentials = $settings.useTotp || availability === 'needs-credentials';
        // Either the transport says a handshake is flying, or the status says the
        // same thing. Either is enough to disable the button for this tick.
        const attemptInFlight = status === 'connecting' || availability === 'in-progress';
        const looping = status === 'connecting' || status === 'reconnecting';

        let kind: BannerKind;
        if (needsCredentials) kind = 'needs-credentials';
        else if (looping) kind = 'reconnecting';
        else kind = 'retained';

        return {
            kind,
            shellVisible,
            retained,
            reason: needsCredentials
                ? 'WeeChat requires a verification code. Enter it to reconnect.'
                : reasonFor($connectionState.errors, status),
            attempt: $connectionState.reconnectAttempts,
            nextRetryAt: looping && !attemptInFlight ? $connectionState.nextReconnectAt ?? null : null,
            attemptInFlight,
            canRetry: availability === 'available',
        };
    },
);
