import { beforeEach, expect, it } from 'vitest';
import {
    ChatViewport,
    FOLLOW_SETTLE_MS,
    PAGE_SCROLL_RATIO,
    PIN_CAP_MS,
    PIN_SETTLE_FRAMES,
    READMARKER_VIEWPORT_RATIO,
    SCROLL_BOTTOM_TOLERANCE,
    VISIBLE_LINES_HEADROOM,
} from '#lib/chatViewport.ts';
import type { ChatContentSnapshot, ChatRect, ChatViewportAdapter } from '#lib/chatViewport.ts';

/**
 * Deterministic harness for the viewport controller.
 *
 * Geometry, frames and the clock are all explicit, so a test states the layout
 * it cares about and then runs exactly the frames the controller asked for.
 * Nothing here waits on wall time, which is what makes the pin-loop, settle
 * window and operation-token rules observable instead of timing-dependent.
 */

const VIEWPORT_HEIGHT = 400;

class FakeAdapter implements ChatViewportAdapter {
    scrollTop = 0;
    scrollHeight = 1000;
    clientHeight = VIEWPORT_HEIGHT;
    /** The read separator's viewport-relative box, or null when it is not rendered. */
    marker: ChatRect | null = null;
    sampleLineHeight: number | null = 20;
    containerRect: ChatRect = { top: 0, bottom: VIEWPORT_HEIGHT, height: VIEWPORT_HEIGHT };
    /** Every scroll position the controller wrote, in order. */
    writes: number[] = [];

    getScrollTop = () => this.scrollTop;
    getScrollHeight = () => this.scrollHeight;
    getClientHeight = () => this.clientHeight;
    setScrollTop = (value: number) => {
        this.writes.push(value);
        this.scrollTop = value;
    };
    getContainerRect = () => this.containerRect;
    getReadMarkerRect = () => this.marker;
    getSampleLineHeight = () => this.sampleLineHeight;

    /** Move the viewport the way a reader would; not an application write. */
    readerScrollTo(value: number): void {
        this.scrollTop = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight));
    }

    get maxScroll(): number {
        return this.scrollHeight - this.clientHeight;
    }
}

class FakeFrames {
    private handles = new Map<number, () => void>();
    private nextHandle = 1;

    schedule = (callback: () => void): number => {
        const handle = this.nextHandle++;
        this.handles.set(handle, callback);
        return handle;
    };

    cancel = (handle: number): void => {
        this.handles.delete(handle);
    };

    get pending(): number {
        return this.handles.size;
    }

    /** Run every frame queued so far. Frames queued by that run fire in the next round. */
    flush(): number {
        const batch = [...this.handles.values()];
        this.handles.clear();
        for (const run of batch) run();
        return batch.length;
    }

    /** Run frames until the controller stops asking for more. Returns the round count. */
    settle(maxRounds = 40): number {
        let rounds = 0;
        while (this.pending > 0 && rounds < maxRounds) {
            this.flush();
            rounds++;
        }
        return rounds;
    }
}

class FakeClock {
    private ms = 10_000;
    now = (): number => this.ms;
    advance(delta: number): void {
        this.ms += delta;
    }
}

interface Harness {
    viewport: ChatViewport;
    adapter: FakeAdapter;
    frames: FakeFrames;
    clock: FakeClock;
    followIntents: boolean[];
    estimates: number[];
    busy: boolean[];
    reachTop: boolean[];
    /** Render one snapshot and run every frame it schedules. */
    render: (snapshot: ChatContentSnapshot) => void;
}

function harness(): Harness {
    const adapter = new FakeAdapter();
    const frames = new FakeFrames();
    const clock = new FakeClock();
    const followIntents: boolean[] = [];
    const estimates: number[] = [];
    const busy: boolean[] = [];
    const reachTop: boolean[] = [];
    const viewport = new ChatViewport({
        scheduleFrame: frames.schedule,
        cancelFrame: frames.cancel,
        now: clock.now,
        onFollowIntent: (atBottom) => followIntents.push(atBottom),
        onVisibleLinesEstimate: (numLines) => estimates.push(numLines),
        onHistoryBusy: (isBusy) => busy.push(isBusy),
        onReachTop: (force) => reachTop.push(force),
    });
    const render = (snapshot: ChatContentSnapshot) => {
        viewport.contentChanged(snapshot);
        frames.settle();
    };
    return { viewport, adapter, frames, clock, followIntents, estimates, busy, reachTop, render };
}

/** A distinct tail object per call: identity is what proves the tail moved. */
let tail = 0;
function newTail(): { id: number } {
    return { id: ++tail };
}

