// Canvas-based favicon badge renderer — replaces favico.js
// Draws colored badge circles with unread/notification counts on the favicon

let baseImage: HTMLImageElement | null = null;
let isReady = false;

/**
 * Load the base favicon image once at startup
 */
export function initFavicon(): void {
    if (isReady || typeof document === 'undefined') return;

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
        baseImage = img;
        isReady = true;
    };
    img.onerror = () => {
        console.warn('Failed to load favicon for badge rendering');
    };
    img.src = '/favicon.png';
}

/**
 * Get a lighter shade of a hex color percentage
 */
function lightenColor(hex: string, percent: number): string {
    const num = parseInt(hex.replace('#', ''), 16);
    const r = Math.min(255, (num >> 16) + Math.round(255 * percent));
    const g = Math.min(255, ((num >> 8) & 0x00ff) + Math.round(255 * percent));
    const b = Math.min(255, (num & 0x0000ff) + Math.round(255 * percent));
    return `#${(r << 16 | g << 8 | b).toString(16).padStart(6, '0')}`;
}

/**
 * Format count for display on the badge
 */
export function formatCount(count: number): string {
    if (count > 999999) return '999k+';
    if (count >= 1000) {
        const k = Math.floor(count / 1000);
        return `${k}k+`;
    }
    if (count > 99) return '99+';
    return String(count);
}

/** The 32x32 canvas the badge is painted on, created once and cleared per draw. */
let badgeCanvas: HTMLCanvasElement | null = null;

/**
 * The last picture actually painted, so an identical redraw can be skipped.
 *
 * `drawOnCanvas` renders `formatCount(count)`, not `count`: every unread total
 * from 100 to 999 draws the same "99+", and every total from 1000 to 1999 draws
 * the same "1k+". A 2000-message flood arriving in a buffer you are not looking
 * at asks for 2000 badge redraws and produces 106 different pictures (measured:
 * `distinctHrefs=106` for 2000 messages). The other ~1900 each allocate a
 * canvas, resolve the theme palette, encode a PNG, swap the favicon href and
 * repaint the tab icon — to draw bytes identical to the one already there.
 *
 * Skipping them is not an approximation: the href that would have been written
 * is the href already set.
 */
let lastPaint: {
    label: string;
    type: 'notification' | 'unread';
    bg: string;
    base: HTMLImageElement | null;
} | null = null;

/**
 * Bumped by every draw request and by every invalidation.
 *
 * `drawBadge` is async because the base favicon loads asynchronously, so a
 * request can outlive the state that produced it. The generation a call claimed
 * at entry is what decides whether it may still paint.
 */
let drawGeneration = 0;

/**
 * Drop the cached paint identity and supersede in-flight draws.
 *
 * An appearance change (theme, custom CSS) can change the palette the badge is
 * drawn with while the count stays identical. The identity guard below compares
 * the resolved palette, so it would catch this eventually — but only by doing
 * the full canvas work, and an explicit invalidation is cheaper and clearer.
 */
export function invalidateFaviconBadge(): void {
    drawGeneration += 1;
    lastPaint = null;
}

/**
 * Resolved theme palette for the badge.
 *
 * getComputedStyle(...).getPropertyValue() is not a cheap read: it forces the
 * browser to flush pending style resolution. The badge resolved the palette on
 * every call — once per line batch — which during a flood means a forced style
 * recalculation interleaved with continuous DOM mutations, even when the badge
 * then decides the picture is unchanged and draws nothing.
 *
 * The palette depends on exactly two things the app itself controls: the
 * data-theme attribute on <html> (every palette in app.css is keyed by that
 * selector) and the text of the custom-CSS <style> tag. Both are plain attribute
 * and text reads, so the resolved colors are reused until one of them changes.
 * A palette edited by any other route — devtools, or a stylesheet the app does
 * not know about — is not detected until one of those two changes.
 */
let paletteCache: {
    theme: string;
    customCss: string;
    danger: string;
    success: string;
    failed: boolean;
} | null = null;

function resolveBadgePalette(type: 'notification' | 'unread'): { bgColor: string; textColor: string } {
    const theme = document.documentElement.getAttribute('data-theme') ?? '';
    const customCss = document.getElementById('custom-css-tag')?.textContent ?? '';

    let cached = paletteCache;
    if (!cached || cached.theme !== theme || cached.customCss !== customCss) {
        try {
            const computedStyle = getComputedStyle(document.documentElement || document.body);
            cached = {
                theme,
                customCss,
                danger: computedStyle.getPropertyValue('--gb-danger').trim(),
                success: computedStyle.getPropertyValue('--gb-success').trim(),
                failed: false,
            };
        } catch {
            cached = { theme, customCss, danger: '', success: '', failed: true };
        }
        paletteCache = cached;
    }

    const fallback = type === 'notification' ? '#e06c75' : '#7fd88f';
    const rawBg = type === 'notification' ? cached.danger : cached.success;
    const bgColor = rawBg || fallback;
    // Style resolution that threw used to fall back to plain white text rather
    // than a lightened palette colour; that output is preserved verbatim.
    return { bgColor, textColor: cached.failed ? '#ffffff' : lightenColor(bgColor, 0.2) };
}

