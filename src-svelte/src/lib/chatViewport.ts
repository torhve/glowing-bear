/**
 * Chat viewport ownership.
 *
 * One controller per mounted chat view decides every application-driven scroll of
 * the chat container: following live messages, positioning the read separator on
 * entry, restoring position after older history arrives, and pinning through late
 * layout changes. Everything else — rendering, model state, transport calls — is
 * owned elsewhere and reaches the viewport through this contract.
 *
 * Design rules:
 * - The controller never imports transport or model code. Geometry goes through
 *   `ChatViewportAdapter`, side effects through injected callbacks, so the policy
 *   is testable without a DOM and cannot mutate unread or read-boundary state.
 * - Every scheduled task carries the visit and adapter it was created for. A
 *   superseded visit (A → B → A), a replaced container, or a disposal can never
 *   move the current view.
 * - At most one frame pipeline is outstanding per view. Repeated invalidations
 *   re-arm the existing work instead of starting competing loops.
 * - The settling clocks here govern *layout* only. They are never evidence of a
 *   completed protocol sync and must not be reused for the sync phase or a read
 *   boundary.
 */

// ---------------------------------------------------------------------------
// Tuned constants. These are measured safeguards, not arbitrary numbers; the
// reasons are recorded in docs/chat-scroll-ownership.md and beside the WebKit
// regressions they came from. Do not retune them while "fixing" a Chromium run.
// ---------------------------------------------------------------------------

/** Distance from the bottom (px) within which the chat counts as at bottom. */
export const SCROLL_BOTTOM_TOLERANCE = 10;
/**
 * Window after an active follow pin during which a scroll event that is not
 * backed by deliberate input is treated as layout noise. WebKit reflows a
 * wrapping line across several frames and fires scroll events against the
 * transient layouts; without this the view is stranded above the true bottom.
 */
export const FOLLOW_SETTLE_MS = 250;
/** Hard cap on one pin sequence, so a layout that never settles cannot pin forever. */
export const PIN_CAP_MS = 400;
/** Frames of unchanged scrollHeight that count as settled layout. */
export const PIN_SETTLE_FRAMES = 2;
/** Failed read-separator lookups tolerated before falling back to the bottom. */
export const READMARKER_MAX_FAILURES = 2;
/** Viewport fraction the read separator is aimed at when unread overflows. */
export const READMARKER_VIEWPORT_RATIO = 0.45;
/** PageUp/PageDown step as a fraction of the viewport. */
export const PAGE_SCROLL_RATIO = 0.8;
/** scrollTop below which the reader is considered to have reached the oldest row. */
export const TOP_FETCH_SCROLL_THRESHOLD = 50;
/** Line height assumed before any row has rendered. */
export const DEFAULT_SAMPLE_LINE_HEIGHT = 16;
/** Extra lines requested beyond one screenful when estimating visible rows. */
export const VISIBLE_LINES_HEADROOM = 10;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ChatRect {
    top: number;
    bottom: number;
    height: number;
}

/**
 * Everything the controller may read or change about the chat container.
 * Implementations must be scoped to one element: the read separator lookup is a
 * container query, not a document query, so two mounted views cannot see each
 * other's marker.
 */
export interface ChatViewportAdapter {
    getScrollTop(): number;
    getScrollHeight(): number;
    getClientHeight(): number;
    setScrollTop(value: number): void;
    /** Viewport-relative box of the chat container, or null when unmeasurable. */
    getContainerRect(): ChatRect | null;
    /** Viewport-relative box of this container's read separator, or null. */
    getReadMarkerRect(): ChatRect | null;
    /** Height of a rendered line sample inside this container, or null. */
    getSampleLineHeight(): number | null;
}

/** Follow intent: the reader is at the live tail, or is reading older content. */
export type ChatViewportMode = 'following' | 'reading';

/** The automatic work currently owned by the view's single frame pipeline. */
export type ChatViewportPending =
    | 'none'
    | 'measure'
    | 'entry-placement'
    | 'follow-pin'
    | 'history-restore';

/** Provenance of a scroll the controller should treat as the reader's own intent. */
export type ChatNavigationSource = 'wheel' | 'touch' | 'keyboard' | 'scrollbar';

