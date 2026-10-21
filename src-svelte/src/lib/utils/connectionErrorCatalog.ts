/**
 * The causes a connection attempt can name, and what the banner says for each.
 *
 * `ConnectionError` is ten flags, and the banner used to hold ten hand-written
 * early returns over them. That ordering is the whole design — a wrong password and
 * a wrong clock are worth naming, a generic protocol error is not — so the order is
 * recorded as data here and read once by `connectionPresentation.reasonFor()`.
 *
 * What this module deliberately does NOT own is the connection form. The form has
 * room for several explanations, so it shows every flag it has, in its own order,
 * with longer sentences and two of them as structured markup with recovery buttons.
 * Sharing one table across both surfaces would either shorten the form or lengthen
 * the banner; instead `BANNER_ONLY_ERROR_FLAGS` states the split, and a test holds
 * the form to it.
 *
 * Sentences are the user-visible text, pinned by `connection-banner-model.test.ts`
 * one by one, including which one is said when several flags arrive together.
 */
import type { ConnectionError } from '#lib/types.ts';

export type ConnectionErrorFlag = keyof ConnectionError;

export interface ConnectionErrorBannerRow {
    flag: ConnectionErrorFlag;
    /** One line, no markup: the banner is a single sentence beside a countdown. */
    reason: string;
}

/**
 * Every flag, in the order the banner names them: most actionable fix first.
 *
 * The list is asserted complete and duplicate-free by
 * `connection-error-catalog.test.ts`, which compares it against a real
 * `ConnectionError` object — a new flag with no row here is a failing test, not a
 * cause the banner stays silent about.
 */
export const CONNECTION_ERROR_BANNERS = [
    { flag: 'passwordError', reason: 'WeeChat rejected the password.' },
    { flag: 'hashAlgorithmDisagree', reason: 'WeeChat and the browser disagree on how to hash the password.' },
    // The long explanation is on the connection form; the banner only has room to
    // say which of the two clocks to go and fix, and that retrying will not help.
    { flag: 'clockSkewError', reason: 'WeeChat rejected the login timestamp — this device and the server disagree about the time.' },
    { flag: 'tlsError', reason: 'The TLS connection failed.' },
    { flag: 'securityError', reason: 'WeeChat refused the connection for security reasons.' },
    { flag: 'oldWeechatError', reason: 'This WeeChat is too old for the API transport.' },
    // Only ever set for an attempt that never established a session, so this is
    // never said about a session that was lost — that is a transport loss, and the
    // transport was already proved by the session it held.
    { flag: 'protocolUnansweredError', reason: 'Nothing on this port answered as the relay protocol you selected.' },
    { flag: 'serverUnreachable', reason: 'The relay could not be reached.' },
    { flag: 'uploadError', reason: 'WeeChat rejected the initialization data.' },
    { flag: 'errorMessage', reason: 'WeeChat reported an error.' },
] as const satisfies readonly ConnectionErrorBannerRow[];

/**
 * Causes the banner names and the connection form does not box.
 *
 * Both are explained where they happen and neither has a fix a reader can take from
 * the connection form, so the form stays silent. The list exists so that a new flag
 * forces a decision: add a row here if the form should not explain it, or leave it
 * out and a test fails until the form has a box for it.
 */
export const BANNER_ONLY_ERROR_FLAGS = ['securityError', 'uploadError'] as const satisfies readonly ConnectionErrorFlag[];
