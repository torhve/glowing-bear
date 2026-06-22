import { describe, it, expect, beforeEach, vi } from 'vitest';
import { get } from 'svelte/store';
import { settings, applyHashParams, updateSettings } from '$lib/stores/settings';

describe('applyHashParams', () => {
    beforeEach(() => {
        // Reset settings to defaults before each test
        updateSettings({
            hostField: '',
            port: '443',
            tls: false,
            password: '',
            savepassword: false,
            autoconnect: false,
        });
        vi.restoreAllMocks();
    });

    function setHash(hash: string) {
        Object.defineProperty(window, 'location', {
            value: { ...window.location, hash: '#' + hash },
            writable: true,
        });
    }

    it('does nothing when hash is empty', () => {
        setHash('');
        const before = get(settings);
        applyHashParams();
        expect(get(settings)).toEqual(before);
    });

    it('parses host parameter', () => {
        setHash('host=my.domain.com');
        applyHashParams();
        expect(get(settings).hostField).toBe('my.domain.com');
    });

    it('parses port parameter', () => {
        setHash('port=9001');
        applyHashParams();
        expect(get(settings).port).toBe('9001');
    });

    it('parses password parameter', () => {
        setHash('password=hunter2');
        applyHashParams();
        expect(get(settings).password).toBe('hunter2');
    });

    it('parses autoconnect=true', () => {
        setHash('autoconnect=true');
        applyHashParams();
        expect(get(settings).autoconnect).toBe(true);
    });

    it('parses autoconnect=false as false', () => {
        updateSettings({ autoconnect: true });
        setHash('autoconnect=false');
        applyHashParams();
        expect(get(settings).autoconnect).toBe(false);
    });

    it('parses multiple parameters together', () => {
        setHash('host=localhost&port=9001&password=testpass&autoconnect=true');
        applyHashParams();
        expect(get(settings).hostField).toBe('localhost');
        expect(get(settings).port).toBe('9001');
        expect(get(settings).password).toBe('testpass');
        expect(get(settings).autoconnect).toBe(true);
    });

    it('reconstructs hostField with path when host is present', () => {
        setHash('host=my.domain.com&port=8000&path=weechat2');
        applyHashParams();
        expect(get(settings).hostField).toBe('my.domain.com:8000/weechat2');
    });

    it('uses default port 443 when only path is provided with host', () => {
        updateSettings({ port: '443' });
        setHash('host=my.domain.com&path=custom');
        applyHashParams();
        expect(get(settings).hostField).toBe('my.domain.com:443/custom');
    });

    it('does not reconstruct hostField with path when host is absent', () => {
        setHash('port=9001&path=weechat2');
        applyHashParams();
        // path without host should be ignored (no reconstruction)
        expect(get(settings).hostField).toBe('');
    });

    it('handles URL-encoded values', () => {
        setHash('host=my%2Edomain%2Ecom&password=p%40ss%26w0rd');
        applyHashParams();
        expect(get(settings).hostField).toBe('my.domain.com');
        expect(get(settings).password).toBe('p@ss&w0rd');
    });

    it('ignores malformed params without equals sign', () => {
        setHash('host=localhost&badparam&port=9001');
        applyHashParams();
        expect(get(settings).hostField).toBe('localhost');
        expect(get(settings).port).toBe('9001');
    });

    it('handles params with empty value', () => {
        setHash('host=&port=9001');
        applyHashParams();
        // Empty host should not update (segs[0] is truthy but segs[1] would be empty)
        expect(get(settings).port).toBe('9001');
    });

    it('handles params with = in the value', () => {
        setHash('password=p%3Dass%3Dword');
        applyHashParams();
        expect(get(settings).password).toBe('p=ass=word');
    });

    it('does not read from server side', () => {
        const originalWindow = globalThis.window;
        // @ts-expect-error - testing SSR guard
        delete globalThis.window;
        expect(() => applyHashParams()).not.toThrow();
        globalThis.window = originalWindow;
    });

    it('overwrites localStorage-stored settings', () => {
        updateSettings({ hostField: 'old.host', port: '8080', password: 'oldpass' });
        setHash('host=new.host&port=9001&password=newpass');
        applyHashParams();
        expect(get(settings).hostField).toBe('new.host');
        expect(get(settings).port).toBe('9001');
        expect(get(settings).password).toBe('newpass');
    });
});