function content(overrides: Partial<ChatContentSnapshot> = {}): ChatContentSnapshot {
    return {
        bufferId: 'channel-a',
        lineCount: 20,
        tailRef: newTail(),
        hasUnread: false,
        readBoundaryKnown: true,
        ...overrides,
    };
}

/** Attach a mounted view and render its first content. */
function mounted(overrides: Partial<ChatContentSnapshot> = {}): Harness {
    const h = harness();
    h.viewport.attach(content().bufferId, h.adapter);
    h.render(content(overrides));
    h.adapter.writes.length = 0;
    return h;
}

beforeEach(() => {
    tail = 0;
});

// ---------------------------------------------------------------------------
// Entry placement
// ---------------------------------------------------------------------------

it('places a buffer with no unread at the bottom and follows it', () => {
    const h = mounted();
    expect(h.adapter.scrollTop).toBe(h.adapter.maxScroll);
    expect(h.viewport.snapshot().mode).toBe('following');
    expect(h.followIntents).toContain(true);
});

it('places a buffer whose unread overflow the viewport at the read separator', () => {
    const h = harness();
    h.adapter.scrollHeight = 3000;
    h.adapter.marker = { top: 1200, bottom: 1220, height: 20 };
    h.viewport.attach('channel-a', h.adapter);
    h.render(content({ hasUnread: true }));

    const targetY = h.adapter.containerRect.top + VIEWPORT_HEIGHT * READMARKER_VIEWPORT_RATIO;
    expect(h.adapter.scrollTop).toBe(1200 - targetY);
    expect(h.viewport.snapshot().mode).toBe('reading');
});

it('takes the tail when the separator and everything below it already fit', () => {
    const h = harness();
    h.adapter.scrollHeight = 500;
    h.adapter.scrollTop = 100; // where the render left the view
    h.adapter.marker = { top: 120, bottom: 140, height: 20 };
    h.viewport.attach('channel-a', h.adapter);
    h.render(content({ hasUnread: true }));

    expect(h.adapter.scrollTop).toBe(h.adapter.maxScroll);
    expect(h.viewport.snapshot().mode).toBe('following');
});

it('bounds read-separator failures and falls back to the tail', () => {
    const h = harness();
    h.adapter.marker = null;
    h.viewport.attach('channel-a', h.adapter);

    // Each entry into a buffer whose separator is not measurable records one
    // failure, and the reader is left where the render put them.
    for (const bufferId of ['channel-a', 'channel-b']) {
        h.render(content({ bufferId, hasUnread: true }));
        expect(h.viewport.snapshot().mode).toBe('reading');
        expect(h.adapter.scrollTop).toBe(0);
    }

    // The cap is reached: the next entry gets the tail rather than a viewport
    // that was never placed.
    h.render(content({ bufferId: 'channel-c', hasUnread: true }));
    expect(h.adapter.scrollTop).toBe(h.adapter.maxScroll);
    expect(h.viewport.snapshot().mode).toBe('following');
});

it('uses the separator on the next entry once it becomes measurable', () => {
    const h = harness();
    h.adapter.scrollHeight = 3000;
    h.adapter.marker = null;
    h.viewport.attach('channel-a', h.adapter);
    h.render(content({ hasUnread: true }));
    expect(h.adapter.scrollTop).toBe(0);

    // Delayed render: the marker row appears, and the next entry uses it.
    h.adapter.marker = { top: 1200, bottom: 1220, height: 20 };
    h.render(content({ bufferId: 'channel-b', hasUnread: true }));
    expect(h.adapter.scrollTop).toBe(1200 - VIEWPORT_HEIGHT * READMARKER_VIEWPORT_RATIO);
});

// ---------------------------------------------------------------------------
// Live tail
// ---------------------------------------------------------------------------

it('pins the tail when a line arrives in the buffer being viewed', () => {
    const h = mounted();
    h.adapter.scrollHeight = 1200;
    h.render(content());
    expect(h.adapter.scrollTop).toBe(1200 - VIEWPORT_HEIGHT);
});

it('follows at the line cap, where the row count never grows', () => {
    const h = mounted({ lineCount: 500 });
    h.adapter.writes.length = 0;
    // Same length, different tail object: the cap trimmed one row and appended one.
    h.render(content({ lineCount: 500 }));
    expect(h.adapter.writes.length).toBeGreaterThan(0);
    expect(h.viewport.snapshot().mode).toBe('following');
});

