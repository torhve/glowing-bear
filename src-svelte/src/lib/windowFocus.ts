// Window focus tracking — generic for web/PWA, enhanced by Tauri native events when available.
// In Tauri's WKWebView, `document.hidden` does not reliably reflect whether the native
// window lost focus, so Tauri's onFocus/onBlur events are used as a correction layer.

import { isTauri } from './tauriWindow';

// Current focus state — true means window is in front/visible
let focused: boolean = typeof document !== 'undefined' && !document.hidden;

// Store cleanup functions
let webListenersCleanup: (() => void) | null = null;
let tauriUnlisten: (() => void) | null = null;

// Attach standard web listeners (works in browser, PWA, and as baseline in Tauri)
function attachWebListeners(): () => void {
    const onFocus = () => { focused = true; };
    const onBlur = () => { focused = false; };
    const onVisibilityChange = () => {
        if (typeof document !== 'undefined') {
            focused = !document.hidden;
        }
    };

    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', onVisibilityChange);
    }

    return () => {
        window.removeEventListener('focus', onFocus);
        window.removeEventListener('blur', onBlur);
        if (typeof document !== 'undefined') {
            document.removeEventListener('visibilitychange', onVisibilityChange);
        }
    };
}

// Initialize focus tracking — returns cleanup function
export async function initWindowFocusTracking(): Promise<() => void> {
    // Attach standard web listeners
    webListenersCleanup = attachWebListeners();

    // Augment with Tauri native focus events when available
    if (isTauri()) {
        try {
            const tauriWindow = await import('@tauri-apps/api/window');
            const win = tauriWindow.getCurrentWindow();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const winAny = win as any;
            const [unlistenFocus, unlistenBlur] = await Promise.all([
                winAny.onFocus(() => { focused = true; }),
                winAny.onBlur(() => { focused = false; }),
            ]);
            tauriUnlisten = () => {
                unlistenFocus();
                unlistenBlur();
            };
        } catch (e) {
            console.warn('Failed to set up Tauri window focus tracking:', e);
        }
    }

    return () => {
        webListenersCleanup?.();
        webListenersCleanup = null;
        tauriUnlisten?.();
        tauriUnlisten = null;
    };
}

export function isWindowFocused(): boolean {
    // In Tauri, document.hidden is unreliable — use cached state from native events.
    // In browsers/PWA, read document.hidden directly for accuracy.
    if (isTauri()) return focused;
    return typeof document !== 'undefined' && !document.hidden;
}
