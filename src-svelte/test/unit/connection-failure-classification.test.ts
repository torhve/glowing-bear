/**
 * Which flag a connection failure becomes.
 *
 * The messages below are the exact `{"error":"…"}` bodies a live relay answers,
 * as recorded in test/fixtures/api-dossier/README.md, plus this client's own
 * failure strings. The load-bearing case is the timestamp one: a hashed
 * credential is a 401 failure like a wrong password is, so a clock that is
 * merely wrong used to fall through to "the relay could not be reached" — a
 * message that sends the user to a credential and a network path that are both
 * fine.
 */
import { describe, expect, it } from 'vitest';
import { classifyConnectionFailure, hasNamedConnectionError } from '#lib/utils/connectionFailure.ts';

const noErrors = {
    passwordError: false, tlsError: false, securityError: false, oldWeechatError: false,
    hashAlgorithmDisagree: false, clockSkewError: false, errorMessage: false,
    uploadError: false, serverUnreachable: false,
};

describe('classifyConnectionFailure', () => {
    it('names the relay timestamp rejection as clock skew, not as a password or a network fault', () => {
        const named = classifyConnectionFailure('Invalid timestamp', true);
        expect(named).toEqual({ clockSkewError: true });
        expect(named?.passwordError, 'the credential may be perfectly correct').toBeUndefined();
        expect(named?.serverUnreachable, 'the relay answered the request; it is reachable').toBeUndefined();
    });

    it('names it the same way while a retry loop is still running', () => {
        // Retrying cannot fix it: every attempt stamps the same wrong time, so
        // this has to be said even while attempts keep going.
        expect(classifyConnectionFailure('Invalid timestamp', false)).toEqual({ clockSkewError: true });
    });

    it('keeps a wrong password a password error', () => {
        expect(classifyConnectionFailure('Invalid password', true)).toEqual({ passwordError: true });
    });

    it('keeps a too-old relay and a TOTP relay named as they were', () => {
        expect(classifyConnectionFailure('WeeChat Relay API 0.5.0 is too old', true)).toEqual({ oldWeechatError: true });
        expect(classifyConnectionFailure('This WeeChat requires TOTP, which the browser client cannot provide', true))
            .toEqual({ errorMessage: true });
    });

    it('reports a transport-level failure only once the retry loop has stopped', () => {
        const closed = 'connection closed (code 1006)';
        expect(classifyConnectionFailure(closed, true), 'a stopped loop has nothing else to say').toEqual({ serverUnreachable: true });
        expect(classifyConnectionFailure(closed, false), 'a live loop says "Connection lost. Retrying…"').toBeNull();
    });

    it('leaves the caller with nothing to overwrite when there is no cause to name', () => {
        expect(classifyConnectionFailure('session closed', false)).toBeNull();
    });
});

describe('hasNamedConnectionError', () => {
    it('is true for a named clock skew', () => {
        expect(hasNamedConnectionError({ ...noErrors, clockSkewError: true })).toBe(true);
    });

    it('is false when only the generic flag is set', () => {
        // The form's own fallback message must still appear when no transport
        // named anything.
        expect(hasNamedConnectionError({ ...noErrors, errorMessage: true })).toBe(false);
        expect(hasNamedConnectionError(noErrors)).toBe(false);
    });
});