it('leaves a reader who scrolled away where they parked', () => {
    const h = mounted();
    h.clock.advance(FOLLOW_SETTLE_MS + 1);
    h.adapter.readerScrollTo(100);
    h.viewport.handleScroll();
    h.adapter.writes.length = 0;

    h.render(content());
    expect(h.adapter.writes).toEqual([]);
    expect(h.adapter.scrollTop).toBe(100);
    expect(h.viewport.snapshot().mode).toBe('reading');
});

it('treats a scroll event right after entry placement as layout, not as leaving', () => {
    const h = mounted();
    // Entry placement wrote the viewport; the reflow it triggers reports a
    // position above the bottom. That is not the reader choosing to leave.
    h.adapter.readerScrollTo(h.adapter.maxScroll - 60);
    h.viewport.handleScroll();
    expect(h.viewport.snapshot().mode).toBe('following');

    h.adapter.writes.length = 0;
    h.render(content());
    expect(h.adapter.scrollTop).toBe(h.adapter.maxScroll);
});

it('releases a pin loop whose layout never stabilises', () => {
    const h = mounted();
    h.adapter.writes.length = 0;
    h.adapter.scrollHeight = 1400;
    h.viewport.contentChanged(content());
    h.frames.flush(); // first pin

    // A line that keeps re-wrapping: scrollHeight changes on every frame, so the
    // stability exit never fires and only the cap can end the sequence.
    for (let frame = 0; frame < 8 && h.viewport.snapshot().pinning; frame++) {
        h.adapter.scrollHeight = 1400 + (frame + 1) * 10;
        h.frames.flush();
        h.clock.advance(60);
    }

    expect(h.viewport.snapshot().pinning).toBe(false);
    expect(h.viewport.snapshot().pending).toBe('none');
    expect(h.clock.now()).toBeLessThan(10_000 + PIN_CAP_MS + 8 * 60);
});

it('settles the pin loop after stable frames and stops scheduling', () => {
    const h = mounted();
    h.adapter.writes.length = 0;
    h.adapter.scrollHeight = 1400;

    // One arrival: the loop re-pins until scrollHeight is stable for
    // PIN_SETTLE_FRAMES frames, then releases the view.
    h.render(content());
    expect(h.frames.pending).toBe(0);
    expect(h.viewport.snapshot().pinning).toBe(false);
    expect(h.viewport.snapshot().pending).toBe('none');
    // One pin plus one pin per unsettled frame.
    expect(h.adapter.writes.length).toBe(1 + PIN_SETTLE_FRAMES);
});

it('keeps a flood on one pipeline instead of nesting pin loops', () => {
    const h = mounted();
    let maxOutstanding = 0;
    for (let i = 0; i < 12; i++) {
        h.adapter.scrollHeight = 1200 + i * 40;
        h.viewport.contentChanged(content());
        maxOutstanding = Math.max(maxOutstanding, h.frames.pending);
        h.frames.flush();
        maxOutstanding = Math.max(maxOutstanding, h.frames.pending);
    }
    h.frames.settle();

    // A single drain frame at a time, and one loop rather than twelve.
    expect(maxOutstanding).toBe(1);
    expect(h.viewport.snapshot().pinning).toBe(false);
    expect(h.viewport.snapshot().pending).toBe('none');
    expect(h.adapter.scrollTop).toBe(h.adapter.maxScroll);
});

// ---------------------------------------------------------------------------
// Reader intent
// ---------------------------------------------------------------------------

it('deliberate navigation cancels an in-flight pin and keeps the reader position', () => {
    const h = mounted();
    h.adapter.writes.length = 0;
    h.adapter.scrollHeight = 1600;
    h.viewport.contentChanged(content());
    h.frames.flush(); // one pin has run; the loop is still re-anchoring
    expect(h.viewport.snapshot().pinning).toBe(true);

    // The reader scrolls away while the pin loop is mid-flight. No settle wait.
    h.adapter.readerScrollTo(200);
    h.viewport.noteNavigation('wheel');
    h.frames.settle();

    expect(h.viewport.snapshot().pinning).toBe(false);
    expect(h.adapter.scrollTop).toBe(200);
    expect(h.viewport.snapshot().mode).toBe('reading');
});

it('does not treat a layout-generated scroll event as intent during the settle window', () => {
    const h = mounted();
    h.adapter.writes.length = 0;
    h.adapter.scrollHeight = 1600;
    h.viewport.contentChanged(content());
    h.frames.flush();
    expect(h.viewport.snapshot().pinning).toBe(true);

    // A transient reflow reports a position above the bottom, still inside the
    // follow-settle window. It must not end following.
    h.adapter.readerScrollTo(h.adapter.maxScroll - 60);
    h.viewport.handleScroll();
    expect(h.viewport.snapshot().mode).toBe('following');

    h.frames.settle();
    expect(h.adapter.scrollTop).toBe(h.adapter.maxScroll);
});

