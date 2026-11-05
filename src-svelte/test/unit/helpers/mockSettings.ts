import { vi } from 'vitest';
import type { Settings } from '#lib/types.ts';

/**
 * The settings a unit test starts from.
 *
 * Written as a `Settings` literal rather than reusing the real store so a test
 * that mocks this module does not import it. The cost of not importing it is
 * drift, so `settings-defaults-guard.test.ts` compares these values against the
 * store's own defaults and fails when they separate.
 *
 * That guard is not theoretical. Before this helper existed, twenty files each
 * hand-wrote their own settings object in thirteen different shapes, and four of
 * them listed `notifyDMs`, `notifyHighlights`, `notificationSoundMode` and
 * `notificationVolume` — none of which is a `Settings` field any more. A typed
 * literal rejects them; an untyped object literal inside a mock factory never
 * would.
 */
export const TEST_SETTINGS: Settings = {
    hostField: '',
    port: '443',
    tls: false,
    password: '',
    savepassword: false,
    autoconnect: false,
    useTotp: false,
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
    warnDuplicateLinks: true,
    protocol: 'auto',
    bufferSearchSort: 'number',
};

/** A store-shaped settings mock holding `TEST_SETTINGS` plus this test's overrides. */
export function mockSettings(overrides: Partial<Settings> = {}): {
    settings: { subscribe: (fn: (value: Settings) => void) => () => void };
    updateSettings: ReturnType<typeof vi.fn>;
    hashSyncVersion: { subscribe: (fn: (value: number) => void) => () => void };
    applyHashParams: ReturnType<typeof vi.fn>;
} {
    let current: Settings = { ...TEST_SETTINGS, ...overrides };
    const listeners = new Set<(value: Settings) => void>();

    function subscribe(fn: (value: Settings) => void): () => void {
        listeners.add(fn);
        // A Svelte store reports its current value on subscribe; a mock that waits
        // for the next write leaves every reader holding nothing.
        fn(current);
        return () => listeners.delete(fn);
    }

    function updateSettings(partial: Partial<Settings>): void {
        current = { ...current, ...partial };
        for (const fn of listeners) fn(current);
    }

    return {
        settings: { subscribe },
        updateSettings: vi.fn(updateSettings),
        // The real module exports these two as well; a mock that omits them turns
        // an unrelated import into `undefined is not a function`.
        hashSyncVersion: { subscribe: (fn: (value: number) => void) => { fn(0); return () => {}; } },
        applyHashParams: vi.fn(),
    };
}
