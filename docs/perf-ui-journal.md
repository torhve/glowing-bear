# UI render performance campaign — journal

Started: 2026-10-13. Branch: `perf-ui-render`. Continues the render-side work in
root `PERFORMANCE.md` (gitignored, local) after the API-reducer round, whose own
conclusion was: the remaining flood wall time is the browser's own style/layout/
paint work for the chat rows, and virtualising `ChatView` was the top unattempted
candidate.

## Scope for this campaign

The brief for the session is UI performance: fewer reactive dependencies per
rendered row, less browser render work per message, and a measured verdict on
virtualised (windowed) chat rows. Rayon/parallelism is not applicable — the hot
path is single-threaded main-thread DOM work — so the campaign uses the same
methodology with the other levers: eliminate work, shrink the DOM the browser has
to render, and reduce the reactive graph that re-evaluates on every batch.

## Environment (measured, not assumed)

- Hardware: Apple M1 Pro, 8 cores, 16 GB (`hw.model: MacBookPro18,3`)
- OS: macOS 26.6.2 (build 25G83)
- Node: v26.11.1
- Browser: Playwright Chromium (production build served by `vite preview`)
- Relay: gbtest — API relay 9010, legacy relay 9001, IRC 6667, control 16667
- Machine load during the campaign: recorded per arm in `meta.txt`
  (`load_before` / `load_after`). It was **not idle**: 2.1–4.3 load average with
  5–6 logged-in users carrying load I did not create. Absolute wall seconds are
  therefore not comparable across batches; only paired per-rep ratios transfer.

## Harness

Single arm:

```bash
GB_PERF_MANIFEST=artifacts/perf/campaign4/manifest.txt \
GB_PERF_BASE_DIR=artifacts/perf/campaign4/baseline-src \
GB_PERF_CAND_DIR=artifacts/perf/campaign4/cand-src \
bash scripts/perf/e2e-arm.sh <arm> artifacts/perf/campaign4/runs/<label>/rep1/<arm>
```

Interleaved paired A/B (odd reps candidate first, even reps baseline first):

```bash
GB_PERF_MANIFEST=artifacts/perf/campaign4/manifest.txt \
GB_PERF_BASE_DIR=artifacts/perf/campaign4/baseline-src \
GB_PERF_CAND_DIR=artifacts/perf/campaign4/cand-src \
GB_PERF_ARM_SCRIPT=scripts/perf/e2e-arm.sh \
bash scripts/perf/ab-unit.sh <label> 6
```

Summary recomputed from the captured artifacts:

```bash
node scripts/perf/summarize.mjs artifacts/perf/runs/<label>
```

Workloads:

- `prodflood` — 2,000 messages into the buffer on screen, measured in-page by a
  MutationObserver (first message in → last row on screen).
- `prodwalk` (new, `src-svelte/e2e/bench/prodwalk.bench.ts`) — scroll the whole
  retained window top → bottom and record every row passed, plus scroll-geometry
  drift. Intended as the equivalence gate for a windowed renderer, whose DOM snapshot
  is *expected* to differ. **It is not yet a working gate**: scrolling to `scrollTop = 0`
  triggers `onReachTop` history loading, which prepends lines and shifts `scrollTop`, so
  the walk breaks after one step and its own assertion fails. It reports usable geometry
  (`clientHeight` 598, `scrollHeight` 3395, ~17 px per row, `heightDrift` 0) but must
  absorb the reach-top prepend before it can certify a virtualized renderer.

Instrumentation added to `prodflood` in this campaign: `RecalcStyleCount`,
`RecalcStyleDuration`, `TaskDuration`, chat-container element count, document
element count, container `scrollHeight`.

**Harness trap, learned the expensive way.** `ab-unit.sh` snapshots the *working
tree* into `CAND_DIR` at startup for every file in the manifest. Editing
`CAND_DIR` by hand before a run does nothing — the snapshot overwrites it, and both
arms end up identical. The candidate must be applied to the working tree before
launching. The first exp25 batch (retained rows 200 → 60) was wasted this way: both
arms reported `bodyRows=200`, `containerNodes=2813`, and a 0.996 median ratio that
measured nothing but the machine.

## Baseline

Baseline commit: `9d1ab228` (branch point; the working tree also carries unrelated
uncommitted connection-retry changes, which are present in **both** arms of every
pair and therefore cancel out).

### Baseline probe (single arm, 3 rounds, 2,000 messages)