it('ends following when a scroll event arrives outside the settle window', () => {
    const h = mounted();
    h.clock.advance(FOLLOW_SETTLE_MS + 1);
    h.adapter.readerScrollTo(150);
    h.viewport.handleScroll();
    expect(h.viewport.snapshot().mode).toBe('reading');
});

it('resumes following when the reader reaches the bottom again', () => {
    const h = mounted();
    h.clock.advance(FOLLOW_SETTLE_MS + 1);
    h.adapter.readerScrollTo(150);
    h.viewport.handleScroll();
    expect(h.viewport.snapshot().mode).toBe('reading');

    h.adapter.readerScrollTo(h.adapter.maxScroll - SCROLL_BOTTOM_TOLERANCE);
    h.viewport.handleScroll();
    expect(h.viewport.snapshot().mode).toBe('following');
});

it('ignores a gesture in a direction this viewport cannot move', () => {
    const h = mounted();
    // Already at the bottom: wheeling further down is not a reader choosing a position.
    expect(h.viewport.canScrollToward(1)).toBe(false);
    expect(h.viewport.canScrollToward(-1)).toBe(true);

    h.adapter.readerScrollTo(0);
    h.viewport.handleScroll();
    expect(h.viewport.canScrollToward(-1)).toBe(false);
    expect(h.viewport.canScrollToward(1)).toBe(true);
});

it('steps PageUp/PageDown by one viewport fraction and records it as intent', () => {
    const h = mounted();
    const before = h.adapter.scrollTop;
    const interactionBefore = h.viewport.snapshot().interaction;

    expect(h.viewport.requestPageScroll(-1)).toBe(true);
    expect(h.adapter.scrollTop).toBe(before - VIEWPORT_HEIGHT * PAGE_SCROLL_RATIO);
    expect(h.viewport.snapshot().interaction).toBeGreaterThan(interactionBefore);

    expect(h.viewport.requestPageScroll(1)).toBe(true);
    expect(h.adapter.scrollTop).toBe(before);
});

it('refuses page scroll when no view owns a viewport', () => {
    const h = harness();
    expect(h.viewport.requestPageScroll(-1)).toBe(false);
});

// ---------------------------------------------------------------------------
// History operation
// ---------------------------------------------------------------------------

it('requests older lines when the reader reaches the top', () => {
    const h = mounted();
    h.adapter.readerScrollTo(10);
    h.viewport.handleScroll();
    expect(h.reachTop).toEqual([false]);
});

it('keeps the reader offset from the bottom across a prepend', () => {
    const h = mounted();
    h.clock.advance(FOLLOW_SETTLE_MS + 1);
    h.adapter.readerScrollTo(0);
    h.viewport.handleScroll();
    expect(h.reachTop).toHaveLength(1);
    expect(h.viewport.snapshot().mode).toBe('reading');

    const token = h.viewport.beginHistory(false)!;
    expect(h.viewport.snapshot().historyPending).toBe(true);
    expect(h.busy).toContain(true);

    // The prepend grows the content above the reader.
    h.adapter.scrollHeight = 2000;
    h.viewport.finishHistory(token, { preserveScroll: true, prependedNothing: false });
    // Busy until the restore has actually run.
    expect(h.viewport.snapshot().historyPending).toBe(true);
    h.frames.settle();

    // The reader was 600px from the bottom; the prepend grows the content above
    // them, so the restore puts them 600px from the new bottom.
    expect(h.adapter.scrollTop).toBe(2000 - VIEWPORT_HEIGHT - 600);
    expect(h.viewport.snapshot().historyPending).toBe(false);
    expect(h.busy[h.busy.length - 1]).toBe(false);
});

it('does not restore over a navigation the reader made during the request', () => {
    const h = mounted();
    h.clock.advance(FOLLOW_SETTLE_MS + 1);
    h.adapter.readerScrollTo(0);
    h.viewport.handleScroll();

    const token = h.viewport.beginHistory(false)!;
    // The reader starts reading forward while the request is in flight.
    h.adapter.readerScrollTo(600);
    h.viewport.noteNavigation('keyboard');
    h.adapter.writes.length = 0;

    h.adapter.scrollHeight = 2000;
    h.viewport.finishHistory(token, { preserveScroll: true, prependedNothing: false });
    h.frames.settle();

    expect(h.adapter.writes).toEqual([]);
    expect(h.adapter.scrollTop).toBe(600);
    expect(h.viewport.snapshot().historyPending).toBe(false);
});

