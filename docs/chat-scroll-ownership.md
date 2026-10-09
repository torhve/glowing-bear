# Chat scroll ownership

Every application-driven scroll of the chat container is decided by one
`ChatViewport` controller per mounted chat view. This file records the contract,
the measured reasons behind the tuned constants, and what is deliberately *not*
owned here.

Implementation: `src-svelte/src/lib/chatViewport.ts`.
Component side: `src-svelte/src/components/ChatView.svelte` ("Viewport ownership").

## Who may write the chat scroll position

| Writer | Route |
| --- | --- |
| Follow pin, entry placement, read-separator placement, history restore, PageUp/PageDown | `ChatViewport` → `ChatViewportAdapter.setScrollTop` |
| Reader's wheel, touch drag, scrollbar drag | The browser. The controller only *reads* the result. |
| Native scroll anchoring when rows are trimmed | The browser. Not an application write. |
| `BufferSearchModal` highlighting a result | `scrollIntoView` on the **modal's own** buffer list. Not the chat container; see "Outside chat" below. |

There is no other path. `grep -rn "scrollTop *=" src-svelte/src` finds writes only
inside `chatViewport.ts`.

## Transition policy

Two modes, one owner, no overlap:

- **`following`** — the view is at (or aimed at) the tail. Content changes may
  move the viewport. A follow pin is a short multi-frame sequence, not a state.
- **`reading`** — the reader chose a position. Content changes may not move the
  viewport; they only re-measure how many rows fit.

Transitions:

| Event | Effect |
| --- | --- |
| Wheel or vertical touch drag that *could* move this viewport in that direction | `reading`, immediately. Cancels the pin and any queued work. No settle wait, and no geometry read: the gesture has not moved the container yet. |
| `scroll` event with no gesture behind it | Layout noise while the follow-settle window is open; otherwise `reading`. |
| Buffer switch | New visit: queued frames, pin loop, and in-flight history are dropped, mode resets to `following`. |
| Container replaced, or component unmounted | Visit ends. A task carrying a superseded visit or adapter is dropped at drain time, not executed. |
| Tab becomes visible again | Stale work is dropped; only a genuinely following view re-anchors. Frames do not run while hidden, so any in-flight geometry is out of date. |
| Layout change (resize, font size, media, wrap) | Re-measure always. Re-pin only when already following and no pin is running. |

A gesture that cannot move the viewport in that direction — scrolling up while
already at the top, scrolling down while already at the bottom — is **not** treated
as the reader choosing a position.

## Intent provenance

A `scroll` event alone does not identify a reader. Media growth, wrapping reflow,
native anchoring, and the controller's own writes all fire one. So:

- `wheel` and `touch*` listeners on the container are the authoritative signal.
- Pinch-zoom (`ctrlKey`) and horizontal trackpad gestures (`|deltaX| >= |deltaY|`)
  are ignored.
- One intent per drag: the first vertical movement past `TOUCH_NAVIGATION_THRESHOLD_PX`,
  not every `touchmove`.
- `handleScroll` remains the fallback for input that produces no gesture event of
  its own (a scrollbar drag), which is why it still ends following outside the
  settle window.
- A gesture is seen **before** it moves anything: `wheel` fires before the `scroll`
  it causes. `noteNavigation` therefore must not read the geometry, because the
  geometry it finds is the position the reader is leaving. It records that the
  reader has taken the viewport, and the scroll event that follows decides from
  the new position whether that leaves them at the tail anyway. Reading the stale
  geometry instead handed the view straight back to the follow pipeline, whose
  settle-window rule then re-armed a pin on top of the reader who had just moved.
- `lastNavigationSource` is in the reported state for this reason: "the view is
  reading" is only a claim about the reader if something recorded the reader
  choosing it.

## Operation tokens (history)

`beginHistory(force)` returns a token or `null`. `null` means a history operation is
already owned by this visit — including one whose *restore* is still queued.
`finishHistory(token, outcome)` applies only to the token it matches; a completion
from a superseded visit or a superseded adapter is dropped.

`force` distinguishes the two intents the product has always had:

- the explicit "Fetch more lines" button — bypasses the exhausted-top memo, restores
  no position;
- an automatic fetch when the reader reaches the top — respects the memo, preserves
  the reader's distance from the bottom.

