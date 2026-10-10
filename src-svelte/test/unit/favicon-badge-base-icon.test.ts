import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * The badge must survive the deployment it is actually served from.
 *
 * The app is deployed under a base path (`.github/workflows/deploy-pages.yml`
 * builds with `BASE_PATH=/glowing-bear`), so the 32x32 icon link in the page
 * ships `./favicon.png` and the file lives at `/glowing-bear/favicon.png`.
 * `faviconBadge.ts` used to ask the server for an absolute `/favicon.png`,
 * which is a 404 there — and because a failed load left the renderer waiting
 * for a base image that never arrived, that 404 meant no badge ever, while
 * `resetBadge()` overwrote the working href with the broken one. The Tauri
 * badge is native and never touches the favicon, which is why only the web
 * build showed the bug.
 *
 * So the icon link the document ships with is the source of truth: it is
 * loaded from there and restored to there.
 *
 * jsdom fetches nothing and has no 2D canvas, so `Image` is stubbed with a
 * controllable outcome and `toDataURL` counts the pictures that reached the tab.
 * Each test re-imports the module: the base-image state is module state.
 */

const ICON_SELECTOR = "link[rel='icon'][sizes='32x32']";

/** How many times a picture actually reached the favicon link. */
let paints = 0;

/** Every src the renderer asked an `Image` to load, in order. */
let requestedSrcs: string[] = [];

function iconHref(): string | null {
    const link = document.querySelector(ICON_SELECTOR);
    return link ? link.getAttribute('href') : null;
}

async function freshBadge() {
    vi.resetModules();
    return await import('#lib/faviconBadge.ts');
}

/**
 * Stub the canvas and the base image.
 *
 * `outcome` is what the browser reports for the base icon: 'load' is the
 * normal case, 'error' is the 404 a base-path deployment used to hit.
 */
function stubCanvasAndImage(outcome: 'load' | 'error'): void {
    const ctx = {
        clearRect: () => {}, fillRect: () => {}, drawImage: () => {}, beginPath: () => {},
        closePath: () => {}, arc: () => {}, fill: () => {}, stroke: () => {}, fillText: () => {},
        font: '', textAlign: '', textBaseline: '', fillStyle: '', strokeStyle: '', lineWidth: 1,
    };
    const proto = window.HTMLCanvasElement.prototype as unknown as Record<string, unknown>;
    proto.getContext = (kind: string) => (kind === '2d' ? ctx : null);
    proto.toDataURL = () => {
        paints += 1;
        return `data:image/png;base64,${btoa(`paint-${paints}`)}`;
    };

    class StubImage {
        crossOrigin = '';
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;

        set src(value: string) {
            requestedSrcs.push(value);
            // Deferred, not synchronous: the renderer must cope with a draw that
            // is already waiting when the outcome arrives.
            setTimeout(() => {
                if (outcome === 'load') this.onload?.();
                else this.onerror?.();
            }, 100);
        }
    }
    vi.stubGlobal('Image', StubImage);
}

/** Arm the icon link the way a base-path deployment ships it. */
function armIconLink(href = './glowing-bear/favicon.png'): void {
    document.head.querySelectorAll(ICON_SELECTOR).forEach((n) => n.remove());
    const link = document.createElement('link');
    link.setAttribute('rel', 'icon');
    link.setAttribute('sizes', '32x32');
    link.setAttribute('href', href);
    document.head.appendChild(link);
}

/**
 * The URL the shipped href resolves to — what the browser actually requests, and
 * what resetBadge() must put back. Kit's client runtime absolutizes icon links
 * at startup, so an absolute href is the state the page is really in.
 */
function shippedUrl(href = './glowing-bear/favicon.png'): string {
    return new URL(href, document.baseURI).href;
}

describe('favicon badge base icon', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        paints = 0;
        requestedSrcs = [];
        armIconLink();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        document.head.querySelectorAll(ICON_SELECTOR).forEach((n) => n.remove());
    });

    it('loads the base icon from the href the document ships with', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        stubCanvasAndImage('load');
        const { initFavicon, drawBadge } = await freshBadge();

        initFavicon();
        await vi.advanceTimersByTimeAsync(200);
        await drawBadge(3, 'unread');

        // The request follows the shipped href — the file the server actually
        // answers — instead of a hardcoded root path.
        expect(requestedSrcs).toHaveLength(1);
        expect(requestedSrcs[0]).toMatch(/\/glowing-bear\/favicon\.png$/);
        expect(requestedSrcs[0]).not.toMatch(/:\/\/[^/]+\/favicon\.png$/);
        expect(paints).toBe(1);
        expect(iconHref()?.startsWith('data:')).toBe(true);
        warn.mockRestore();
    });

    it('still draws a badge when the base icon 404s', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        stubCanvasAndImage('error');
        const { initFavicon, drawBadge } = await freshBadge();

        initFavicon();
        await vi.advanceTimersByTimeAsync(200); // the load fails

        const draw = drawBadge(7, 'unread');
        // No readiness poll to outlast: a failed load is an outcome, not a wait.
        await expect(draw).resolves.toBeUndefined();
        await vi.advanceTimersByTimeAsync(60_000);

        expect(paints).toBe(1);
        expect(iconHref()?.startsWith('data:')).toBe(true);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('Failed to load favicon'));
        warn.mockRestore();
    });

    it('does not park a draw when initFavicon was never called', async () => {
        stubCanvasAndImage('load');
        const { drawBadge } = await freshBadge();

        const draw = drawBadge(2, 'notification');
        await vi.advanceTimersByTimeAsync(200);
        await expect(draw).resolves.toBeUndefined();

        expect(requestedSrcs).toHaveLength(1);
        expect(paints).toBe(1);
    });

    it('resetBadge restores the href the document shipped with', async () => {
        stubCanvasAndImage('load');
        const { initFavicon, drawBadge, resetBadge } = await freshBadge();

        initFavicon();
        await vi.advanceTimersByTimeAsync(200);
        await drawBadge(4, 'unread');
        expect(iconHref()?.startsWith('data:')).toBe(true);

        resetBadge();
        expect(iconHref()).toBe(shippedUrl());
    });

    it('resetBadge before any draw restores the served URL, not an invented path', async () => {
        stubCanvasAndImage('load');
        const { resetBadge } = await freshBadge();

        // The mount-time invalidation reaches resetBadge before the icon has
        // been initialised; it must not rewrite a href the server answers.
        resetBadge();
        expect(iconHref()).toBe(shippedUrl());
        // The old bug: an absolute '/favicon.png', which a base-path deploy 404s.
        expect(new URL(iconHref()!, document.baseURI).pathname).toBe('/glowing-bear/favicon.png');
    });

    it('a failed base load is terminal and later draws do not wait again', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        stubCanvasAndImage('error');
        const { initFavicon, drawBadge } = await freshBadge();

        initFavicon();
        await vi.advanceTimersByTimeAsync(200);
        await drawBadge(1, 'unread');
        const srcsAfterFirstLoad = requestedSrcs.length;

        // Every later draw paints without re-requesting the icon that failed.
        await drawBadge(2, 'unread');
        await drawBadge(3, 'unread');
        await vi.advanceTimersByTimeAsync(1000);

        expect(requestedSrcs).toHaveLength(srcsAfterFirstLoad);
        expect(paints).toBe(3);
        warn.mockRestore();
    });
});