`artifacts/perf/campaign4/runs/baseline-probe/rep1/base/`

| metric | value | per round |
| --- | ---: | ---: |
| render (wall, in-page) | median 923 ms | 867 / 923 / 933 |
| send (IRC control) | median 221 ms | |
| rows delivered | 2000 | |
| DOM rows kept | 200 | = `maxBufferLines` |
| chat-container elements | 2819 | ≈14 per row |
| document elements | 3447 | |
| layouts | 216 | 72 |
| layout time | 376 ms | 125 ms |
| style recalcs | 210 | 70 |
| style time | 179 ms | 60 ms |
| main-thread JS (ScriptDuration) | 871 ms | 290 ms |
| main-thread total (TaskDuration) | 2529 ms | 843 ms |
| longtasks | 0 | |
| load before / after | 4.29 / 5.23 (1 min) | |

Reading: per round the main thread spends ~843 ms of the ~923 ms measured window.
Script accounts for 290 ms, layout 125 ms, style 60 ms — 475 ms attributed, ~370 ms
unattributed (paint, compositing, GC, network/message parsing). The DOM the app
keeps on screen is 2819 elements for 200 rows.

### CPU profile of the same run (21,048 samples, 100 µs interval)

| share | symbol | note |
| ---: | --- | --- |
| 48.3% | `(program)` | unattributed executable time — browser native work |
| 22.0% | `(idle)` | |
| 2.6% | `before` | Svelte keyed-each removal path |
| 2.3% | `remove` | Svelte DOM removal helper |
| 1.6% | `#v` (svelte chunk) | |
| 1.6% | `(garbage collector)` | |
| 1.4% | `sn` (svelte chunk) | |
| 1.2% | `(anon) nodes/2.*.js:7` | ChatView chunk (viewport/geometry) |
| 0.9% | `cloneNode` | |
| 0.5% | `querySelectorAll` | |
| 5.8% | all `nodes/2.*.js` (ChatView chunk) | |
| 13.0% | all `chunks/D_*` (Svelte runtime + shared) | |

Hypothesis carried forward: the dominant bucket is browser render work that scales
with the number of live row elements, not application JavaScript.

## Hypothesis queue

Written before the code, as required. Status is updated in place.

1. **H1 — DOM size is the dominant cost.** The app keeps 200 rows (≈2,819 elements)
   live while only ~46 fit on screen. Test by measuring the *ceiling*: lower the
   retained-line clamp and see how render time, layout time, style time and DOM
   nodes move. Probe only — lowering the clamp changes how much history a reader
   can scroll back to, so it is not a candidate change.
2. **H2 — per-row reactive dependencies re-evaluate on every batch.** Each row
   derives `previousMessage` from the whole `messages` array, so every batch dirties
   every row's `previousMessage` → `isRepeatedTime` → `isRepeatedPrefix` chain even
   though a tail append plus front trim cannot change who precedes a row. Candidate:
   pass the predecessor's identity instead of index + whole array.
3. **H3 — `lineKeys` rebuilds a Map and 200 strings per batch** for the keyed each
   block, purely to guard against duplicate fallback ids that the API relay never
   produces.
4. **H4 — virtualising the chat rows** (render only a window) is the architectural
   version of H1. Branch experiment, measured against the walk gate.
5. **H5 — off-screen rows could be made cheap without removing them from the DOM**
   (`content-visibility`), which is the same win H1 wants with no reactivity change
   — but it estimates the height of unrendered content, which is scroll geometry,
   i.e. externally visible. Measure, then decide; do not assume.

## Experiment log

### Noise floor (null test: both arms identical)

`artifacts/perf/runs/nulltest` — 6 paired reps, `ChatView.svelte` and
`BufferLineRow.svelte` copied byte-identically into both arms. This is the
measurement error of the harness itself, and every later ratio is read against it.

| stage | win rate | median ratio | per-pair spread |
| --- | --- | ---: | ---: |
| flood render (in-page wall) | 3/6 | 1.004 | 0.807 – 1.205 |
| main-thread JS (ScriptDuration) | 5/6 | 0.980 | 0.870 – 1.064 |
| layout time | 3/6 | 1.018 | 0.900 – 1.112 |
| layout count | 3/6 | 1.017 | 0.828 – 1.161 |
| style time | 4/6 | 0.995 | 0.926 – 1.096 |
| style count | 2/6 | 1.025 | 0.822 – 1.162 |
| process instructions retired | — | 0.999 | ±1% |

Two things this settles:

