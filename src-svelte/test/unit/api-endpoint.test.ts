import { describe, it, expect } from 'vitest';
import { resolveApiEndpoint } from '#lib/api/api-endpoint.ts';

describe('resolveApiEndpoint', () => {
    it('plain loopback development endpoint', () => {
        const ep = resolveApiEndpoint({ host: 'localhost', port: 9010, tls: false });
        expect(ep.httpBase).toBe('http://localhost:9010');
        expect(ep.wsUrl).toBe('ws://localhost:9010/api');
        expect(ep.requestPath('buffers')).toBe('/api/buffers');
        expect(ep.requestPath('/hotlist')).toBe('/api/hotlist');
    });

    it('TLS default when unspecified', () => {
        const ep = resolveApiEndpoint({ host: 'example.org', port: 8443 });
        expect(ep.httpBase).toBe('https://example.org:8443');
        expect(ep.wsUrl).toBe('wss://example.org:8443/api');
    });

    it('proxy prefix without duplicating /api', () => {
        const ep = resolveApiEndpoint({ host: 'example.org', port: 443, path: '/proxy/glowing-bear/', tls: true });
        expect(ep.httpBase).toBe('https://example.org:443/proxy/glowing-bear');
        expect(ep.wsUrl).toBe('wss://example.org:443/proxy/glowing-bear/api');
        // Inner JSON request path is never prefixed.
        expect(ep.requestPath('sync')).toBe('/api/sync');
    });

    it('proxy path already ending in an "api" segment is not doubled', () => {
        const ep = resolveApiEndpoint({ host: 'example.org', port: 443, path: '/proxy/api', tls: true });
        expect(ep.httpBase).toBe('https://example.org:443/proxy');
        expect(ep.wsUrl).toBe('wss://example.org:443/proxy/api');
    });

    it('a prefix that merely ends in the letters api is preserved', () => {
        const ep = resolveApiEndpoint({ host: 'example.org', port: 443, path: 'myapi', tls: true });
        expect(ep.httpBase).toBe('https://example.org:443/myapi');
        expect(ep.wsUrl).toBe('wss://example.org:443/myapi/api');
    });

    it('scheme typed into the host field is normalized and derives TLS', () => {
        expect(resolveApiEndpoint({ host: 'wss://relay.example.org', port: 2000 }).wsUrl)
            .toBe('wss://relay.example.org:2000/api');
        expect(resolveApiEndpoint({ host: 'http://lan', port: 9010 }).httpBase)
            .toBe('http://lan:9010');
        // Explicit tls flag wins over the scheme guess.
        expect(resolveApiEndpoint({ host: 'ws://tunnel', port: 9010, tls: true }).wsUrl)
            .toBe('wss://tunnel:9010/api');
    });

    it('brackets bare IPv6 literals', () => {
        const ep = resolveApiEndpoint({ host: '::1', port: 9010, tls: false });
        expect(ep.httpBase).toBe('http://[::1]:9010');
        const ep2 = resolveApiEndpoint({ host: '[fe80::1%zonedoesnotmatter]', port: 9010, tls: false });
        expect(ep2.httpBase).toBe('http://[fe80::1%zonedoesnotmatter]:9010');
    });

    it('rejects invalid ports', () => {
        expect(() => resolveApiEndpoint({ host: 'h', port: 0 })).toThrow(/port/);
        expect(() => resolveApiEndpoint({ host: 'h', port: 'abc' })).toThrow(/port/);
        expect(() => resolveApiEndpoint({ host: 'h', port: '9010' })).not.toThrow();
    });
});