it('keeps the busy flag until a queued restore has run, then clears it', () => {
    const h = mounted();
    const token = h.viewport.beginHistory(true)!;
    h.viewport.finishHistory(token, { preserveScroll: false, prependedNothing: false });
    expect(h.busy).toEqual([true, false]);
    expect(h.viewport.snapshot().historyPending).toBe(false);
});

it('stops auto-fetching a buffer whose top is exhausted, but not the explicit button', () => {
    const h = mounted();
    h.clock.advance(FOLLOW_SETTLE_MS + 1);

    // Reaching the top asks for older lines, and the answer says there are none.
    h.adapter.readerScrollTo(0);
    h.viewport.handleScroll();
    expect(h.reachTop).toEqual([false]);

    const token = h.viewport.beginHistory(false)!;
    h.viewport.finishHistory(token, { preserveScroll: true, prependedNothing: true });

    // Scrolling to the top again must not repeat a request that was exhausted.
    h.adapter.writes.length = 0;
    h.adapter.readerScrollTo(0);
    h.viewport.handleScroll();
    expect(h.reachTop).toEqual([false]);

    // Pressing the button is a different intent and bypasses the memo.
    h.viewport.requestHistoryNow();
    expect(h.reachTop).toEqual([false, true]);
});

it('refuses a second request while one is in flight', () => {
    const h = mounted();
    expect(h.viewport.beginHistory(false)).not.toBeNull();
    expect(h.viewport.beginHistory(false)).toBeNull();
    expect(h.viewport.beginHistory(true)).toBeNull();
});

it('drops a completion from a superseded visit without clearing the newer request', () => {
    const h = mounted();
    const oldToken = h.viewport.beginHistory(false)!;

    // A → B → A: returning to the buffer is a new visit with its own request.
    h.viewport.attach('channel-b', h.adapter);
    h.render(content({ bufferId: 'channel-b' }));
    const newToken = h.viewport.beginHistory(false)!;

    h.viewport.finishHistory(oldToken, { preserveScroll: true, prependedNothing: false });
    expect(h.viewport.snapshot().historyPending).toBe(true);

    // The old token must not unlock a newer request either.
    h.viewport.finishHistory(oldToken, { preserveScroll: true, prependedNothing: true });
    expect(h.viewport.beginHistory(false)).toBeNull();

    h.viewport.finishHistory(newToken, { preserveScroll: true, prependedNothing: false });
    h.frames.settle();
    expect(h.viewport.snapshot().historyPending).toBe(false);
});

it('clears a cancelled restore so a later request for the same buffer is possible', () => {
    const h = mounted();
    const token = h.viewport.beginHistory(false)!;
    h.viewport.finishHistory(token, { preserveScroll: true, prependedNothing: false });
    expect(h.viewport.snapshot().historyPending).toBe(true);

    // The reader navigates before the restore frame runs.
    h.viewport.noteNavigation('wheel');
    expect(h.viewport.snapshot().historyPending).toBe(false);
    expect(h.busy[h.busy.length - 1]).toBe(false);
    expect(h.viewport.beginHistory(false)).not.toBeNull();
});

it('ends the history operation when the view detaches', () => {
    const h = mounted();
    h.viewport.beginHistory(false);
    h.viewport.detach();
    expect(h.viewport.snapshot().historyPending).toBe(false);
    expect(h.busy[h.busy.length - 1]).toBe(false);
});

// ---------------------------------------------------------------------------
// Layout, measurement and lifetime
// ---------------------------------------------------------------------------

it('estimates visible rows from container geometry with headroom', () => {
    const h = mounted();
    expect(h.estimates).toContain(Math.ceil(VIEWPORT_HEIGHT / 20 + VISIBLE_LINES_HEADROOM));
});

it('re-estimates rows on resize and keeps a following view pinned', () => {
    const h = mounted();
    h.estimates.length = 0;
    h.adapter.clientHeight = 800;
    h.adapter.scrollHeight = 2000;
    h.viewport.notifyLayoutChanged();
    h.frames.settle();

    expect(h.estimates).toContain(Math.ceil(800 / 20 + VISIBLE_LINES_HEADROOM));
    expect(h.adapter.scrollTop).toBe(2000 - 800);
});

it('re-estimates rows on resize without moving a reading view', () => {
    const h = mounted();
    h.clock.advance(FOLLOW_SETTLE_MS + 1);
    h.adapter.readerScrollTo(120);
    h.viewport.handleScroll();
    h.adapter.writes.length = 0;

    h.adapter.clientHeight = 800;
    h.viewport.notifyLayoutChanged();
    h.frames.settle();

    expect(h.adapter.writes).toEqual([]);
    expect(h.adapter.scrollTop).toBe(120);
});

