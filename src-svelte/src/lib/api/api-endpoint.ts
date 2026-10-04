// Canonical API endpoint resolution (phase 4).
//
// The user configures host/port/path/tls. `path` is an optional proxy prefix
// (may be empty, may contain a rewritten prefix like "proxy/glowing-bear",
// and may already end in "api" when the proxy rewrites the API root). The
// inner JSON request path inside WebSocket frames is ALWAYS "/api/..."
// regardless of any external prefix.

export interface ApiEndpoint {
    /** HTTP base without trailing slash, e.g. https://host:8443/proxy */
    httpBase: string;
    /** Full WebSocket URL for the API, e.g. wss://host:8443/proxy/api */
    wsUrl: string;
    /** Path used inside JSON request objects — never prefixed. */
    requestPath(resource: string): string;
    tls: boolean;
}

export interface EndpointConfig {
    host: string;
    port: number | string;
    path?: string;
    tls?: boolean;
}

/** Normalize a user-entered host: strip any scheme they typed, derive TLS
 *  from it when the tls flag was not given, bracket bare IPv6 literals. */
function normalizeHost(rawHost: string): { host: string; tlsFromScheme?: boolean } {
    let host = rawHost.trim();
    let tlsFromScheme: boolean | undefined;

    const schemeMatch = host.match(/^(https?|wss?):\/\//i);
    if (schemeMatch) {
        tlsFromScheme = /^https?|wss?/i.test(schemeMatch[0]!) && !/^http:|^ws:/i.test(schemeMatch[0]!);
        host = host.slice(schemeMatch[0].length);
    }
    // Drop any path portion accidentally included in the host field.
    const slash = host.indexOf('/');
    if (slash >= 0) host = host.slice(0, slash);
    host = host.replace(/\/+$/, '');

    // Bare IPv6 (contains ':', not already bracketed) needs brackets in URLs.
    if (host.includes(':') && !host.startsWith('[')) {
        host = `[${host}]`;
    }
    return { host, tlsFromScheme };
}

export function resolveApiEndpoint(config: EndpointConfig): ApiEndpoint {
    const { host, tlsFromScheme } = normalizeHost(config.host);
    const tls = config.tls ?? tlsFromScheme ?? true;

    const port = typeof config.port === 'string' ? parseInt(config.port, 10) : config.port;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`Invalid port: ${JSON.stringify(config.port)}`);
    }

    // Prefix: normalized to "" or "/seg/.../seg" (no trailing slash).
    let prefix = (config.path ?? '').trim().replace(/^\/+|\/+$/g, '');
    // If the last configured segment is exactly "api", the proxy already
    // rewrites to the API root — do not append a second "/api".
    const segments = prefix ? prefix.split('/') : [];
    if (segments.length && segments[segments.length - 1]!.toLowerCase() === 'api') {
        segments.pop();
    }
    prefix = segments.join('/');
    const prefixPart = prefix ? `/${prefix}` : '';

    const httpBase = `${tls ? 'https' : 'http'}://${host}:${port}${prefixPart}`;
    const wsUrl = `${tls ? 'wss' : 'ws'}://${host}:${port}${prefixPart}/api`;

    return {
        httpBase,
        wsUrl,
        requestPath: (resource: string) => `/api/${resource.replace(/^\/+/, '')}`,
        tls,
    };
}