1. **The in-page flood wall time cannot resolve anything under ~20% at 6 reps.**
   Its per-pair ratio spans 0.81–1.21 for two identical builds, because the
   machine's load rose from 4.3 to 6.7 during the batch and the measurement window
   is under a second. A single-digit render-time claim from 6 reps is not a result.
2. **`/usr/bin/time -l` counters do not measure the browser.** They are stable to
   ~1% here, but they cover the Playwright/Node process. Chromium is a separate
   process, so a browser-side win can be invisible in them. They are a harness
   stability check, not evidence about the app. Retracting any earlier framing of
   instructions-retired as a browser tie-breaker.

Consequence for the rest of the campaign: judge a change on the CDP buckets
(`ScriptDuration` first, then layout/style), require a win rate consistent across
pairs, and only quote the flood wall time when the effect is large enough to clear
a ±20% floor — or with more reps.

### exp24 — pass the row's predecessor instead of (index, messages) — REVERTED

**Hypothesis.** Every row was handed `index` and the whole `messages` array and
looked its predecessor up itself. Both props change on every batch — the array is
a fresh object per publication and a front trim shifts every index — so the guess
was that all 200 rendered rows re-ran their derived chain per batch: ~14,000
re-tokenizations, re-embed-scans and grouping recomputations per 2,000-message
flood.

**Change.** `BufferLineRow` takes `previous: BufferLine | null` and `first: boolean`
instead of `index` and `messages`; `ChatView` supplies them through `prevLine(i)`.

**Benchmark.** 8 paired reps, alternating arm order, `GB_E2E_REPEATS=5`:

```bash
GB_PERF_MANIFEST=artifacts/perf/campaign4/manifest.txt \
GB_PERF_BASE_DIR=artifacts/perf/campaign4/baseline-src \
GB_PERF_CAND_DIR=artifacts/perf/campaign4/cand-src \
GB_PERF_ARM_SCRIPT=scripts/perf/e2e-arm.sh GB_E2E_REPEATS=5 \
bash scripts/perf/ab-unit.sh exp24-row-props 8
```

| stage | win rate | median ratio | noise floor (null test) |
| --- | --- | ---: | ---: |
| flood render (wall) | 3/8 | 1.004 | 3/6, 1.004 |
| main-thread JS | 5/8 | 0.981 | 5/6, 0.980 |
| layout time | 6/8 | 0.989 | 3/6, 1.018 |
| layout count | 6/8 | 0.992 | 3/6, 1.017 |
| style time | 4/8 | 1.000 | 4/6, 0.995 |
| style count | 4/8 | 1.002 | 2/6, 1.025 |

Output identity: all 16 runs produced the same row-snapshot hash as the baseline.

**Why timing could not answer it, and what did.** A counter has no noise, so the
hypothesis was tested by counting instead of timing. `prodcount.bench.ts` reads
`gbCount()` counters compiled into the shipped build; the same counters were added
to both arms. One 2,000-message flood each:

| counter | baseline | candidate |
| --- | ---: | ---: |
| row renders | 2200 | 2200 |
| predecessor lookups | **28,861** | 2,276 |
| repeated-time evaluations | 2,272 | 2,276 |
| repeated-prefix evaluations | 2,272 | 2,276 |
| message tokenizations | 2200 | 2200 |
| embed/metadata scans | 2200 | 2200 |
| date-separator checks | 2200 | 2200 |
| nick extractions | 2200 | 2200 |

**Finding — the hypothesis was wrong about the expensive part.** The cascade is
real (28,861 predecessor lookups against 2,200 rows) and the change removes 26,585
of them. It does not touch the expensive work: tokenization, embed scanning, date
checks and nick extraction each already ran **exactly once per row render** in the
baseline. Svelte 5's derived chain is lazy — a dirty `previousMessage` that
recomputes to the same object never re-dirties the render effect, so the row's
template and its expensive deriveds never re-ran. The eliminated work is 26,585
array index reads, which is sub-millisecond.

That is the whole explanation for the flat benchmark: the candidate is not a small
win, it is no win.

**Decision: REVERT.** No measured effect on any stage, and it changes a component's
public props. Kept instead: `prodcount.bench.ts` as the counter harness, and
`row-predecessor-equivalence.test.ts`, which locks which row counts as whose
predecessor across an append, a front trim, and a no-op re-publication.