/**
 * What the view rendered since the last call. `tailRef` is the last rendered
 * line object: identity, not length, is what proves the tail moved once a
 * buffer reaches its line cap.
 */
export interface ChatContentSnapshot {
    bufferId: string | undefined;
    lineCount: number;
    tailRef: unknown;
    /** Model-derived: unread lines exist below the read separator. */
    hasUnread: boolean;
    /** Model-derived: the reconnect/snapshot did not provide a trustworthy boundary. */
    readBoundaryKnown: boolean;
}

/** Opaque handle for one history request; completions are validated against it. */
export interface ChatHistoryToken {
    visit: number;
    request: number;
    interaction: number;
    bufferId: string;
    maxScrollBeforeFetch: number;
}

export interface ChatHistoryOutcome {
    /** The explicit "Fetch more lines" button restores nothing; scroll-initiated prepends do. */
    preserveScroll: boolean;
    /** The server returned no row the client did not already display. */
    prependedNothing: boolean;
}

/** Read-only view of the controller, used by the E2E settle hook and by diagnostics. */
export interface ChatViewportState {
    pinning: boolean;
    pendingFrames: number;
    settlingUntil: number;
    mode: ChatViewportMode;
    pending: ChatViewportPending;
    visit: number;
    interaction: number;
    historyPending: boolean;
}

export interface ChatViewportDeps {
    scheduleFrame?: (callback: () => void) => number;
    cancelFrame?: (handle: number) => void;
    now?: () => number;
    /** Publishes the AngularJS-`bufferBottom`-equivalent follow intent. */
    onFollowIntent?: (atBottom: boolean) => void;
    /** Reports how many rows fit on one screen; the retention formula stays in the model. */
    onVisibleLinesEstimate?: (numLines: number) => void;
    /** Mirrors the controller's history busy flag into the view's rendering state. */
    onHistoryBusy?: (busy: boolean) => void;
    /** Asks the view to fetch older lines; the transport call itself is the view's job. */
    onReachTop?: (force: boolean) => void;
}

/**
 * The scroll operations a mounted chat view exposes to the rest of the app.
 * Callers express intent only — the controller decides the movement, and a
 * reader's own navigation outranks it.
 */
export interface ChatScrollCommands {
    /** PageUp (-1) / PageDown (1). False when no mounted view owns a viewport. */
    pageScroll(direction: -1 | 1): boolean;
}

/**
 * Stable holder shared through Svelte context. The object lives for the whole
 * page; only `current` changes as the chat view mounts and unmounts, so a
 * sibling reads the live commands without creating a reactive dependency.
 */
export interface ChatScrollCommandsHolder {
    current: ChatScrollCommands | null;
}

interface QueuedTask {
    visit: number;
    adapter: ChatViewportAdapter;
    kind: ChatViewportPending;
    run: () => void;
}

interface PinLoop {
    deadline: number;
    lastScrollHeight: number;
    stableFrames: number;
}

// ---------------------------------------------------------------------------
// DOM adapter
// ---------------------------------------------------------------------------

/**
 * Bind the controller's geometry contract to one chat container.
 *
 * `rowSelector` and `markerSelector` are container-scoped on purpose: the
 * controller must never resolve a row or a separator through `document`, which
 * would let a second mounted view (or a dialog that happens to render a row)
 * answer for the chat.
 */
