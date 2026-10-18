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

import type { ConnectionError, ProtocolPreference } from '#lib/types.ts';

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
 * Whether a failed attempt leaves the user's protocol pin as the thing worth
 * questioning.
 *
 * A pin means "do not probe — connect as api / as legacy". The only evidence
 * that the pinned protocol is the one this port speaks is an answer that
 * protocol alone can produce: a rejected credential, a rejected login
 * timestamp, a hash-algorithm refusal, a version gate, rejected initialization
 * data. Each of those arrives as a parsed reply on the pinned transport (the
 * live bodies are recorded in test/fixtures/api-dossier/), so when any of them
 * is set the pin is proven and the failure lies elsewhere — in the password,
 * the clock, or the relay's version.
 *
 * A failure with no such answer is one the app cannot explain: nothing replied
 * to the API handshake, or the WebSocket upgrade never completed. That is the
 * case worth naming, because the pin is the one variable the user can change.
 *
 * `tlsError` and `securityError` suppress the claim for a different reason: a
 * TLS or origin failure happens before either protocol is spoken, so it proves
 * nothing about the pin and is already its own explanation. (Neither flag is
 * currently set by either transport.)
 */
export function pinIsUnverified(
    preference: ProtocolPreference,
    errors: ConnectionError,
): boolean {
    if (preference === 'auto') return false;
    return !(
        errors.passwordError
        || errors.clockSkewError
        || errors.hashAlgorithmDisagree
        || errors.oldWeechatError
        || errors.uploadError
        || errors.errorMessage
        || errors.tlsError
        || errors.securityError
    );
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
        || errors.serverUnreachable
        || errors.protocolUnansweredError;
}
