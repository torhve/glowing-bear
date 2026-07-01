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

/**
 * Draw a colored badge circle with count text on the favicon canvas
 */
function drawOnCanvas(count: number, type: 'notification' | 'unread'): void {
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
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

    // Get colors from CSS variables
    let bgColor: string;
    let textColor: string;
    try {
        const computedStyle = getComputedStyle(document.documentElement || document.body);
        const rawBg = type === 'notification'
            ? computedStyle.getPropertyValue('--gb-danger').trim()
            : computedStyle.getPropertyValue('--gb-success').trim();
        bgColor = rawBg || (type === 'notification' ? '#e06c75' : '#7fd88f');
        textColor = lightenColor(bgColor, 0.2);
    } catch {
        bgColor = type === 'notification' ? '#e06c75' : '#7fd88f';
        textColor = '#ffffff';
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
    const formatted = formatCount(count);
    const fontSize = formatted.length > 2 ? 9 : 11;
    ctx.font = `bold ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = textColor;
    ctx.fillText(formatted, cx, cy + 0.5);

    // Update only the primary favicon link (32x32), not other icons
    const links = document.querySelectorAll("link[rel='icon'][sizes='32x32']");
    for (const link of links) {
        link.setAttribute('href', canvas.toDataURL('image/png'));
    }
}

/**
 * Draw the favicon badge.
 * If the base image hasn't loaded yet, wait for it before drawing.
 * This prevents silent failures when drawBadge is called during reconnect
 * before initFavicon has finished loading /favicon.png.
 */
export async function drawBadge(count: number, type: 'notification' | 'unread'): Promise<void> {
    if (typeof document === 'undefined') return;

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

    drawOnCanvas(count, type);
}

/**
 * Reset the favicon to the original base image
 */
export function resetBadge(): void {
    if (typeof document === 'undefined') return;
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

    // Get colors from CSS variables
    let bgColor: string;
    let textColor: string;
    try {
        const computedStyle = getComputedStyle(document.documentElement || document.body);
        const rawBg = type === 'notification'
            ? computedStyle.getPropertyValue('--gb-danger').trim()
            : computedStyle.getPropertyValue('--gb-success').trim();
        bgColor = rawBg || (type === 'notification' ? '#e06c75' : '#7fd88f');
        textColor = lightenColor(bgColor, 0.2);
    } catch {
        bgColor = type === 'notification' ? '#e06c75' : '#7fd88f';
        textColor = '#ffffff';
    }

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