it('cancels queued frames and the pin loop on detach', () => {
    const h = mounted();
    h.adapter.scrollHeight = 1600;
    h.viewport.contentChanged(content());
    h.frames.flush();
    expect(h.viewport.snapshot().pinning).toBe(true);

    h.viewport.detach();
    expect(h.viewport.snapshot().pinning).toBe(false);
    expect(h.frames.pending).toBe(0);

    // Nothing queued may run afterwards.
    h.adapter.writes.length = 0;
    h.frames.settle();
    expect(h.adapter.writes).toEqual([]);
});

it('starts a fresh visit when the same buffer is re-attached', () => {
    const h = mounted();
    const visitBefore = h.viewport.snapshot().visit;
    h.viewport.detach();
    h.viewport.attach('channel-a', h.adapter);
    expect(h.viewport.snapshot().visit).toBe(visitBefore + 2);
    expect(h.viewport.snapshot().pending).toBe('none');
});

it('stops scheduling entirely after disposal', () => {
    const h = mounted();
    h.viewport.dispose();
    h.viewport.contentChanged(content());
    h.viewport.notifyLayoutChanged();
    h.viewport.noteNavigation('wheel');
    expect(h.frames.pending).toBe(0);
    expect(h.viewport.snapshot().pending).toBe('none');
    expect(h.viewport.beginHistory(true)).toBeNull();
});

it('reports the work actually pending in the diagnostic snapshot', () => {
    const h = harness();
    expect(h.viewport.snapshot().pending).toBe('none');
    expect(h.viewport.snapshot().pinning).toBe(false);
    expect(h.viewport.snapshot().pendingFrames).toBe(0);

    h.viewport.attach('channel-a', h.adapter);
    h.viewport.contentChanged(content());
    // Two queued tasks plus the one drain frame that will run them.
    expect(h.viewport.snapshot().pendingFrames).toBe(3);
    expect(h.viewport.snapshot().pending).toBe('measure');

    h.frames.flush(); // measurement and entry placement
    expect(h.viewport.snapshot().pending).toBe('none');
    expect(h.viewport.snapshot().settlingUntil).toBeGreaterThanOrEqual(h.clock.now());

    // A live-tail arrival arms a pin loop, which the diagnostic must show.
    h.adapter.scrollHeight = 1200;
    h.viewport.contentChanged(content());
    h.frames.flush(); // measurement, then the live-tail decision
    expect(h.viewport.snapshot().pinning).toBe(true);
    expect(h.viewport.snapshot().pending).toBe('follow-pin');
    h.frames.settle();
    expect(h.viewport.snapshot().pinning).toBe(false);
    expect(h.viewport.snapshot().pending).toBe('none');
});

it('publishes follow intent through the single adapter path', () => {
    const h = mounted();
    h.clock.advance(FOLLOW_SETTLE_MS + 1);
    h.adapter.readerScrollTo(10);
    h.viewport.handleScroll();
    expect(h.followIntents[h.followIntents.length - 1]).toBe(false);
    expect(h.viewport.snapshot().mode).toBe('reading');
});

it('ignores a layout notification before the visit has reported content', () => {
    const h = harness();
    h.viewport.attach('channel-a', h.adapter);
    // Attaching an observer reports the observed size immediately. That is not a
    // layout change with content behind it, and must not schedule a pin.
    h.viewport.notifyLayoutChanged();
    h.viewport.notifyVisibilityRestored();
    expect(h.frames.pending).toBe(0);
    expect(h.viewport.snapshot().pinning).toBe(false);
    expect(h.estimates).toEqual([]);
});

it('re-measures on visibility restoration without moving a reading view', () => {
    const h = mounted();
    h.clock.advance(FOLLOW_SETTLE_MS + 1);
    h.adapter.readerScrollTo(120);
    h.viewport.handleScroll();
    h.estimates.length = 0;
    h.adapter.writes.length = 0;

    // The view was resized while it was away, so the estimate is genuinely stale.
    h.adapter.clientHeight = 800;
    h.viewport.notifyVisibilityRestored();
    h.frames.settle();

    expect(h.estimates).toContain(Math.ceil(800 / 20 + VISIBLE_LINES_HEADROOM));
    expect(h.adapter.writes).toEqual([]);
    expect(h.viewport.snapshot().mode).toBe('reading');
});