**Next suspected bottleneck.** Row *creation* is the script cost, and it is
inherent: 2,200 renders × (tokenize + embed scan + ~11 DOM elements) is what a
2,000-message flood costs, and no reactive restructuring removes it. The open
questions are therefore (a) how much of the total is the 200 live rows the browser
keeps laying out, and (b) whether a row can be built from fewer elements.

### What a row actually costs (direct measurement, no A/B)

Two numbers that changed the direction of the campaign, both measured directly
rather than inferred:

**Tokenization is not the cost.** `tokenizeAndCodify` was called 2,200 times per
flood (one per row, proven by counters in exp24). Run directly in Node over five
representative message shapes — plain text, a nicked line, two URLs, two backtick
code segments, a long plain line — 2,200 calls take **1.1 ms total** (0.37–1.01 µs
per call). Against 267 ms of browser script time per round, the entire tokenizer is
0.1%.

**So the per-message budget is construction, not logic.** 267 ms of script per
2,000-message round is ~133 µs per message, and essentially none of it is
application computation. It is Svelte component instantiation and the ~14 elements
each row builds (`tr`, 3 `td`, `span.date.compact-time`, `span.time-delimiter`,
`span.compact-prefix`, `span.mention-link`, 2–3 `span.prefix-part`,
`span.message-content`, `span.token-group`), which matches the measured
`containerNodes=2813 / 200 rows = 14.1`.

**And the DOM cannot be slimmed.** The only span in a row with no CSS rule is
`.prefix-part` — but it carries the WeeChat colour classes (`part.classes`), so
removing it would drop per-part prefix colouring. Every other span in the row is
load-bearing for colour, for the click-to-mention handler, or for the
`white-space-collapse` rule that keeps line breaks inside table cells. DOM slimming
is a measured dead end, not an untried idea.

### exp25 — how much is the 200 live rows: the ceiling probe

**Hypothesis.** The retained window renders 200 rows to show ~46. If the cost is
proportional to live rows, cutting them to ~60 bounds what virtualisation can win.

**Change (probe only, not a candidate).** Force the retained-line clamp down:
`Math.min(60, Math.min(1000, Math.max(200, 2 * $lps + 10)))`.

**Benchmark.** 8 paired reps, alternating arm order, `GB_E2E_REPEATS=5`, prodflood:

```bash
GB_PERF_MANIFEST=artifacts/perf/campaign4/manifest-probe.txt \
GB_PERF_BASE_DIR=artifacts/perf/campaign4/baseline-src \
GB_PERF_CAND_DIR=artifacts/perf/campaign4/cand-src \
GB_PERF_ARM_SCRIPT=scripts/perf/e2e-arm.sh GB_E2E_REPEATS=5 \
bash scripts/perf/ab-unit.sh exp25b-dom-ceiling 8
```

The probe took effect: `bodyRows 200 → 60`, `containerNodes 2813 → 853`,
`docNodes 3441 → 1481`.

| stage | win rate | median ratio | speedup |
| --- | --- | ---: | ---: |
| rendered rows | 8/8 | 0.300 | 3.33x |
| chat DOM nodes | 8/8 | 0.303 | 3.30x |
| document nodes | 8/8 | 0.430 | 2.32x |
| layout time | 8/8 | 0.578 | 1.73x |
| main-thread total | 8/8 | 0.621 | 1.61x |
| main-thread JS | 8/8 | 0.827 | 1.21x |
| style time | 8/8 | 0.928 | 1.08x |
| layout count | 2/8 | 1.015 | — |
| style count | 3/8 | 1.003 | — |
| **flood render (wall)** | **6/8** | **0.995** | **1.005x** |

**Finding — the live flood's wall clock is not render-bound.** Every browser-side
stage moved 8/8 with ratios far outside the noise floor: 70% fewer elements, 42%
less layout time, 38% less main-thread time. The time the user actually waits for a
2,000-message flood did not move at all (1671 ms → 1651 ms).

The arithmetic explains it. Per round the main thread is busy 949 ms inside a
1671 ms window; with 60 rows it is busy 580 ms inside a 1651 ms window. The app is
already idle-waiting for the next batch. Removing render work removes idle time,
not wall time: **a live flood is bounded by how fast the relay delivers messages,
not by how fast the app renders them.**

That is the most consequential measurement in this campaign, and it bounds every
later claim: virtualisation cannot make a live flood feel faster. What it can do is
cut CPU and memory — 70% fewer DOM nodes and 38% less main-thread time — which is a
real win, just not the one the flood benchmark measures.

