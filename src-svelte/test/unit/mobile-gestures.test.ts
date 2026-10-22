/**
 * The swipe thresholds, measured at the boundary.
 *
 * These numbers used to be written inline in the page's touch handlers, where nothing could
 * reach them: a mobile swipe is a gesture or it is a scroll, and the difference is a
 * comparison. Every expectation here is one step either side of a constant, so moving a
 * constant moves a test rather than changing what a reader's finger does unnoticed.
 */
import { describe, expect, it } from 'vitest';
import {
    classifySwipe,
    isHorizontalDrag,
    NO_TOUCH,
    RIGHT_EDGE_ZONE,
    SWIPE_MAX_MS,
    SWIPE_MIN_DX,
    SWIPE_MIN_DY,
    touchOrigin,
    type TouchOrigin,
} from '#lib/mobileGestures.ts';

function originAt(x: number, y = 200, startedAt = 0): TouchOrigin {
    return { x, y, startedAt, target: null, inNicklist: false };
}

describe('what a finished touch was', () => {
    it('needs the horizontal threshold crossed, not merely reached', () => {
        expect(classifySwipe(originAt(100, 200), 100 + SWIPE_MIN_DX, 200, 100, 375)).toBeNull();
        expect(classifySwipe(originAt(100, 200), 100 + SWIPE_MIN_DX + 1, 200, 100, 375)?.direction).toBe('right');
    });

    it('reads a left swipe from the sign, not the magnitude', () => {
        expect(classifySwipe(originAt(100, 200), 100 - SWIPE_MIN_DX - 1, 200, 100, 375)?.direction).toBe('left');
    });

    it('needs the vertical threshold crossed, not merely reached', () => {
        expect(classifySwipe(originAt(100, 200), 100, 200 + SWIPE_MIN_DY, 100, 375)).toBeNull();
        expect(classifySwipe(originAt(100, 200), 100, 200 + SWIPE_MIN_DY + 1, 100, 375)?.direction).toBe('down');
        expect(classifySwipe(originAt(100, 200), 100, 200 - SWIPE_MIN_DY - 1, 100, 375)?.direction).toBe('up');
    });

    it('gives the axis with more travel, and nothing when the travel is equal', () => {
        // Diagonal motions are a scroll with drift or a swipe with drift; whichever axis
        // moved further is the one the reader meant.
        expect(classifySwipe(originAt(100, 200), 100 + 60, 200 - 90, 100, 375)?.direction).toBe('up');
        expect(classifySwipe(originAt(100, 200), 100 + 90, 200 - 60, 100, 375)?.direction).toBe('right');
        expect(classifySwipe(originAt(100, 200), 100 + 100, 200 - 100, 100, 375)).toBeNull();
    });

    it('refuses a slow touch however far it travelled', () => {
        // Exactly the limit is too slow: the reader was scrolling, not gesturing.
        expect(classifySwipe(originAt(100, 200, 1000), 100 + 200, 200, 1000 + SWIPE_MAX_MS - 1, 375)?.direction).toBe('right');
        expect(classifySwipe(originAt(100, 200, 1000), 100 + 200, 200, 1000 + SWIPE_MAX_MS, 375)).toBeNull();
        expect(classifySwipe(originAt(100, 200, 1000), 100, 200 + 200, 1000 + SWIPE_MAX_MS + 1, 375)).toBeNull();
    });

    it('treats a touchend with no touchstart as no gesture', () => {
        // The untouched origin starts at 0, so an enormous elapsed time is what refuses it —
        // a stray touchend must not jump the reader to another buffer.
        expect(classifySwipe(NO_TOUCH, 300, 400, Date.now(), 375)).toBeNull();
    });

    it('marks a left swipe as coming from the right-edge strip, where it opens the nicklist', () => {
        const viewport = 375;
        // The strip is the last RIGHT_EDGE_ZONE pixels, and its inner boundary belongs to
        // the rest of the screen.
        expect(classifySwipe(originAt(viewport - RIGHT_EDGE_ZONE), viewport - RIGHT_EDGE_ZONE - 60, 200, 100, viewport)?.fromRightEdge).toBe(false);
        expect(classifySwipe(originAt(viewport - RIGHT_EDGE_ZONE + 1), viewport - RIGHT_EDGE_ZONE - 60, 200, 100, viewport)?.fromRightEdge).toBe(true);
        expect(classifySwipe(originAt(40), 40 - 60, 200, 100, viewport)?.fromRightEdge).toBe(false);
    });
});

describe('what a moving touch blocks', () => {
    it('blocks a horizontal drag past its threshold and not a scroll', () => {
        expect(isHorizontalDrag(originAt(100, 200), 100 + 10, 200)).toBe(false);
        expect(isHorizontalDrag(originAt(100, 200), 100 + 11, 200)).toBe(true);
        expect(isHorizontalDrag(originAt(100, 200), 100 + 11, 200 + 12)).toBe(false);
        expect(isHorizontalDrag(originAt(100, 200), 100, 200 + 200)).toBe(false);
    });
});

describe('where a touch began', () => {
    it('recognises the nicklist overlay from the element it landed on', () => {
        const overlay = document.createElement('div');
        overlay.className = 'mobile-nicklist-overlay';
        const inside = document.createElement('span');
        overlay.appendChild(inside);
        const elsewhere = document.createElement('div');
        document.body.append(overlay, elsewhere);

        const onOverlay = touchOrigin({ clientX: 10, clientY: 10 }, inside, 1000);
        expect(onOverlay.inNicklist).toBe(true);
        expect(onOverlay.target).toBe(inside);

        expect(touchOrigin({ clientX: 10, clientY: 10 }, elsewhere, 1000).inNicklist).toBe(false);
        expect(touchOrigin({ clientX: 10, clientY: 10 }, overlay, 1000).inNicklist).toBe(true);
    });

    it('records no element for a touch whose target is not one', () => {
        // Document-level swipes report the document, which is not an element and therefore
        // sits inside neither overlay nor chat area.
        const onDocument = touchOrigin({ clientX: 10, clientY: 10 }, document, 1000);
        expect(onDocument.target).toBeNull();
        expect(onDocument.inNicklist).toBe(false);
        expect(onDocument.x).toBe(10);
        expect(onDocument.startedAt).toBe(1000);
    });
});
