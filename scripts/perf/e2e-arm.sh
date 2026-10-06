#!/usr/bin/env bash
# Run ONE arm of the E2E production-build benchmark and capture every artifact.
#
# Usage: scripts/perf/e2e-arm.sh <arm-label> <run-dir>
#
# The arm builds the static site from the current working tree and runs the
# in-page flood benchmark against `vite preview`, so it measures the shipped app
# rather than Vite dev-mode instrumentation.
#
# Captures into <run-dir>:
#   stdout.txt stderr.txt   — Playwright output + /usr/bin/time -l block
#   unit-results.txt        — the [prodflood] result line the summarizer parses
#   hashes.txt              — sha256 of the rendered-row snapshot (identity gate)
#   e2e-rows.json           — the snapshot itself
#   meta.txt                — arm label, load before/after, git rev, date
#
# Counter caveat: /usr/bin/time -l measures the Playwright/Node process. Chromium
# runs as a separate process, so these counters do NOT cover browser CPU; the
# in-page render timing and the side-effect counts are the browser-side evidence.
set -euo pipefail

ARM="${1:?arm label required}"
RUNDIR="${2:?run dir required}"

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO"

mkdir -p "$RUNDIR"

load() { uptime | sed 's/.*load averages\{0,1\}:*//'; }

GB_PERF_ARM_TIMEOUT="${GB_PERF_ARM_TIMEOUT:-420}"
run_guarded() {
  "$@" &
  local pid=$!
  ( sleep "$GB_PERF_ARM_TIMEOUT"; kill -TERM "$pid" 2>/dev/null; sleep 10; kill -KILL "$pid" 2>/dev/null ) &
  local watchdog=$!
  local rc=0
  wait "$pid" || rc=$?
  kill "$watchdog" 2>/dev/null || true
  wait "$watchdog" 2>/dev/null || true
  return $rc
}

# The bench serves a built bundle: without rebuilding, the arm's source swap
# would have no effect at all.
npm run build > "$RUNDIR/build.txt" 2>&1 || {
  echo "FAIL: npm run build failed" >&2
  tail -20 "$RUNDIR/build.txt" >&2
  exit 1
}

# Which bench this arm runs. prodflood renders a flood in the buffer on screen;
# prodbadge floods a buffer you are NOT looking at, which is the only way the
# unread badge path runs at all.
E2E_GREP="${GB_PERF_E2E_GREP:-prodflood}"
RESULT_PATTERN="${GB_PERF_E2E_RESULT_PATTERN:-^\[prodflood\] renderMedian}"

export GB_E2E_SNAPSHOT="$RUNDIR/e2e-rows.json"
export GB_E2E_FLOOD_COUNT="${GB_E2E_FLOOD_COUNT:-2000}"
export GB_E2E_BADGE_COUNT="${GB_E2E_BADGE_COUNT:-2000}"
export GB_E2E_REPEATS="${GB_E2E_REPEATS:-3}"

echo "load_before: $(load)" > "$RUNDIR/meta.txt"
{
  run_guarded /usr/bin/time -l npx playwright test \
    --config src-svelte/e2e/playwright.prodbench.config.ts -g "$E2E_GREP"
} > "$RUNDIR/stdout.txt" 2> "$RUNDIR/stderr.txt"
echo "load_after: $(load)" >> "$RUNDIR/meta.txt"

grep -E "$RESULT_PATTERN" "$RUNDIR/stdout.txt" > "$RUNDIR/unit-results.txt" || true
if [ ! -s "$RUNDIR/unit-results.txt" ] || [ ! -s "$GB_E2E_SNAPSHOT" ]; then
  echo "FAIL: arm produced no $E2E_GREP result or no snapshot (wedged or timed-out run)" >&2
  echo "status: incomplete" >> "$RUNDIR/meta.txt"
  exit 1
fi

shasum -a 256 "$GB_E2E_SNAPSHOT" > "$RUNDIR/hashes.txt"

echo "arm: $ARM" >> "$RUNDIR/meta.txt"
echo "git: $(git rev-parse --short HEAD)$(git diff --quiet || echo '-dirty')" >> "$RUNDIR/meta.txt"
echo "date: $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$RUNDIR/meta.txt"
echo "cmd: /usr/bin/time -l npx playwright test --config src-svelte/e2e/playwright.prodbench.config.ts -g $E2E_GREP" >> "$RUNDIR/meta.txt"
echo "flood_count: $GB_E2E_FLOOD_COUNT" >> "$RUNDIR/meta.txt"

cat "$RUNDIR/unit-results.txt"