`ChatView` owns the network call and decides whether anything was actually prepended
(`prependedNothing`); the controller owns the guard, the memo, and the restore.

## Callback ownership

The controller imports no store and no transport. Everything it affects arrives as
an injected callback from `ChatView`:

| Callback | Owner |
| --- | --- |
| `onVisibleLinesEstimate` | `recalculateLinesPerScreen` — the retained row cap |
| `onFollowIntent` | `bufferBottom` (published only; nothing in the app reads it today) |
| `onHistoryBusy` | `isLoadingMore` |
| `onReachTop(force)` | triggers `ChatView.loadMoreHistory` |

Geometry reaches the controller through `ChatViewportAdapter`, built per container
by `createChatDomAdapter`. Marker and row lookups are scoped to that container, never
`document`, so two mounted views cannot read each other.

`ChatScrollCommands` (PageUp/PageDown) reach siblings through
`lib/chatScrollContext.ts`: a per-page-instance holder provided by `+page.svelte`,
not a module-global singleton. A component mounted outside a chat page gets an inert
holder.

## Tuned constants and why they exist

These are measured safeguards. Do not retune them while "fixing" a Chromium run.

- **`PIN_SETTLE_FRAMES = 2`** — one frame of unchanged `scrollHeight` is not settled
  layout. WebKit reflows a wrapping line across several frames.
- **`PIN_CAP_MS = 400`** — a layout that never stabilises must not pin forever.
  Reached in practice on WebKit with long wrapping lines.
- **`FOLLOW_SETTLE_MS = 250`** — during this window a scroll event with no gesture
  behind it is layout, not the reader leaving. Without it the view is stranded above
  the true bottom after a reflow. Deliberate input bypasses it entirely through
  `noteNavigation`.
- **`READMARKER_MAX_FAILURES = 2`** — the separator row is inserted by the same
  render pass as the lines around it; a lookup can miss it for a frame. After two
  misses the view falls back to the bottom rather than retrying on every message.
  Counted per buffer entry, not per frame.
- **`SAMPLE_ROW_LIMIT = 12`** — the line-height estimate samples up to 12 rows spread
  across the rendered range and takes the **shortest**. Measuring the first row was a
  real bug: on a capped buffer scrolled to the bottom the first row is often a wrapped
  multi-line message, which inflates the estimate, shrinks the retained row cap,
  changes which row is first, and drifts the cap. That showed up as an intermittent
  WebKit failure in `ChatView-cappedBufferFollow`. Date separator rows are excluded:
  their height is a label, not a line of text.

## Measurements

Harness: `artifacts/perf/e2e/scroll-trace.test.ts` driven by
`artifacts/perf/playwright.scroll.config.ts` (Chromium, gbtest, one CDP
`Performance` session for the whole run). Scroll writes are counted by wrapping the
`scrollTop` setter on the chat container, so browser-side anchoring is not counted.
The view is settled *before* instrumenting, otherwise a buffer switch's own entry
placement is attributed to the scenario.

`artifacts/` is untracked, as with the earlier perf benches: the repo carries the
conclusion, not the harness. Re-run it with
`npx playwright test --config artifacts/perf/playwright.scroll.config.ts` after
swapping `src-svelte/src` to the arm being measured.

Baseline arm: `74a8cded` (the commit before the controller existed). Candidate arm:
current `HEAD`. Four repetitions of each, same dev server, same gbtest state, one
CDP `Performance` session per run. Means are over the four repetitions.

| Scenario | Metric | Baseline | Controller |
| --- | --- | --- | --- |
| 1000 short messages into a capped buffer, view at the tail | **chat scroll writes** | 160, 160, 166, 166 (163) | **49, 48, 46, 47 (47)** |
| | layout | 127, 126, 128, 129 (128 ms) | 130, 127, 127, 126 (128 ms) |
| | script | 1295, 1306, 1294, 1275 (1293 ms) | 1276, 1297, 1277, 1277 (1282 ms) |
| | time to idle | 2871, 2894, 2879, 2893 (2884 ms) | 2879, 2867, 2877, 2878 (2875 ms) |
| 150 long wrapping messages | **chat scroll writes** | 172, 198, 116, 198 (171) | **22, 24, 24, 22 (23)** |
| | layout | 69, 67, 66, 72 (69 ms) | 69, 66, 71, 69 (69 ms) |
| | script | 850, 869, 861, 859 (860 ms) | 854, 843, 861, 867 (856 ms) |
| | time to idle | 1872, 1874, 1885, 1893 (1881 ms) | 1874, 1870, 1886, 1870 (1875 ms) |
| Composer grows 6 lines while the reader is parked | chat scroll writes | 0, 0, 0, 0 | 0, 0, 0, 0 |
| | layout / script / idle | 15 ms / 190 ms / 359 ms | 15 ms / 193 ms / 358 ms |
| 500 messages while the reader is parked 600px above the tail | chat scroll writes | 0, 0, 4, 0 | 4, 0, 0, 0 |
| | layout / script / idle | 52 ms / 375 ms / 872 ms | 52 ms / 383 ms / 882 ms |