**Consequence for the campaign.** The remaining question is whether any workload is
render-bound. The one that should be is a burst: on reconnect the relay resends the
whole retained window at once and nothing is on screen until the app has built it.
exp26 measures exactly that.

### exp26 — is any workload render-bound? No.

**The burst test.** A reconnect is the workload that *should* be render-bound: the
relay resends the whole retained window at once and nothing is on screen until the
app has built it. 3,000 lines of history, 200 rows rendered versus 60:

| stage | win rate | median ratio |
| --- | --- | ---: |
| history rows rendered | 6/6 | 0.600 |
| reload → last row visible | 5/6 | 0.969 |

40% fewer rows made the burst 3% faster. Reload-to-last-row is ~255 ms of which
most is connect, auth and buffer discovery — rendering was never the majority of it.

**The direct test of what sets the flood's wall clock.** `prodflood` now records
every inbound relay frame (Playwright sees the socket; the hook is installed in the
fixture's `beforeConnect` because Playwright only reports websockets created after
the listener exists). Both windows are durations, so the Node and page clocks never
have to be reconciled:

```
[prodflood][round 0] render=787ms  netFrames=2031 netFirst=11ms netLast=820ms
[prodflood][round 1] render=759ms  netFrames=2056 netFirst=1ms  netLast=809ms
[prodflood][round 2] render=792ms  netFrames=2026 netFirst=0ms  netLast=797ms
```

**Finding — the app already keeps up with the pipe.** The last relay frame arrives
at 797–820 ms and the last row is on screen at 759–792 ms. The render window and the
arrival window are the same window. The app is not backed up behind the relay; it
renders each batch as it lands and then waits for the next one.

That closes the question exp25 left open. A live flood's duration is set by how fast
the relay delivers — ~0.4 ms per message, one frame per message — and the app's
rendering sits entirely inside that span. Cutting render work cuts CPU, not the
span, because the span is the pipe.

It also explains the drift that made early baselines look unstable: the same build
measured 923 ms per round early in the session and 1671 ms per round later, with no
code change. Each flood leaves 2,000 more lines in the channel, and the relay
delivers from a bigger buffer more slowly. The benchmark's wall clock was partly
measuring WeeChat's history, not the app.

**Consequence.** No optimization of the chat render path can shorten a live flood.
What render work can still buy is CPU and memory — which is what the retained window
is actually sized for.

### exp27 — `content-visibility: auto` on chat rows — REVERTED (measured regression)

**Hypothesis.** 165 of 200 rows are off screen (`clientHeight` 598 px, rows ~17 px,
so ~35 visible). If the browser skipped painting and laying out the off-screen ones,
the DOM would stay byte-identical — every selector, copy and text-selection test
still sees all 200 rows — while layout and paint cost fell. This was the only lever
left that could reduce render work *without* changing what is rendered.

**Code.** Two declarations on `.bufferline` in `BufferLineRow.svelte`:

```css
content-visibility: auto;
contain-intrinsic-size: auto 17px;
```

**Benchmark.**

```bash
GB_PERF_MANIFEST=artifacts/perf/campaign4/manifest.txt \
GB_PERF_BASE_DIR=artifacts/perf/campaign4/baseline-src \
GB_PERF_CAND_DIR=artifacts/perf/campaign4/cand-src \
GB_PERF_ARM_SCRIPT=scripts/perf/e2e-arm.sh GB_PERF_ARM_TIMEOUT=600 GB_E2E_REPEATS=5 \
bash scripts/perf/ab-unit.sh exp27-content-visibility 8
```

**Result (8 paired reps).**

| stage | win rate | median ratio |
| --- | --- | ---: |
| chat DOM nodes | 0/8 | 1.000 |
| document nodes | 0/8 | 1.000 |
| rendered rows | 0/8 | 1.000 |
| layout count | 4/8 | 1.000 |
| layout time | 5/8 | 0.988 |
| main-thread JS | 5/8 | 0.993 |
| flood wall time | 5/8 | 0.998 |
| **style time** | **0/8** | **1.357** |

**Decision — REVERT, with a negative effect measured.** Node count, row count and
layout count are *exactly* unchanged in all 8 pairs: nothing was skipped. Style
recalculation time got 36% worse in every single pair — the only stage that moved at
all moved the wrong way, and it moved consistently enough to be believed.

