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
  drift. This is the equivalence gate for a windowed renderer, whose DOM snapshot
  is *expected* to differ.

Instrumentation added to `prodflood` in this campaign: `RecalcStyleCount`,
`RecalcStyleDuration`, `TaskDuration`, chat-container element count, document
element count, container `scrollHeight`.

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

(one section per change: hypothesis, code, benchmark command, before/after per
stage and total, ratio + win rate, correctness validation, KEEP/REVERT, reason,
next suspected bottleneck)
