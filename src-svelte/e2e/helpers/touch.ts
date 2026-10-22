import type { Page } from '@playwright/test';

/**
 * Dispatch a touch swipe inside the page.
 *
 * The gesture handlers listen on `document`, so the events must bubble with the shape a
 * finger produces: a start, intermediate moves, and an end that carries `changedTouches`
 * and no live touches. Dispatching them synchronously keeps the whole gesture inside the
 * window the app accepts as a swipe rather than a scroll.
 *
 * This lives here because five specs had copied the same dispatcher verbatim, and a swipe
 * helper that drifts from the app's thresholds tests nothing.
 */
export async function swipe(
    page: Page,
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    options: { selector?: string; steps?: number } = {},
): Promise<void> {
    const steps = options.steps ?? 10;
    await page.evaluate(({ sel, sx, sy, ex, ey, steps }) => {
        const target = sel ? document.querySelector(sel) : document;
        if (!target) return;
        const makeTouch = (x: number, y: number, id: number) =>
            new Touch({ identifier: id, clientX: x, clientY: y, radiusX: 1, radiusY: 1, force: 0.5, target: target as Element });

        target.dispatchEvent(
            new TouchEvent('touchstart', {
                bubbles: true,
                cancelable: false,
                composed: true,
                touches: [makeTouch(sx, sy, 1)],
            }),
        );
        for (let i = 1; i <= steps; i += 1) {
            const t = i / steps;
            target.dispatchEvent(
                new TouchEvent('touchmove', {
                    bubbles: true,
                    cancelable: false,
                    composed: true,
                    touches: [makeTouch(sx + (ex - sx) * t, sy + (ey - sy) * t, 2)],
                }),
            );
        }
        target.dispatchEvent(
            new TouchEvent('touchend', {
                bubbles: true,
                cancelable: false,
                composed: true,
                changedTouches: [makeTouch(ex, ey, 3)],
                touches: [],
            }),
        );
    }, { sel: options.selector ?? null, sx: startX, sy: startY, ex: endX, ey: endY, steps });
}

/**
 * A swipe over the page itself. Its target is the document, which is inside neither the
 * chat scroll area nor an overlay — the area a gesture rule is written for.
 */
export function swipeOnDocument(page: Page, startX: number, startY: number, endX: number, endY: number): Promise<void> {
    return swipe(page, startX, startY, endX, endY);
}

/** A swipe whose touches land on a particular element, such as the chat area or an overlay. */
export function swipeOnElement(
    page: Page,
    selector: string,
    startX: number,
    startY: number,
    endX: number,
    endY: number,
): Promise<void> {
    return swipe(page, startX, startY, endX, endY, { selector });
}
