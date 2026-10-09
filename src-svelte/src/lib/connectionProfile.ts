// Canonical identity of the relay a connection targets.
//
// Per-conversation state has to be keyed by the endpoint the user actually
// connected to. Two existing keys look tempting and are both wrong for this:
//
//   - `connectionManager`'s transport cache key is `host:port:tls` on purpose —
//     it caches which protocol speaks on an address, and two reverse-proxy paths
//     on one address are different relays that must not share a draft namespace.
//   - the settings store is editable while disconnected, so keying on it would
//     repoint the composer's drafts at a relay that is not connected.
//
// Normalization is delegated to `resolveApiEndpoint()`: it is the parser the API
// transport already uses to build its URLs, so a host typed with a scheme, a
// bare IPv6 literal, a proxy prefix with stray slashes, and a prefix that
// already ends in `api` all resolve to the same identity as their canonical
// spelling. The legacy transport builds `proto://[host]:port/path` from the
// same arguments, so one canonicalizer describes both transports.
//
// The password is deliberately not part of this identity: it is a credential,
// not an endpoint, and must never reach a storage key or a diagnostic.

import { get, writable } from 'svelte/store';
import { resolveApiEndpoint } from '#lib/api/api-endpoint.ts';

export interface ConnectionProfile {
    /** Canonical endpoint identity — `scheme://host:port[/prefix]`. */
    readonly key: string;
    readonly host: string;
    readonly port: number;
    readonly tls: boolean;
    /** Normalized proxy prefix: `''` or `seg/seg`. Never carries a trailing `api`. */
    readonly prefix: string;
}

/**
 * Build the identity for a set of connection arguments.
 *
 * Returns null when the arguments do not describe an endpoint (an empty host, an
 * out-of-range port) rather than inventing a placeholder key: callers then leave
 * per-conversation state unkeyed instead of filing it under a bogus relay.
 */
export function connectionProfile(
    host: string,
    port: number | string,
    path: string | undefined,
    tls: boolean,
): ConnectionProfile | null {
    if (!host || !host.trim()) return null;
    let endpoint;
    try {
        endpoint = resolveApiEndpoint({ host, port, tls, path: path || undefined });
    } catch {
        // resolveApiEndpoint throws on an invalid port — that is not an endpoint.
        return null;
    }
    const url = new URL(endpoint.httpBase);
    return {
        key: endpoint.httpBase,
        host: url.hostname,
        port: Number(url.port) || (tls ? 443 : 80),
        tls,
        prefix: url.pathname === '/' ? '' : url.pathname.slice(1),
    };
}

/**
 * The profile the current connection targets, or null while disconnected.
 *
 * Captured from the arguments of the connection attempt by `connectionManager`,
 * never read back out of settings. It changes once per connection, which is how
 * often a composer can legitimately change owner.
 */
export const activeConnectionProfile = writable<ConnectionProfile | null>(null);

export function setActiveConnectionProfile(
    host: string,
    port: number | string,
    path: string | undefined,
    tls: boolean,
): ConnectionProfile | null {
    const profile = connectionProfile(host, port, path, tls);
    activeConnectionProfile.set(profile);
    return profile;
}

export function clearActiveConnectionProfile(): void {
    activeConnectionProfile.set(null);
}

export function getActiveConnectionProfile(): ConnectionProfile | null {
    return get(activeConnectionProfile);
}