**Why it failed — the specification says so.** `content-visibility` is defined to
follow the applicability rules of *size containment*, and size containment has no
effect when the element's principal box is an internal table box. A `<tr>` is
`display: table-row`. Firefox ([bug 1663685](https://hg.mozilla.org/mozilla-central/rev/228f4a8ccf96b3bd724b82c7bd6ad92b4e7ba8ef))
and WebKit ([eea0af365](https://github.com/WebKit/WebKit/commit/eea0af365e1cca71d12a328eee4398d5f2db9745))
both made this explicit; the CSSWG discussion is
[csswg-drafts#7658](https://lists.w3.org/Archives/Public/public-css-archive/2022Aug/0906.html).
Chromium accepts the declaration, gets no skipping, and the extra containment bookkeeping
shows up as style cost. The escape hatch would be to take the rows out of the table
formatting context (`display: grid`/`block`), which changes column widths and
alignment — output-altering, and out of scope.

**Consequence.** There is no CSS-only way to make a `<table>` chat cheaper. Any
reduction in rendered rows has to come from rendering fewer rows.

### exp28 — does fewer live rows make the app *feel* faster? No.

exp25b and exp26 showed row reduction does not shorten a flood or a reconnect. The
remaining question is the one that actually matters for a chat client: does it make
**interaction** faster while traffic is in flight — typing, switching buffers, opening
search — which is where a busy main thread is normally felt.

**Hypothesis.** With 200 live rows the main thread is busy 80% of a flood window; a
long task between a keystroke and its presentation is exactly what a render reduction
should remove.

**Benchmark.** `prodreact` measures six scenarios against the production build,
including Event Timing (`inputMaxMs`/`inputMedianMs`) while a flood is in flight.

```bash
GB_PERF_MANIFEST=artifacts/perf/campaign4/manifest-probe.txt \
GB_PERF_BASE_DIR=artifacts/perf/campaign4/baseline-src \
GB_PERF_CAND_DIR=artifacts/perf/campaign4/cand-src \
GB_PERF_ARM_SCRIPT=scripts/perf/e2e-arm.sh GB_PERF_ARM_TIMEOUT=900 \
GB_PERF_E2E_GREP=prodreact GB_PERF_E2E_RESULT_PATTERN='^\[prodreact\]' \
GB_E2E_REPEATS=2 GB_E2E_IDLE_MS=3000 \
bash scripts/perf/ab-unit.sh exp28b-interaction-under-load 8
```

**Result (8 paired reps, 200 live rows vs 60).**

| scenario | what it measures | win rate | median ratio |
| --- | --- | --- | ---: |
| `R-idle` | quiet window, no traffic | 2/8 | 1.000 |
| `R-bg` | flood into a *background* buffer | 4/8 | 1.000 |
| `R-active` | flood into the visible buffer | 4/8 | 1.049 |
| `R-search` | background flood with search open | 1/8 | 1.000 |
| `R-switch` | buffer switch during a flood | 3/8 | 1.009 |
| `R-type` | keystroke latency during a flood | 2/8 | 1.000 |

**Output identity gate: passed.** All 16 runs hashed identical (`fe9a98d7…`). This is
the one probe in the campaign whose gate is clean, because `prodreact` snapshots the
buffer list rather than the chat rows — so the comparison is not confounded by the
probe's own row-count change.

**Decision — no change to keep.** Every scenario is flat, and the one that moved at
all (`R-active`, pairs scattered 0.866–1.164, 4/8) moved in both directions. Cutting
live rows 3.3× changes nothing a user can feel in any measured scenario.

**Harness trap found on the way (recorded because it silently invalidates a run).**
`e2e-arm.sh` defaults `GB_PERF_E2E_RESULT_PATTERN` to `^\[prodflood\] renderMedian`.
A bench whose summary line is `[prodreact] …` and whose stages print as `R-type median
14.0ms` matches neither, so `unit-results.txt` came out empty and the summarizer
reported "no complete runs to compare". The first exp28 therefore produced 8 arms of
perfectly good data that the summarizer could not read. The stage lines were
re-derived from each arm's captured `stdout.txt` with `grep -E '^(R-[a-z]+|prodreact)'`
— the runs themselves were never re-executed, and every number below is still read
from the saved per-arm artifacts.

**Consequence.** Three independent scenarios — live flood duration, reconnect burst
duration, interaction under load — all measure flat under a 3.3× reduction in live
rows. The app's render work is real but it is not on the critical path of anything
the user experiences.

(one section per change: hypothesis, code, benchmark command, before/after per
stage and total, ratio + win rate, correctness validation, KEEP/REVERT, reason,
next suspected bottleneck)
