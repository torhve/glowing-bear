import { pbkdf2Sync } from 'crypto';

/**
 * Availability probe for the optional second relay fixture (test/fixtures/gbtest5).
 *
 * The main gbtest fixture is pinned to WeeChat 4.10.1 / relay API 0.6.0, which is
 * the contract the app was written against. That also means every contract change
 * a NEWER relay makes is invisible to the suite until a user hits it — which is
 * exactly how the 5.0 `date_printed` removal turned into "the chat is empty".
 *
 * This fixture is optional by design: a machine without a WeeChat 5 build must
 * still run the whole suite. So specs ask here and skip, rather than failing.
 */

export const WEECHAT5_RELAY_PORT = 9011;
const GBTEST_PASSWORD = 'testpassword123';

export interface Weechat5RelayInfo {
    weechatVersion: string;
    relayApiVersion: string;
}

/**
 * Returns the relay's reported versions, or null when no WeeChat 5 relay is
 * answering. The probe authenticates (same PBKDF2 scheme as gbtest) so an open
 * port belonging to something else is not mistaken for the fixture, and it
 * requires a 5.x WeeChat so a 4.10.1 instance can never satisfy a test that
 * claims to verify 5.0 behaviour.
 */
export async function weechat5RelayInfo(port = WEECHAT5_RELAY_PORT): Promise<Weechat5RelayInfo | null> {
    try {
        const ts = Math.floor(Date.now() / 1000);
        const iterations = 100000;
        const hash = pbkdf2Sync(GBTEST_PASSWORD, String(ts), iterations, 32, 'sha256').toString('hex');
        const cred = Buffer.from(`hash:pbkdf2+sha256:${ts}:${iterations}:${hash}`).toString('base64');
        const res = await fetch(`http://127.0.0.1:${port}/api/version`, {
            headers: { Authorization: 'Basic ' + cred },
            signal: AbortSignal.timeout(4000),
        });
        if (!res.ok) return null;
        const body = await res.json() as { weechat_version?: string; relay_api_version?: string };
        if (typeof body.weechat_version !== 'string' || typeof body.relay_api_version !== 'string') return null;
        if (!/^5\./.test(body.weechat_version)) return null;
        return { weechatVersion: body.weechat_version, relayApiVersion: body.relay_api_version };
    } catch {
        return null;
    }
}
