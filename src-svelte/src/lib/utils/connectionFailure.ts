// Why a connection attempt failed, in one flag the UI can explain.
//
// Pure on purpose: a transport classifies, publishes the flag to connectionState,
// and presentation reads it. Keeping the decision in its own module means the
// classification is provable by a unit test without a transport, a socket, or a
// store graph.
//
// The strings are the live-verified relay error bodies recorded in
// test/fixtures/api-dossier/README.md — "Invalid password", "Invalid timestamp",
// "Invalid hash algorithm" — plus this client's own version-gate message.

import type { ConnectionError } from '#lib/types.ts';

/**
 * Map one failure message to the flag that names it, or null when there is
 * nothing to name.
 *
 * Order matters more than it looks: every hashed credential is a 401 failure, so
 * the timestamp case has to be read before the password case — otherwise a clock
 * that is merely wrong is reported as a wrong password, and the user goes off to
 * change a credential that was fine.
 *
 * `nameTransient` decides what a transport-level failure ("connection closed", a
 * timeout) becomes: false while a retry loop is live, because "Connection lost.
 * Retrying…" is the honest sentence and inventing a cause would be a guess; true
 * when the loop has stopped, because "the relay could not be reached" is the only
 * thing left to say. A failure a retry cannot fix is named either way — that is
 * the point of naming it.
 *
 * A null return means the caller must leave the existing flags alone rather than
 * overwrite them with a guess.
 */
export function classifyConnectionFailure(
    message: string,
    nameTransient: boolean,
): Partial<ConnectionError> | null {
    if (/invalid timestamp/i.test(message)) return { clockSkewError: true };
    if (/password|401|authenticat/i.test(message)) return { passwordError: true };
    if (/too old|Relay API/i.test(message)) return { oldWeechatError: true };
    if (/TOTP/i.test(message)) return { errorMessage: true };
    return nameTransient ? { serverUnreachable: true } : null;
}

/**
 * True when a flag already explains the failure.
 *
 * Presentation uses this to avoid stacking a generic "the client was unable to
 * connect" on top of a cause that has already been named — two explanations, one
 * of them false, is worse than one.
 */
export function hasNamedConnectionError(errors: ConnectionError): boolean {
    return errors.passwordError
        || errors.tlsError
        || errors.securityError
        || errors.oldWeechatError
        || errors.hashAlgorithmDisagree
        || errors.clockSkewError
        || errors.uploadError
        || errors.serverUnreachable;
}
