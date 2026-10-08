#!/usr/bin/env bash
# Run ONE arm of the unit (store-pipeline) benchmark and capture every artifact.
#
# Usage: scripts/perf/unit-arm.sh <arm-label> <run-dir>
#
# Captures into <run-dir>:
#   stdout.txt stderr.txt      — vitest output + /usr/bin/time -l counters block
#   unit-results.txt           — per-stage medians reported by the benches
#   hashes.txt                 — sha256 of every /tmp/gb-perf snapshot (identity gate)
#   meta.txt                   — arm label, load average before/after, git rev, date
set -euo pipefail

ARM="${1:?arm label required}"
RUNDIR="${2:?run dir required}"

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO"

mkdir -p "$RUNDIR"
rm -f /tmp/gb-perf/unit-results.txt /tmp/gb-perf/unit-counts.txt
mkdir -p /tmp/gb-perf

load() { uptime | sed 's/.*load averages\{0,1\}:*//'; }

# Vitest occasionally wedges at startup (no RUN header, no exit). A wedged arm
# must fail the harness loudly, not silently produce an empty artifact set.
GB_PERF_ARM_TIMEOUT="${GB_PERF_ARM_TIMEOUT:-180}"
run_guarded() {
  "$@" &
  local pid=$!
  ( sleep "$GB_PERF_ARM_TIMEOUT"; kill -TERM "$pid" 2>/dev/null; sleep 5; kill -KILL "$pid" 2>/dev/null ) &
  local watchdog=$!
  local rc=0
  wait "$pid" || rc=$?
  kill "$watchdog" 2>/dev/null || true
  wait "$watchdog" 2>/dev/null || true
  return $rc
}

# Some arms change a workspace package whose dist/ the app imports; the arm's
# source swap is meaningless unless the package is rebuilt first.
if [ -n "${GB_PERF_PREBUILD:-}" ]; then
  eval "$GB_PERF_PREBUILD" > "$RUNDIR/prebuild.txt" 2>&1 || {
    echo "FAIL: GB_PERF_PREBUILD failed" >&2
    cat "$RUNDIR/prebuild.txt" >&2
    exit 1
  }
fi

echo "load_before: $(load)" > "$RUNDIR/meta.txt"
{
  run_guarded /usr/bin/time -l npx vitest run --config vitest.perf.config.ts
} > "$RUNDIR/stdout.txt" 2> "$RUNDIR/stderr.txt"
echo "load_after: $(load)" >> "$RUNDIR/meta.txt"

[ -s /tmp/gb-perf/unit-results.txt ] || {
  echo "FAIL: arm produced no /tmp/gb-perf/unit-results.txt (wedged or timed-out run)" >&2
  echo "status: incomplete" >> "$RUNDIR/meta.txt"
  exit 1
}
cp /tmp/gb-perf/unit-results.txt "$RUNDIR/unit-results.txt"
# Work counts (selector publications, mocked title/favicon call counts) are a
# second, deterministic evidence stream: a regression guard can assert on them
# even when wall time is too noisy to show the difference.
if [ -s /tmp/gb-perf/unit-counts.txt ]; then
  cp /tmp/gb-perf/unit-counts.txt "$RUNDIR/unit-counts.txt"
fi
( cd /tmp/gb-perf && shasum -a 256 ./*.json ) > "$RUNDIR/hashes.txt"

echo "arm: $ARM" >> "$RUNDIR/meta.txt"
echo "git: $(git rev-parse --short HEAD)$(git diff --quiet || echo '-dirty')" >> "$RUNDIR/meta.txt"
echo "date: $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$RUNDIR/meta.txt"
echo "cmd: /usr/bin/time -l npx vitest run --config vitest.perf.config.ts" >> "$RUNDIR/meta.txt"

cat "$RUNDIR/unit-results.txt"