/**
 * Draw a colored badge circle with count text on the favicon canvas
 */
function drawOnCanvas(count: number, type: 'notification' | 'unread'): void {
    const formatted = formatCount(count);

    const { bgColor, textColor } = resolveBadgePalette(type);

    // The palette is resolved before this check on purpose: it is what makes the
    // comparison exact. A theme switch or a custom-CSS edit changes `bgColor` and
    // misses the cache, so a redraw is only skipped when the picture really is
    // the same one.
    if (
        lastPaint !== null &&
        lastPaint.label === formatted &&
        lastPaint.type === type &&
        lastPaint.bg === bgColor &&
        lastPaint.base === baseImage
    ) {
        return;
    }

    if (!badgeCanvas) {
        badgeCanvas = document.createElement('canvas');
        badgeCanvas.width = 32;
        badgeCanvas.height = 32;
    }
    const canvas = badgeCanvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Draw base favicon
    ctx.clearRect(0, 0, 32, 32);
    if (baseImage) {
        ctx.drawImage(baseImage, 0, 0, 32, 32);
    } else {
        ctx.fillStyle = '#333';
        ctx.fillRect(0, 0, 32, 32);
    }

    // Draw badge circle — top-right corner, fully inside icon bounds
    const radius = 9;
    const cx = 23;
    const cy = 9;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = bgColor;
    ctx.fill();

    // Draw border for contrast
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Draw count text
    const fontSize = formatted.length > 2 ? 9 : 11;
    ctx.font = `bold ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = textColor;
    ctx.fillText(formatted, cx, cy + 0.5);

    // Encode once and share it. This was inside the loop, so a page with more
    // than one matching icon link paid a PNG encode per link.
    const href = canvas.toDataURL('image/png');

    // Update only the primary favicon link (32x32), not other icons
    const links = document.querySelectorAll("link[rel='icon'][sizes='32x32']");
    for (const link of links) {
        link.setAttribute('href', href);
    }

    lastPaint = { label: formatted, type, bg: bgColor, base: baseImage };
}

/**
 * Draw the favicon badge.
 * If the base image hasn't loaded yet, wait for it before drawing.
 * This prevents silent failures when drawBadge is called during reconnect
 * before initFavicon has finished loading /favicon.png.
 */
export async function drawBadge(count: number, type: 'notification' | 'unread'): Promise<void> {
    if (typeof document === 'undefined') return;

    // Claim a generation before awaiting. drawBadge waits for the base image, so
    // it can return long after the state that asked for it has been replaced —
    // after a disconnect, or after a newer count arrived. Only the newest call
    // is allowed to paint; an older one resuming here would put a stale badge
    // back on the tab.
    const generation = ++drawGeneration;

    // Wait for base image to be ready — initFavicon loads asynchronously
    if (!isReady) {
        await new Promise<void>(resolve => {
            const check = () => {
                if (isReady) resolve();
                else setTimeout(check, 50);
            };
            check();
        });
    }

    if (generation !== drawGeneration) return;
    drawOnCanvas(count, type);
}

/**
 * Reset the favicon to the original base image
 */
export function resetBadge(): void {
    if (typeof document === 'undefined') return;
    // Also supersedes any draw still waiting for the base image.
    drawGeneration += 1;
    // The href is about to go back to the plain file, so the next identical
    // badge must actually draw even if this same picture was drawn before.
    lastPaint = null;
    const links = document.querySelectorAll("link[rel='icon'][sizes='32x32']");
    for (const link of links) {
        if (link.getAttribute('href') !== '/favicon.png') {
            link.setAttribute('href', '/favicon.png');
        }
    }
}

/**
 * Generate a standalone badge PNG for Windows taskbar overlay icons.
 * Renders a colored circle with count text on a transparent 32x32 canvas,
 * then returns raw PNG bytes as Uint8Array for Tauri's setOverlayIcon API.
 */
export async function createOverlayBadgePNG(
    count: number,
    type: 'notification' | 'unread',
): Promise<Uint8Array> {
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');

    // Transparent background — Win32 composites over the taskbar icon
    ctx.clearRect(0, 0, 32, 32);

    const { bgColor, textColor } = resolveBadgePalette(type);

    // Draw badge circle — centered on canvas for overlay positioning
    const radius = 9;
    const cx = 16;
    const cy = 16;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = bgColor;
    ctx.fill();

    // Draw count text
    const formatted = formatCount(count);
    const fontSize = formatted.length > 2 ? 9 : 11;
    ctx.font = `bold ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = textColor;
    ctx.fillText(formatted, cx, cy + 0.5);

    // Convert to PNG bytes via data URL
    const dataUrl = canvas.toDataURL('image/png');
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}
