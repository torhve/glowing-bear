import { writable } from 'svelte/store';
import type { Settings } from '$lib/types';

export const settings = writable<Settings>({
    hostField: '',
    port: '443',
    tls: typeof window !== 'undefined' ? window.location.protocol === 'https:' : false,
    password: '',
    savepassword: false,
    autoconnect: false,
    useTotp: false,
    theme: 'dark',
    fontfamily: '',
    fontsize: '14px',
    customCSS: '',
    iToken: '',
    iAlb: '',
    onlyUnread: false,
    noembed: true,
    alwaysnicklist: false,
    orderbyserver: true,
    readlineBindings: false,
    useFavico: true,
    soundnotification: true,
    notificationPermission: 'default',
    enableMathjax: false,
    enableQuickKeys: true,
    showNicklist: true,
    showQuickKeys: false,
    highlightWords: '',
    debugBuildMetadata: false,
    hotlistsync: true,
    stylizePrivateChats: false,
    enableEmojify: true
});

// Load from localStorage on init
if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
    const saved = localStorage.getItem('gb-settings');
    if (saved) {
        try {
            settings.set({ ...get(settings), ...JSON.parse(saved) });
        } catch (e) {
            console.error('Failed to parse settings from localStorage', e);
        }
    }
}

import { get } from 'svelte/store';

export function updateSettings(partial: Partial<Settings>) {
    const current = get(settings);
    const updated = { ...current, ...partial };
    settings.set(updated);
    if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
        localStorage.setItem('gb-settings', JSON.stringify(updated));
    }
}

// Parse URL hash parameters and apply them to settings (takes precedence over stored settings).
// Matches AngularJS parseHash() behavior from glowingbear.js:694-720.
export function applyHashParams(): void {
    if (typeof window === 'undefined') return;
    const hash = window.location.hash.slice(1);
    if (!hash) return;

    const params: Record<string, string> = {};
    hash.split('&').forEach(val => {
        const segs = val.split('=');
        if (segs.length >= 2 && segs[0]) {
            params[segs[0]] = decodeURIComponent(segs.slice(1).join('='));
        }
    });

    const updates: Partial<Settings> = {};

    if (params.host) {
        updates.hostField = params.host;
    }

    if (params.port) {
        updates.port = params.port;
    }

    if (params.path && params.host) {
        // Reconstruct hostField as host:port/path when path is provided
        const portStr = params.port || get(settings).port || '443';
        updates.hostField = `${params.host}:${portStr}/${params.path}`;
    }

    if (params.password) {
        updates.password = params.password;
    }

    if (params.autoconnect) {
        updates.autoconnect = params.autoconnect === 'true';
    }

    if (Object.keys(updates).length > 0) {
        updateSettings(updates);
    }
}
