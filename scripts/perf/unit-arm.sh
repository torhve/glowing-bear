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
rm -f /tmp/gb-perf/unit-results.txt
mkdir -p /tmp/gb-perf

load() { uptime | sed 's/.*load averages\{0,1\}:*//'; }

echo "load_before: $(load)" > "$RUNDIR/meta.txt"
{
  /usr/bin/time -l npx vitest run --config vitest.perf.config.ts
} > "$RUNDIR/stdout.txt" 2> "$RUNDIR/stderr.txt"
echo "load_after: $(load)" >> "$RUNDIR/meta.txt"

cp /tmp/gb-perf/unit-results.txt "$RUNDIR/unit-results.txt"
( cd /tmp/gb-perf && shasum -a 256 ./*.json ) > "$RUNDIR/hashes.txt"

echo "arm: $ARM" >> "$RUNDIR/meta.txt"
echo "git: $(git rev-parse --short HEAD)$(git diff --quiet || echo '-dirty')" >> "$RUNDIR/meta.txt"
echo "date: $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$RUNDIR/meta.txt"
echo "cmd: /usr/bin/time -l npx vitest run --config vitest.perf.config.ts" >> "$RUNDIR/meta.txt"

cat "$RUNDIR/unit-results.txt"