it('does not republish an unchanged row estimate', () => {
    const h = mounted();
    h.estimates.length = 0;
    // The same geometry reported again is not new information, and publishing it
    // would re-derive the retained row cap and resize the content the observer is
    // already watching.
    h.viewport.notifyLayoutChanged();
    h.viewport.notifyLayoutChanged();
    h.frames.settle();
    expect(h.estimates).toEqual([]);

    h.adapter.clientHeight = 800;
    h.viewport.notifyLayoutChanged();
    h.frames.settle();
    expect(h.estimates).toEqual([Math.ceil(800 / 20 + VISIBLE_LINES_HEADROOM)]);
});

it('does not arm a second pin loop from a layout notification during a pin', () => {
    const h = mounted();
    h.adapter.scrollHeight = 1600;
    h.viewport.contentChanged(content());
    h.frames.flush();
    expect(h.viewport.snapshot().pinning).toBe(true);

    // The pin's own write reflows the view and the observer reports it. Reacting
    // with another loop is how an observer never goes idle.
    h.viewport.notifyLayoutChanged();
    h.viewport.notifyLayoutChanged();
    const framesBefore = h.frames.pending;
    h.frames.settle();
    expect(h.viewport.snapshot().pinning).toBe(false);
    expect(h.frames.pending).toBe(0);
    expect(framesBefore).toBeGreaterThan(0);
});

it('drops stale pin work on visibility restoration and re-anchors from current geometry', () => {
    const h = mounted();
    h.adapter.writes.length = 0;
    h.adapter.scrollHeight = 1600;
    h.viewport.contentChanged(content());
    h.frames.flush();
    expect(h.viewport.snapshot().pinning).toBe(true);

    // The loop that was mid-flight is dropped rather than left queued, and the
    // view is re-anchored from the geometry it has now, not the geometry it had
    // when the view went away.
    h.viewport.notifyVisibilityRestored();
    expect(h.viewport.snapshot().pending).toBe('follow-pin');
    h.frames.settle();
    expect(h.viewport.snapshot().pinning).toBe(false);
    expect(h.adapter.scrollTop).toBe(h.adapter.maxScroll);
});

it('re-anchors a following view on visibility restoration', () => {
    const h = mounted();
    h.adapter.writes.length = 0;
    h.adapter.scrollHeight = 1600;
    h.viewport.notifyVisibilityRestored();
    h.frames.settle();
    expect(h.adapter.scrollTop).toBe(h.adapter.maxScroll);
});

it('releases a pin loop when the view stops following', () => {
    const h = mounted();
    h.adapter.scrollHeight = 1600;
    h.viewport.contentChanged(content());
    h.frames.flush();
    expect(h.viewport.snapshot().pinning).toBe(true);

    // A scroll event outside the settle window is the reader leaving. It ends
    // following without cancelling the loop, so the loop has to notice its own
    // reason is gone instead of pinning a viewport they left.
    h.clock.advance(FOLLOW_SETTLE_MS + 1);
    h.adapter.readerScrollTo(300);
    h.viewport.handleScroll();
    expect(h.viewport.snapshot().mode).toBe('reading');
    expect(h.viewport.snapshot().pinning).toBe(true);
    h.adapter.writes.length = 0;
    h.frames.settle();
    expect(h.adapter.writes).toEqual([]);
    expect(h.viewport.snapshot().pinning).toBe(false);
    expect(h.adapter.scrollTop).toBe(300);
});
// ---------------------------------------------------------------------------
// Nothing to place
// ---------------------------------------------------------------------------

it('does nothing when a visit has no rendered content', () => {
    const h = harness();
    // A buffer with no lines renders an empty content root: nothing to scroll.
    h.adapter.scrollHeight = h.adapter.clientHeight;
    h.adapter.sampleLineHeight = null;
    h.viewport.attach('channel-a', h.adapter);
    h.render(content({ lineCount: 0 }));
    h.frames.settle();

    expect(h.adapter.scrollTop).toBe(0);
    expect(h.viewport.snapshot().pinActivations).toBe(0);
    expect(h.viewport.snapshot().pendingFrames).toBe(0);
    expect(h.viewport.snapshot().pending).toBe('none');
});

it('does not invent a scroll for a layout change on a visit with no content', () => {
    const h = harness();
    h.adapter.scrollHeight = h.adapter.clientHeight;
    h.viewport.attach('channel-a', h.adapter);
    h.render(content({ lineCount: 0 }));
    h.frames.settle();
    h.adapter.writes.length = 0;

    h.viewport.notifyLayoutChanged();
    h.viewport.notifyVisibilityRestored();
    h.frames.settle();

    expect(h.adapter.writes).toEqual([]);
    expect(h.viewport.snapshot().pinActivations).toBe(0);
});

