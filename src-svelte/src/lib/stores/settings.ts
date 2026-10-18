import { writable, get } from 'svelte/store';
import type { Settings } from '#lib/types.ts';
import { isTheme, type Theme } from '#lib/themes.ts';

export const settings = writable<Settings>({
    hostField: '',
    port: '443',
    tls: typeof window !== 'undefined' ? window.location.protocol === 'https:' : false,
    password: '',
    savepassword: false,
    autoconnect: false,
    useTotp: false,
    // Issue #13: one palette per OS scheme. `theme.ts` picks which one is on screen.
    themeDark: 'dark',
    themeLight: 'light',
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
    enableEmojify: true,
    enableFormatting: true,
    protocol: 'auto',
    // 'number' is the order the sidebar already shows; the buffer-search dialog
    // is the only consumer.
    bufferSearchSort: 'number'
});

// The key the theme store wrote before issue #13 introduced the two slots.
const LEGACY_THEME_KEY = 'gb_theme';

/**
 * Read the pre-slot theme key and remove it.
 *
 * The settings blob owns the theme from #13 on, so this is a one-way move rather
 * than a second source the app keeps consulting.
 */
function takeLegacyThemeKey(): Theme | null {
    const raw = localStorage.getItem(LEGACY_THEME_KEY);
    if (raw === null) return null;
    localStorage.removeItem(LEGACY_THEME_KEY);
    return isTheme(raw) ? raw : null;
}

/**
 * Fold a pre-#13 profile into the two theme slots.
 *
 * An older profile had one explicit palette, so it pins both slots: upgrading must
 * not repaint someone's app just because the OS sits in the other scheme. The palette
 * may come from the settings blob's `theme` or from the standalone key the old theme
 * store wrote, the key winning as the later write. A slot naming a palette that no
 * longer exists is dropped so the default applies, and the obsolete `theme` key is
 * removed instead of being carried in the store forever.
 */
function migrateThemeSlots(saved: Record<string, unknown>, legacyThemeKey: Theme | null): Partial<Settings> {
    const migrated: Record<string, unknown> = { ...saved };
    const blobTheme = isTheme(saved.theme) ? saved.theme : null;
    const legacy = legacyThemeKey ?? blobTheme;
    delete migrated.theme;

    if (legacy && !isTheme(migrated.themeDark) && !isTheme(migrated.themeLight)) {
        migrated.themeDark = legacy;
        migrated.themeLight = legacy;
    }
    if (!isTheme(migrated.themeDark)) delete migrated.themeDark;
    if (!isTheme(migrated.themeLight)) delete migrated.themeLight;

    return migrated as Partial<Settings>;
}

// Load from localStorage on init
if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
    const legacyTheme = takeLegacyThemeKey();
    const saved = localStorage.getItem('gb-settings');
    if (saved) {
        try {
            const parsed: unknown = JSON.parse(saved);
            if (parsed && typeof parsed === 'object') {
                settings.set({ ...get(settings), ...migrateThemeSlots(parsed as Record<string, unknown>, legacyTheme) });
            }
        } catch (e) {
            console.error('Failed to parse settings from localStorage', e);
        }
    } else if (legacyTheme) {
        // A profile that only ever wrote the old theme key still keeps its palette.
        settings.set({ ...get(settings), themeDark: legacyTheme, themeLight: legacyTheme });
    }
}

export function updateSettings(partial: Partial<Settings>) {
    const current = get(settings);
    const updated = { ...current, ...partial };
    settings.set(updated);
    if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
        localStorage.setItem('gb-settings', JSON.stringify(updated));
    }
}

// Monotonically-increasing store that increments whenever hash params are applied.
// ConnectionForm.svelte's $effect tracks $hashSyncVersion as a reactive dependency,
// so the effect re-runs only when hash params change, not on user typing.
export const hashSyncVersion = writable(0);

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

    if (params.protocol === 'auto' || params.protocol === 'api' || params.protocol === 'legacy') {
        updates.protocol = params.protocol;
    }

    if (Object.keys(updates).length > 0) {
        updateSettings(updates);
        hashSyncVersion.update(v => v + 1);
    }
}