export function createChatDomAdapter(
    container: HTMLElement,
    rowSelector = '.bufferline',
    markerSelector = '.readmarker',
): ChatViewportAdapter {
    const rectOf = (el: Element): ChatRect => {
        const rect = el.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, height: rect.height };
    };
    return {
        getScrollTop: () => container.scrollTop,
        getScrollHeight: () => container.scrollHeight,
        getClientHeight: () => container.clientHeight,
        setScrollTop: (value: number) => {
            container.scrollTop = value;
        },
        getContainerRect: () => rectOf(container),
        getReadMarkerRect: () => {
            const marker = container.querySelector(markerSelector);
            return marker ? rectOf(marker) : null;
        },
        getSampleLineHeight: () => {
            const sample = container.querySelector(rowSelector);
            return sample ? sample.clientHeight : null;
        },
    };
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export class ChatViewport {
    private readonly scheduleFrame: (callback: () => void) => number;
    private readonly cancelFrame: (handle: number) => void;
    private readonly now: () => number;
    private readonly onFollowIntent: (atBottom: boolean) => void;
    private readonly onVisibleLinesEstimate: (numLines: number) => void;
    private readonly onHistoryBusy: (busy: boolean) => void;
    private readonly onReachTop: (force: boolean) => void;

    private adapter: ChatViewportAdapter | null = null;
    private bufferId: string | undefined;
    /** Increments on every new visit, container replacement, and disposal. */
    private visit = 0;
    /** Increments on deliberate reader navigation; supersedes pending automatic work. */
    private interaction = 0;
    /** When and how the reader last moved the viewport themselves. */
    private lastNavigationAt = 0;
    private lastNavigationSource: ChatNavigationSource | null = null;
    private requestSeq = 0;
    private disposed = false;

    private mode: ChatViewportMode = 'following';
    private atBottom = true;
    private lastFollowPinAt = 0;
    private pinLoop: PinLoop | null = null;

    private queue: QueuedTask[] = [];
    private drainHandle: number | null = null;

    // Tail revision bookkeeping: one reference plus a counter, so a capped
    // buffer (append + trim in the same update) still reads as a tail change.
    private tailSeqCounter = 0;
    private prevTailRef: unknown;
    private prevTailSeq = 0;
    private prevBufferId = '';
    private prevLineCount = 0;
    private prevScrollKey = '';

    private readMarkerFailures = 0;
    private history: ChatHistoryToken | null = null;
    /** A prepend restore is queued but has not run yet; the view is still busy. */
    private restorePending = false;
    private exhaustedTopBufferId: string | null = null;
    private latest: ChatContentSnapshot | null = null;

    constructor(deps: ChatViewportDeps = {}) {
        this.scheduleFrame = deps.scheduleFrame ?? ((callback) => requestAnimationFrame(callback));
        this.cancelFrame = deps.cancelFrame ?? ((handle) => cancelAnimationFrame(handle));
        this.now = deps.now ?? (() => performance.now());
        this.onFollowIntent = deps.onFollowIntent ?? (() => {});
        this.onVisibleLinesEstimate = deps.onVisibleLinesEstimate ?? (() => {});
        this.onHistoryBusy = deps.onHistoryBusy ?? (() => {});
        this.onReachTop = deps.onReachTop ?? (() => {});
    }

    /**
     * Bind the controller to a visit: the buffer being displayed plus the
     * container it renders into. A changed buffer or a replaced container ends
     * the previous visit, cancels its scheduled work, and clears its history
     * operation — an in-flight fetch can neither move the new view nor leave a
     * newer visit locked by a stale busy flag.
     */
    attach(bufferId: string | undefined, adapter: ChatViewportAdapter): void {
        if (this.disposed) return;
        if (bufferId === this.bufferId && adapter === this.adapter) return;
        this.cancelScheduled();
        this.visit++;
        this.bufferId = bufferId;
        this.adapter = adapter;
        this.exhaustedTopBufferId = null;
        this.pinLoop = null;
        if (this.history) {
            this.history = null;
            this.publishHistoryBusy();
        }
    }

    /** The mounted view is going away: nothing scheduled may run again. */
    detach(): void {
        this.cancelScheduled();
        this.visit++;
        this.adapter = null;
        this.bufferId = undefined;
        this.pinLoop = null;
        if (this.history) {
            this.history = null;
            this.publishHistoryBusy();
        }
    }

    /** Final teardown. After disposal the controller never schedules again. */
    dispose(): void {
        this.disposed = true;
        this.detach();
    }

    /** True while this visit's history request is the outstanding one. */
    isCurrentVisit(token: ChatHistoryToken): boolean {
        return !this.disposed && token.visit === this.visit && token.bufferId === this.bufferId;
    }

    /** True while a history request or its restore owns the view; no auto-follow. */
    isHistoryPending(): boolean {
        return this.history !== null || this.restorePending;
    }

    /**
     * Report what the view rendered.
     *
     * The controller owns the decision tree: a buffer change re-places the
     * viewport (bottom, or the read separator when unread overflows), new lines
     * pin only while the reader is following, and unchanged content does nothing
     * at all. The snapshot is stored so a scheduled frame always reads the
     * freshest render rather than the one that scheduled it.
     */
    contentChanged(snapshot: ChatContentSnapshot): void {
        if (this.disposed) return;
        this.latest = snapshot;

        if (!this.adapter || !snapshot.bufferId || snapshot.lineCount === 0) {
            this.prevBufferId = snapshot.bufferId ?? '';
            this.prevLineCount = snapshot.lineCount;
            // Tail references are deliberately NOT reset here: a transient skip
            // (history in flight, container not mounted yet) must not manufacture
            // a fresh revision for a tail that never changed.
            return;
        }

        // While older lines are being fetched the reader parked at the top; a
        // live arrival must not drag them to the bottom before the restore runs.
        if (this.isHistoryPending()) {
            this.prevBufferId = snapshot.bufferId;
            this.prevLineCount = snapshot.lineCount;
            return;
        }

        const bufferId = snapshot.bufferId;
        const lineCount = snapshot.lineCount;
        const tailSeq = this.revisionOf(snapshot.tailRef);
        const bufferChanged = this.prevBufferId !== bufferId;
        // A line arrived when the list grew, OR when it stayed the same size and
        // the tail changed. The second case is the line cap: handlers append the
        // incoming line and trim one off the front in the same update, so length
        // never changes. Detecting only growth silently disables following in
        // every buffer that has reached the cap.
        const linesAdded =
            lineCount > this.prevLineCount ||
            (lineCount === this.prevLineCount && tailSeq !== this.prevTailSeq);

        // Trust the scroll handler's record of the reader's last deliberate
        // position; the geometric re-check only runs when it says they are not
        // following, and uses the same tolerance.
        let wasFollowing = this.atBottom;
        if (linesAdded && !wasFollowing && this.isGeometricallyAtBottom()) {
            wasFollowing = true;
            this.setFollowIntent(true);
        }

        if (!bufferChanged && !linesAdded) return;

        // Dedup guard: identical content must not re-place the view. A failed
        // read-separator lookup bypasses it so the retry can run.
        const scrollKey = `${bufferId}-${lineCount}-${tailSeq}`;
        if (this.prevScrollKey === scrollKey && this.readMarkerFailures === 0) return;

        this.prevScrollKey = scrollKey;
        this.prevBufferId = bufferId;
        this.prevLineCount = lineCount;
        this.prevTailRef = snapshot.tailRef;
        this.prevTailSeq = tailSeq;

        this.schedule('measure', () => this.measureVisibleLines());

        if (!bufferChanged && linesAdded) {
            this.placeLiveTail(wasFollowing);
            return;
        }
        this.placeEntry();
    }

    /**
     * The container scrolled.
     *
     * A scroll event alone does not identify the reader: layout changes, native
     * anchoring, and our own writes all produce one. During the follow-settle
     * window a scroll that is not backed by deliberate input keeps a following
     * view following; deliberate input is routed through `noteNavigation`, which
     * cancels this pipeline outright.
     */
    handleScroll(): void {
        if (this.disposed || !this.adapter) return;
        const atBottomNow = this.isGeometricallyAtBottom();
        const inSettleWindow = this.now() - this.lastFollowPinAt < FOLLOW_SETTLE_MS;
        if (atBottomNow || (inSettleWindow && this.atBottom)) {
            this.setFollowIntent(true);
        } else {
            this.setFollowIntent(false);
        }
        if (this.adapter.getScrollTop() < TOP_FETCH_SCROLL_THRESHOLD) {
            this.requestOlderLines();
        }
    }

    /**
     * Deliberate reader navigation (wheel, touch drag, PageUp/PageDown, scrollbar).
     *
     * It is authoritative: pending automatic work is cancelled the moment it is
     * observed, including a pin loop that is mid-flight, so a reader who scrolls
     * away during the settle window stays where they moved instead of being
     * dragged back. The follow-settle stickiness exists to absorb *layout* noise,
     * never to override an explicit navigation.
     */
    noteNavigation(source: ChatNavigationSource): void {
        if (this.disposed || !this.adapter) return;
        this.interaction++;
        this.lastNavigationAt = this.now();
        this.lastNavigationSource = source;
        this.cancelScheduled();
        this.pinLoop = null;
        // The reader's own scroll has already moved the container; recompute the
        // geometric state instead of assuming where they ended up.
        if (this.isGeometricallyAtBottom()) {
            this.setFollowIntent(true);
        } else {
            this.setFollowIntent(false);
        }
    }

    /**
     * Ask the controller to move the viewport by one page.
     *
     * Keyboard navigation is deliberate intent, so it is recorded as such before
     * the write happens; a pin loop that was still running is cancelled rather
     * than competing with the reader.
     */
    requestPageScroll(direction: -1 | 1): boolean {
        const adapter = this.adapter;
        if (this.disposed || !adapter) return false;
        this.noteNavigation('keyboard');
        adapter.setScrollTop(adapter.getScrollTop() + direction * adapter.getClientHeight() * PAGE_SCROLL_RATIO);
        return true;
    }

    /**
     * A layout change the controller did not cause: viewport resize, font change,
     * media growth, composer growth.
     *
     * A following view re-arms the single pin pipeline; a reading view is left
     * where the reader put it. Repeated notifications coalesce because re-arming
     * an existing loop is not a second loop.
     */
    notifyLayoutChanged(): void {
        if (this.disposed || !this.adapter) return;
        this.schedule('measure', () => this.measureVisibleLines());
        if (this.mode === 'following') {
            this.armPin();
        }
    }

    /**
     * Claim a history request for this visit, or return null when the view is
     * not allowed to start one: a request is already in flight, the buffer's top
     * is already known to be exhausted, or nothing is mounted.
     */
    beginHistory(force = false): ChatHistoryToken | null {
        const adapter = this.adapter;
        const bufferId = this.bufferId;
        if (this.disposed || !adapter || !bufferId) return null;
        if (this.isHistoryPending()) return null;
        if (!force && this.exhaustedTopBufferId === bufferId) return null;
        const token: ChatHistoryToken = {
            visit: this.visit,
            request: ++this.requestSeq,
            interaction: this.interaction,
            bufferId,
            maxScrollBeforeFetch: adapter.getScrollHeight() - adapter.getClientHeight(),
        };
        this.history = token;
        this.onHistoryBusy(true);
        return token;
    }

    /**
     * Finish a history request.
     *
     * The token decides what the completion may still do. A completion from a
     * superseded visit is dropped entirely — it must not clear a newer visit's
     * busy flag or move its viewport. A completion whose reader navigated while
     * the request was in flight keeps the bookkeeping but skips the restore, so
     * the pre-request position is never written over a newer intent.
     */
    finishHistory(token: ChatHistoryToken, outcome: ChatHistoryOutcome): void {
        if (this.disposed) return;
        if (token.visit !== this.visit || token.bufferId !== this.bufferId) return;
        if (!this.history || this.history.request !== token.request) return;

        this.history = null;

        if (outcome.prependedNothing) {
            // Nothing was prepended while the buffer is at its line cap: the
            // displayed window already covers the server history. Stop
            // auto-fetching for this buffer (the button still forces one).
            this.exhaustedTopBufferId = token.bufferId;
        } else {
            this.exhaustedTopBufferId = null;
        }

        const adapter = this.adapter;
        if (!outcome.preserveScroll || token.interaction !== this.interaction || !adapter) {
            this.publishHistoryBusy();
            return;
        }

        // The view stays busy until the restore has actually run: rows that
        // rendered alongside the prepended history must not get to follow first.
        const maxScrollBeforeFetch = token.maxScrollBeforeFetch;
        this.restorePending = true;
        this.publishHistoryBusy();
        this.schedule('history-restore', () => {
            adapter.setScrollTop(adapter.getScrollHeight() - adapter.getClientHeight() - maxScrollBeforeFetch);
            this.setFollowIntent(false);
            this.restorePending = false;
            this.publishHistoryBusy();
        });
    }

    /** Explicit "Fetch more lines": bypasses the exhausted-top memo. */
    requestHistoryNow(): void {
        this.onReachTop(true);
    }

    /** Read-only state for diagnostics and the E2E settle hook. */
    snapshot(): ChatViewportState {
        return {
            pinning: this.pinLoop !== null,
            pendingFrames: this.queue.length + (this.drainHandle !== null ? 1 : 0),
            settlingUntil: this.lastFollowPinAt + FOLLOW_SETTLE_MS,
            mode: this.mode,
            pending: this.pendingWork(),
            visit: this.visit,
            interaction: this.interaction,
            historyPending: this.isHistoryPending(),
        };
    }

    // -----------------------------------------------------------------------
    // Internal policy
    // -----------------------------------------------------------------------

    private pendingWork(): ChatViewportPending {
        if (this.pinLoop) return 'follow-pin';
        if (this.isHistoryPending()) return 'history-restore';
        return this.queue[0]?.kind ?? 'none';
    }

    /** Cheap identity token for the tail line, stable across store re-clones. */
    private revisionOf(tailRef: unknown): number {
        if (tailRef === this.prevTailRef) return this.prevTailSeq;
        return ++this.tailSeqCounter;
    }

    private isGeometricallyAtBottom(): boolean {
        const adapter = this.adapter;
        if (!adapter) return false;
        return (
            adapter.getScrollTop() >=
            adapter.getScrollHeight() - adapter.getClientHeight() - SCROLL_BOTTOM_TOLERANCE
        );
    }

    /**
     * Record follow intent and publish it once, through the single adapter path.
     * `mode` is intent; `atBottom` is geometry. They are kept separate so a
     * temporary restoration state can never be mistaken for unread policy.
     */
    private setFollowIntent(atBottom: boolean): void {
        this.atBottom = atBottom;
        this.mode = atBottom ? 'following' : 'reading';
        this.onFollowIntent(atBottom);
    }

    /**
     * New lines in the buffer the reader is already viewing.
     *
     * `wasFollowing` was captured synchronously before the frame, so a reader who
     * scrolled away keeps their position; unread accumulates behind the separator
     * instead of the view being dragged to the tail.
     */
    private placeLiveTail(wasFollowing: boolean): void {
        this.schedule('follow-pin', () => {
            if (wasFollowing || this.atBottom) {
                this.readMarkerFailures = 0;
                this.setFollowIntent(true);
                this.armPin();
            }
            // Otherwise: do nothing. The reader's position is theirs.
        });
    }

    /**
     * The view now shows a different buffer: place the viewport at the bottom, or
     * at the read separator when unread lines overflow the viewport.
     *
     * Placement runs one frame after the render so Svelte's DOM insert has
     * happened, and the separator lookup runs one frame after that because the
     * marker row is inserted by the same render pass.
     */
    private placeEntry(): void {
        this.schedule('entry-placement', () => {
            const snapshot = this.latest;
            const adapter = this.adapter;
            if (!snapshot || !adapter) return;
            if (!snapshot.hasUnread) {
                this.readMarkerFailures = 0;
                this.scrollToBottom();
                this.setFollowIntent(true);
                return;
            }
            if (this.readMarkerFailures >= READMARKER_MAX_FAILURES) {
                // Bounded fallback: the separator never became measurable, so the
                // reader gets the tail rather than an unplaced viewport.
                this.readMarkerFailures = 0;
                this.scrollToBottom();
                this.setFollowIntent(true);
                return;
            }
            this.schedule('entry-placement', () => {
                const marker = adapter.getReadMarkerRect();
                const containerRect = adapter.getContainerRect();
                if (!marker || !containerRect) {
                    this.readMarkerFailures++;
                    this.prevScrollKey = '';
                    this.setFollowIntent(false);
                    return;
                }
                this.readMarkerFailures = 0;
                const remainingScroll = adapter.getScrollHeight() - adapter.getScrollTop();
                if (marker.bottom <= containerRect.bottom && remainingScroll <= adapter.getClientHeight()) {
                    // The separator and everything below it already fit: the tail
                    // is the better place to be.
                    this.scrollToBottom();
                    this.setFollowIntent(true);
                    return;
                }
                // Aim the separator at ~45% of the viewport so the reader sees the
                // boundary and the unread that follows it.
                const targetY = containerRect.top + adapter.getClientHeight() * READMARKER_VIEWPORT_RATIO;
                adapter.setScrollTop(adapter.getScrollTop() + (marker.top - targetY));
                this.setFollowIntent(false);
            });
        });
    }

    /**
     * Keep the tail pinned until layout settles.
     *
     * WebKit reflows a wrapping line across several frames — scrollHeight
     * bounces — so a single double-rAF can land on a transient layout and strand
     * the view above the true bottom. Pin each frame until scrollHeight is stable
     * for a couple of frames or the cap elapses, whichever comes first.
     *
     * Re-arming an active loop extends its deadline instead of nesting a second
     * one, which is what keeps a fast flood on a single pipeline.
     */
    private armPin(): void {
        const now = this.now();
        if (this.pinLoop) {
            this.pinLoop.deadline = now + PIN_CAP_MS;
            this.pinLoop.stableFrames = 0;
            return;
        }
        this.pinLoop = { deadline: now + PIN_CAP_MS, lastScrollHeight: -1, stableFrames: 0 };
        this.lastFollowPinAt = now;
        this.schedule('follow-pin', () => this.stepPin());
    }

    private stepPin(): void {
        const adapter = this.adapter;
        const loop = this.pinLoop;
        if (!adapter || !loop) {
            this.pinLoop = null;
            return;
        }
        this.scrollToBottom();
        this.lastFollowPinAt = this.now();
        const scrollHeight = adapter.getScrollHeight();
        loop.stableFrames = scrollHeight === loop.lastScrollHeight ? loop.stableFrames + 1 : 0;
        loop.lastScrollHeight = scrollHeight;
        const settled = loop.stableFrames >= PIN_SETTLE_FRAMES || this.now() > loop.deadline;
        if (settled) {
            this.pinLoop = null;
            return;
        }
        this.schedule('follow-pin', () => this.stepPin());
    }

    private scrollToBottom(): void {
        const adapter = this.adapter;
        if (!adapter) return;
        adapter.setScrollTop(adapter.getScrollHeight() - adapter.getClientHeight());
    }

    /** Visible-row estimate; the retention formula itself stays in the model. */
    private measureVisibleLines(): void {
        const adapter = this.adapter;
        if (!adapter) return;
        const areaHeight = adapter.getClientHeight();
        const lineHeight = adapter.getSampleLineHeight() ?? DEFAULT_SAMPLE_LINE_HEIGHT;
        if (lineHeight === 0) return;
        // Headroom beyond one screenful so scrolling up already has rows to show.
        this.onVisibleLinesEstimate(Math.ceil(areaHeight / lineHeight + VISIBLE_LINES_HEADROOM));
    }

    /** Ask the view for older lines, subject to this visit's own guards. */
    private requestOlderLines(): void {
        if (this.isHistoryPending()) return;
        if (this.bufferId && this.exhaustedTopBufferId === this.bufferId) return;
        this.onReachTop(false);
    }

    /** Cancel every outstanding frame and queued task for the current visit. */
    private cancelScheduled(): void {
        if (this.drainHandle !== null) {
            this.cancelFrame(this.drainHandle);
            this.drainHandle = null;
        }
        this.queue = [];
        if (this.restorePending) {
            // A cancelled restore must not leave the view permanently busy, or a
            // later request for the same buffer would be refused forever.
            this.restorePending = false;
            this.publishHistoryBusy();
        }
    }

    /** The busy flag the view renders: an in-flight request or a queued restore. */
    private publishHistoryBusy(): void {
        this.onHistoryBusy(this.history !== null || this.restorePending);
    }

    /**
     * Queue work on the view's single frame pipeline.
     *
     * One drain frame is outstanding at a time; tasks queued by a task run on the
     * next frame, which preserves the "wait for the render, then measure" chain
     * without ever running two pipelines side by side. Tasks carry the visit and
     * adapter they were created for, so a superseded visit is dropped at the door.
     */
    private schedule(kind: ChatViewportPending, run: () => void): void {
        const adapter = this.adapter;
        if (this.disposed || !adapter) return;
        this.queue.push({ visit: this.visit, adapter, kind, run });
        if (this.drainHandle !== null) return;
        this.drainHandle = this.scheduleFrame(() => {
            this.drainHandle = null;
            const batch = this.queue;
            this.queue = [];
            for (const task of batch) {
                // A task belongs to the visit and the container it was queued for.
                if (task.visit !== this.visit || task.adapter !== this.adapter) continue;
                task.run();
            }
        });
    }
}