it('still estimates rows when no rendered row is measurable', () => {
    const h = harness();
    // A layout with no row of the sampled kind (bubble mode has no table row) falls
    // back to a nominal line height rather than skipping the estimate entirely.
    h.adapter.sampleLineHeight = null;
    h.viewport.attach('channel-a', h.adapter);
    h.render(content());
    h.frames.settle();

    expect(h.estimates).toContain(Math.ceil(VIEWPORT_HEIGHT / 16 + VISIBLE_LINES_HEADROOM));
});

it('keeps a view following when navigation leaves it at the tail', () => {
    const h = mounted();

    // A reader who wheels to the very end is following again, even though the
    // navigation itself first put the view in reading mode.
    h.adapter.scrollTop = h.adapter.scrollHeight - h.adapter.clientHeight;
    h.viewport.noteNavigation('wheel');
    expect(h.viewport.snapshot().mode).toBe('reading');

    h.adapter.scrollTop = h.adapter.scrollHeight - h.adapter.clientHeight;
    h.viewport.handleScroll();
    expect(h.viewport.snapshot().mode).toBe('following');
});

it('does not let the settle window hand a parked reader back to the pin', () => {
    const h = mounted();

    // The exact sequence a wheel produces: the gesture is seen while the container
    // is still at the tail, and only afterwards does it scroll. The follow-settle
    // window is wide open from the placement, so a rule that trusted the stale
    // at-tail state would re-arm a pin straight onto the reader.
    h.viewport.noteNavigation('wheel');
    h.adapter.scrollTop = 200; // 400px above the 600px maximum
    h.viewport.handleScroll();

    expect(h.viewport.snapshot().mode).toBe('reading');
    expect(h.viewport.snapshot().pinning).toBe(false);

    h.render(content({ lineCount: 40 }));
    h.frames.settle();
    expect(h.adapter.writes).toEqual([]);
});

it('restores the reader offset when a live line arrives during a history request', () => {
    const h = mounted();
    h.clock.advance(FOLLOW_SETTLE_MS + 1);
    h.adapter.readerScrollTo(0);
    h.viewport.handleScroll();

    const token = h.viewport.beginHistory(false)!;

    // A live line lands while the older page is still in flight. The reader is
    // still looking at the same row, so the arrival is not a reason to follow the
    // new tail, and the pending restore must still be the one that moves them.
    h.render(content({ lineCount: 21 }));
    expect(h.adapter.writes).toEqual([]);

    h.adapter.scrollHeight = 2000;
    h.viewport.finishHistory(token, { preserveScroll: true, prependedNothing: false });
    h.frames.settle();

    expect(h.adapter.scrollTop).toBe(2000 - VIEWPORT_HEIGHT - 600);
    expect(h.viewport.snapshot().mode).toBe('reading');
});

it('does not re-anchor on a content report whose tail has not changed', () => {
    const h = harness();
    h.viewport.attach('channel-a', h.adapter);
    const snapshot = content();
    h.render(snapshot);
    h.frames.settle();
    h.clock.advance(FOLLOW_SETTLE_MS + 1);
    h.adapter.readerScrollTo(0);
    h.viewport.handleScroll();
    h.adapter.writes.length = 0;

    // Same tail identity, fewer retained rows: the cap trimmed the front. The
    // buffer gained no newest line, so a re-render of the same tail must not be
    // read as an arrival and pull a reading view to the bottom.
    h.render({ ...snapshot, lineCount: 12 });
    h.frames.settle();

    expect(h.adapter.writes).toEqual([]);
    expect(h.viewport.snapshot().mode).toBe('reading');
});

it('resumes following when a clamped navigation fires no scroll event', () => {
    const h = mounted();
    h.clock.advance(FOLLOW_SETTLE_MS + 1);
    h.adapter.readerScrollTo(h.adapter.maxScroll);
    h.viewport.handleScroll();
    expect(h.viewport.snapshot().mode).toBe('following');

    // A downward gesture at the absolute tail cannot move anything, so no scroll
    // event follows it. Navigation still records the reader taking the viewport —
    // the view is left reading until something reports where it actually is.
    h.viewport.noteNavigation('wheel');
    expect(h.viewport.snapshot().mode).toBe('reading');

    // Any later read of the geometry — a scroll event from a compositor flush, a
    // layout notification's measure — puts the view back where the reader is.
    h.viewport.handleScroll();
    expect(h.viewport.snapshot().mode).toBe('following');
});
