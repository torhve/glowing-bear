/**
 * The rules that turn a touch into a gesture, and the numbers they are measured in.
 *
 * These were five bare numbers inside `+page.svelte`'s touch handlers, three of them in
 * the same comparison and one declared inside the branch that used it. What a swipe is —
 * how far, how fast, which axis wins — is a rule with a boundary, and a boundary can only
 * be tested where it lives. The panel and overlay state a gesture causes stays in the page,
 * because those are the page's own state; this file decides only what the touch was.
 */

/** A horizontal drag this wide is a swipe in progress, so the browser must not scroll under it. */
const DRAG_BLOCK_DX = 10;

/** Horizontal travel a finished touch needs to count as a swipe left or right. */
export const SWIPE_MIN_DX = 50;

/** Vertical travel a finished touch needs to count as a swipe up or down. */
export const SWIPE_MIN_DY = 80;

/** Anything slower than this was a scroll the reader was performing, not a gesture. */
export const SWIPE_MAX_MS = 500;

/** The strip at the right edge whose swipe-left opens the nicklist overlay. */
export const RIGHT_EDGE_ZONE = 80;

export type SwipeDirection = 'right' | 'left' | 'up' | 'down';

/** Where and when a touch began, and what it landed on. */
export interface TouchOrigin {
    x: number;
    y: number;
    startedAt: number;
    /** The element the touch landed on, for whoever owns the regions it is inside. */
    target: Element | null;
    /** The touch began inside the mobile nicklist overlay, which swipes differently. */
    inNicklist: boolean;
}

export interface Swipe {
    direction: SwipeDirection;
    /**
     * The touch started inside {@link RIGHT_EDGE_ZONE} of the right edge. Only a swipe left
     * from there means "open the nicklist"; from anywhere else it means "put the buffer list
     * away".
     */
    fromRightEdge: boolean;
}

/** The untouched origin, which classifies as nothing: a touchend with no touchstart is not a gesture. */
export const NO_TOUCH: TouchOrigin = { x: 0, y: 0, startedAt: 0, target: null, inNicklist: false };

/** Record a touch at the moment it started, including whether it landed on the nicklist overlay. */
export function touchOrigin(touch: { clientX: number; clientY: number }, target: EventTarget | null, now: number): TouchOrigin {
    const element = target instanceof Element ? target : null;
    return {
        x: touch.clientX,
        y: touch.clientY,
        startedAt: now,
        target: element,
        inNicklist: !!element?.closest('.mobile-nicklist-overlay'),
    };
}

/**
 * Whether a moving touch is a horizontal drag rather than a scroll. Blocking the native
 * gesture is what keeps a horizontal swipe from scrolling or rubber-banding the page that
 * sits under the overlay being dragged.
 */
export function isHorizontalDrag(origin: TouchOrigin, x: number, y: number): boolean {
    const dx = Math.abs(x - origin.x);
    const dy = Math.abs(y - origin.y);
    return dx > dy && dx > DRAG_BLOCK_DX;
}

/**
 * What a finished touch was, or nothing.
 *
 * Both axes demand to be the dominant one, so a touch that moved equally far in both is
 * not a swipe in either direction, and a slow touch is never a gesture however far it went.
 * The comparison boundaries are strict on distance and exclusive on time: exactly
 * {@link SWIPE_MAX_MS} elapsed is too slow.
 */
export function classifySwipe(
    origin: TouchOrigin,
    x: number,
    y: number,
    now: number,
    viewportWidth: number,
): Swipe | null {
    const dx = x - origin.x;
    const dy = y - origin.y;
    if (now - origin.startedAt >= SWIPE_MAX_MS) return null;

    if (Math.abs(dx) > Math.abs(dy)) {
        if (Math.abs(dx) <= SWIPE_MIN_DX) return null;
        return {
            direction: dx > 0 ? 'right' : 'left',
            fromRightEdge: origin.x > viewportWidth - RIGHT_EDGE_ZONE,
        };
    }

    if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > SWIPE_MIN_DY) {
        return { direction: dy > 0 ? 'down' : 'up', fromRightEdge: false };
    }

    return null;
}
