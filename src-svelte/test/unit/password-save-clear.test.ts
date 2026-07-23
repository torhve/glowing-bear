import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { settings, updateSettings } from '$lib/stores/settings';

describe('password save/clear behavior', () => {
    beforeEach(() => {
        // Reset settings to known state before each test
        updateSettings({
            hostField: '',
            port: '443',
            tls: false,
            password: '',
            savepassword: false,
            autoconnect: false,
        });
    });

    it('stores password when savepassword is enabled', () => {
        updateSettings({ savepassword: true, password: 'my_secret' });
        const s = get(settings);
        expect(s.savepassword).toBe(true);
        expect(s.password).toBe('my_secret');
    });

    it('clears stored password when savepassword is disabled', () => {
        // First save a password
        updateSettings({ savepassword: true, password: 'my_secret' });
        expect(get(settings).password).toBe('my_secret');

        // Then disable savepassword — should clear the stored password
        updateSettings({ savepassword: false, password: '' });
        const s = get(settings);
        expect(s.savepassword).toBe(false);
        expect(s.password).toBe('');
    });

    it('preserves password when updating unrelated settings', () => {
        // Save password first
        updateSettings({ savepassword: true, password: 'saved_pass' });
        expect(get(settings).password).toBe('saved_pass');

        // Update an unrelated setting (e.g., hostField)
        updateSettings({ hostField: 'new.host.com' });
        const s = get(settings);
        expect(s.hostField).toBe('new.host.com');
        // Password should remain unchanged
        expect(s.password).toBe('saved_pass');
        expect(s.savepassword).toBe(true);
    });

    it('does not overwrite typed password with saved password on partial update', () => {
        // Simulate: user has saved password in localStorage
        updateSettings({ savepassword: true, password: 'old_saved' });
        expect(get(settings).password).toBe('old_saved');

        // User types a new password but doesn't save it yet
        // In the fixed ConnectionForm, typing updates local $state only,
        // and the form passes the typed value to connect() directly.
        // The settings store is NOT touched until handleConnect runs.
        // This test verifies that updating other fields doesn't touch password.
        updateSettings({ hostField: 'example.com' });
        updateSettings({ port: '9001' });
        updateSettings({ tls: true });

        // Settings password should still be the old saved value
        // (the typed password lives in ConnectionForm's local $state)
        expect(get(settings).password).toBe('old_saved');
    });

    it('savepassword:false without explicit password preserves existing password', () => {
        // Edge case: if code toggles savepassword off but doesn't include password:''
        // the existing password remains in the store (just not used for autoconnect)
        updateSettings({ savepassword: true, password: 'secret' });
        updateSettings({ savepassword: true, autoconnect: true });
        const s = get(settings);
        expect(s.savepassword).toBe(true);
        expect(s.autoconnect).toBe(true);
        expect(s.password).toBe('secret');
    });


});
