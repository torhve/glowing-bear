// Tauri window utilities — lazy-loaded to avoid import errors in browser context

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tauriWindow: any = null;

// Detect whether we are running inside a Tauri webview
function isTauri(): boolean {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__ !== undefined;
}

// Detect Windows platform via user agent string
function isWindowsPlatform(): boolean {
    return typeof navigator !== 'undefined' && /windows/i.test(navigator.userAgent);
}

// Detect macOS platform via user agent string
function isMacOSPlatform(): boolean {
    return typeof navigator !== 'undefined' && /macintosh|mac\sos\sx/i.test(navigator.userAgent);
}

async function ensureTauriWindow(): Promise<void> {
    if (tauriWindow !== null || !isTauri()) return;
    try {
        tauriWindow = await import('@tauri-apps/api/window');
    } catch (e) {
        console.warn('Tauri window API unavailable:', e);
    }
}

// Check if we are running on Windows inside Tauri
function isWindowsTauri(): boolean {
    return isTauri() && isWindowsPlatform();
}

// Check if we are running on macOS inside Tauri
function isMacOSTauri(): boolean {
    return isTauri() && isMacOSPlatform();
}

// Minimize the current window (no-op outside Tauri)
async function minimizeWindow(): Promise<void> {
    if (!isTauri()) return;
    await ensureTauriWindow();
    if (!tauriWindow) return;
    try {
        const win = tauriWindow.getCurrentWindow();
        await win.minimize();
    } catch (e) {
        console.warn('Failed to minimize window:', e);
    }
}

// Toggle between maximized and restored state (no-op outside Tauri)
async function toggleMaximizeWindow(): Promise<void> {
    if (!isTauri()) return;
    await ensureTauriWindow();
    if (!tauriWindow) return;
    try {
        const win = tauriWindow.getCurrentWindow();
        const isMaximized = await win.isMaximized();
        if (isMaximized) {
            await win.unmaximize();
        } else {
            await win.maximize();
        }
    } catch (e) {
        console.warn('Failed to toggle maximize:', e);
    }
}

// Close the current window (no-op outside Tauri)
async function closeWindow(): Promise<void> {
    if (!isTauri()) return;
    await ensureTauriWindow();
    if (!tauriWindow) return;
    try {
        const win = tauriWindow.getCurrentWindow();
        await win.close();
    } catch (e) {
        console.warn('Failed to close window:', e);
    }
}

export { isTauri, isWindowsTauri, isMacOSTauri, minimizeWindow, toggleMaximizeWindow, closeWindow };
