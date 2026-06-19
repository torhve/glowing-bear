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
    hotlistsync: true
});

// Load from localStorage on init
if (typeof window !== 'undefined') {
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
    if (typeof window !== 'undefined') {
        localStorage.setItem('gb-settings', JSON.stringify(updated));
    }
}
