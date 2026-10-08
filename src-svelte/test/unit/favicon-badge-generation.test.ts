import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * The favicon badge's asynchronous draw cannot put a stale picture back.
 *
 * `drawBadge` waits for the base favicon to load, so a request can outlive the
 * state that produced it — a disconnect, or a newer count. The generation a call
 * claimed at entry is what decides whether it may still paint.
 *
 * jsdom has no 2D canvas and does not fetch images, so both are stubbed: the
 * context is a no-op, `toDataURL` records which draw reached the tab, and the
 * base image resolves on a controllable timer. That is what makes "the older
 * request resumed late" a case the test can actually construct.
 *
 * Each test re-imports the module: `isReady` and the generation counter are
 * module state, and a base image that loaded in one test would make the next
 * test's draw synchronous — destroying the very situation under test.
 */

const ICON_SELECTOR = "link[rel='icon'][sizes='32x32']";

/** How many times a picture actually reached the favicon link. */
let paints = 0;

/** Delay after which the stubbed base favicon finishes loading. */
const BASE_IMAGE_LOAD_MS = 300;

function iconHref(): string | null {
    const link = document.querySelector(ICON_SELECTOR);
    return link ? link.getAttribute('href') : null;
}

function paintHref(n: number): string {
    return `data:image/png;base64,${btoa(`paint-${n}`)}`;
}

async function freshBadge() {
    vi.resetModules();
    return await import('#lib/faviconBadge.ts');
}

function stubCanvasAndImage(): void {
    const ctx = {
        clearRect: () => {},
        fillRect: () => {},
        drawImage: () => {},
        beginPath: () => {},
        closePath: () => {},
        arc: () => {},
        fill: () => {},
        stroke: () => {},
        fillText: () => {},
        font: '',
        textAlign: '',
        textBaseline: '',
        fillStyle: '',
        strokeStyle: '',
        lineWidth: 1,
    };
    const proto = window.HTMLCanvasElement.prototype as unknown as Record<string, unknown>;
    proto.getContext = (kind: string) => (kind === '2d' ? ctx : null);
    proto.toDataURL = () => {
        paints += 1;
        return paintHref(paints);
    };

    class StubImage {
        crossOrigin = '';
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        set src(_value: string) {
            // Deferred, not synchronous: the whole point is that a draw can be
            // waiting when the state that asked for it is replaced.
            setTimeout(() => this.onload?.(), BASE_IMAGE_LOAD_MS);
        }
    }
    vi.stubGlobal('Image', StubImage);
}

function armIconLink(): void {
    document.head.querySelectorAll(ICON_SELECTOR).forEach((n) => n.remove());
    const link = document.createElement('link');
    link.setAttribute('rel', 'icon');
    link.setAttribute('sizes', '32x32');
    link.setAttribute('href', '/favicon.png');
    document.head.appendChild(link);
}

describe('favicon badge draw generation', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        paints = 0;
        armIconLink();
        stubCanvasAndImage();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('lets only the newest of two queued draws paint', async () => {
        const { initFavicon, drawBadge } = await freshBadge();
        initFavicon();
        // Both calls park on the readiness poll while the base image loads.
        const first = drawBadge(5, 'unread');
        const second = drawBadge(7, 'unread');
        await vi.advanceTimersByTimeAsync(BASE_IMAGE_LOAD_MS + 100);
        await Promise.all([first, second]);

        expect(paints).toBe(1);
        expect(iconHref()).toBe(paintHref(1));
    });

    it('drops an in-flight draw when the badge is reset', async () => {
        const { initFavicon, drawBadge, resetBadge } = await freshBadge();
        initFavicon();
        const pending = drawBadge(9, 'unread');
        resetBadge();
        await vi.advanceTimersByTimeAsync(BASE_IMAGE_LOAD_MS + 100);
        await pending;

        expect(paints).toBe(0);
        expect(iconHref()).toBe('/favicon.png');
    });

    it('drops an in-flight draw when an appearance change invalidates the badge', async () => {
        const { initFavicon, drawBadge, invalidateFaviconBadge } = await freshBadge();
        initFavicon();
        const pending = drawBadge(4, 'notification');
        invalidateFaviconBadge();
        await vi.advanceTimersByTimeAsync(BASE_IMAGE_LOAD_MS + 100);
        await pending;

        expect(paints).toBe(0);
        expect(iconHref()).toBe('/favicon.png');
    });

    it('draws when nothing superseded the request', async () => {
        const { initFavicon, drawBadge } = await freshBadge();
        initFavicon();
        const pending = drawBadge(3, 'unread');
        await vi.advanceTimersByTimeAsync(BASE_IMAGE_LOAD_MS + 100);
        await pending;

        expect(paints).toBe(1);
        expect(iconHref()).toBe(paintHref(1));
    });

    it('keeps the overlay PNG path independent of the tab badge', async () => {
        // The Tauri overlay builds its own canvas and must not be suppressed by
        // the tab badge's identity guard or generation counter.
        const { createOverlayBadgePNG } = await freshBadge();
        const bytes = await createOverlayBadgePNG(2, 'unread');
        expect(bytes).toBeInstanceOf(Uint8Array);
        expect(bytes.length).toBeGreaterThan(0);
    });
});