What the numbers support:

- The controller writes the chat scroll position **3.4× less often** on a capped
  flood and **7.4× less often** on a wrapping flood. The old code re-anchored on
  every content change; the controller pins once per tail change and stops when two
  frames of `scrollHeight` agree.
- Layout time, style time, script time, and time-to-idle are **unchanged** in every
  scenario. That is the honest reading: the win is the write count and the single
  owner, not measured frame cost. Anyone claiming a frame-time improvement from this
  change is reading noise — the run-to-run spread within one arm is larger than the
  difference between arms.
- Every scenario reaches idle in every repetition of both arms. The harness asserts
  it, because a view that never goes idle is the failure mode this work exists to
  prevent.
- The parked-reader and composer-resize rows are **parity, not improvement**: the old
  code also declined to move a reader who had scrolled away. Both arms occasionally
  show a small nonzero write count from a layout notification that arrives before the
  reader's gesture is recorded; it is bounded by the pin cap, and no E2E spec has
  observed a parked reader being moved.

An earlier set of runs showed the controller ~1s faster to idle on the capped flood.
That was an artifact of a warm dev server on one arm and a cold one on the other; the
four-repetition comparison above is the one to quote.

## Intentional behaviour differences from the pre-controller code

These are the UX changes, kept in separate commits from the extraction so they can be
reviewed and reverted independently:

1. A wheel or drag interrupts pinning and restoration **immediately**. Previously the
   view could re-anchor during the settle window.
2. `PluginEmbed` no longer calls `scrollIntoView` when an image finishes loading. The
   layout growth reaches the controller through the content-root observer, and a
   reading view stays where the reader left it.
3. Font-size changes now re-estimate the visible rows. The old code had a comment
   claiming it did; there was no effect behind the comment.
4. A pin loop is released when the view stops following, so a loop cannot outlive its
   reason and move a viewport the reader is looking at.
5. A container that cannot scroll never starts a pin. It is trivially at its tail, and
   pinning it reported "busy" with no visual effect.
6. Returning to a hidden tab drops stale pin and restore work instead of resuming it.

## Outside chat

`BufferSearchModal` calls `scrollIntoView({ block: 'nearest' })` on the highlighted
row of its **own** buffer list. That container is the modal's, not the chat viewport,
and it is the only `scrollIntoView` left in `src-svelte/src`. It is legitimate and is
not routed through the controller.

`+page.svelte`'s mobile vertical-swipe buffer switch is skipped when the touch began
inside the chat scroll container. That is a gesture-routing rule owned by the page,
not a scroll write.

## Limitations and platform gaps

- **Bubble mode does not report a row height.** Bubble rows carry `.bubble-row` /
  `.bubble-middle-row`, not `.bufferline`, so `getSampleLineHeight` returns null and
  the estimate falls back to `DEFAULT_SAMPLE_LINE_HEIGHT` (16). Changing this would
  change bubble-mode row retention, which is outside a parity extraction.
- **Tauri desktop is unverified.** Chromium and WebKit results are recorded; the
  Tauri WebView has not been traced.
- **`bufferBottom` has no reader.** It is still published through `onFollowIntent` as
  a compatibility contract. Nothing in the app consumes it.
- **Scroll intent is wheel/touch only.** A scrollbar drag is inferred from a `scroll`
  event outside the settle window, which is correct but slower than a gesture.
- **In bubble mode the row-identity anchor is the table-mode selector.** Reading
  position across a history prepend is asserted in table mode.
