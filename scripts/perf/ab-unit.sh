#!/usr/bin/env bash
# Interleaved paired A/B: candidate (current working tree) vs saved baseline.
#
# Usage: scripts/perf/ab-unit.sh <label> <reps>
# Set GB_PERF_ARM_SCRIPT=scripts/perf/e2e-arm.sh to run the E2E production bench instead.
#
# The baseline arm is defined by artifacts/perf/swap-manifest.txt: one
# repo-relative path per line, each with a saved baseline copy at
# artifacts/perf/baseline-src/<path>. Files not in the manifest are identical
# in both arms.
#
# Order alternates per repetition (odd: candidate first, even: baseline first)
# so neither arm always runs on a warm cache.
#
# Runs land in artifacts/perf/runs/<label>/rep<N>/{cand,base}/ with the full
# per-run artifact set from unit-arm.sh.
set -euo pipefail

LABEL="${1:?label required}"
REPS="${2:-6}"

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO"

# Which harness runs a single arm. Unit by default; ab-e2e.sh overrides it.
ARM_SCRIPT="${GB_PERF_ARM_SCRIPT:-scripts/perf/unit-arm.sh}"

# Manifest and snapshot directories are overridable so one campaign's baseline
# never overwrites another's: GB_PERF_MANIFEST / GB_PERF_BASE_DIR / GB_PERF_CAND_DIR
# point at a per-campaign evidence directory while the defaults stay untouched.
MANIFEST="${GB_PERF_MANIFEST:-artifacts/perf/swap-manifest.txt}"
BASE_DIR="${GB_PERF_BASE_DIR:-artifacts/perf/baseline-src}"
CAND_DIR="${GB_PERF_CAND_DIR:-artifacts/perf/cand-src}"
RUNDIR="artifacts/perf/runs/$LABEL"

[ -f "$MANIFEST" ] || { echo "missing $MANIFEST — list the files this experiment swaps"; exit 1; }

FILES=()
while IFS= read -r line; do
  case "$line" in ''|'#'*) continue ;; esac
  FILES+=("$line")
done < "$MANIFEST"
[ "${#FILES[@]}" -gt 0 ] || { echo "empty manifest"; exit 1; }

mkdir -p "$BASE_DIR" "$CAND_DIR" "$RUNDIR"
for f in "${FILES[@]}"; do
  [ -f "$BASE_DIR/$f" ] || { echo "missing baseline copy: $BASE_DIR/$f"; exit 1; }
  mkdir -p "$CAND_DIR/$(dirname "$f")"
  cp "$f" "$CAND_DIR/$f"
done

restore_candidate() {
  for f in "${FILES[@]}"; do cp "$CAND_DIR/$f" "$f"; done
  echo "[ab] candidate files restored"
}
trap restore_candidate EXIT INT TERM

run_arm() { # $1 = cand|base, $2 = rep dir
  local arm="$1" repdir="$2"
  if [ "$arm" = base ]; then
    for f in "${FILES[@]}"; do cp "$BASE_DIR/$f" "$f"; done
  else
    for f in "${FILES[@]}"; do cp "$CAND_DIR/$f" "$f"; done
  fi
  "$ARM_SCRIPT" "$arm" "$repdir/$arm"
}

for r in $(seq 1 "$REPS"); do
  echo "=== rep $r ==="
  if [ $((r % 2)) -eq 1 ]; then
    run_arm cand "$RUNDIR/rep$r"
    run_arm base "$RUNDIR/rep$r"
  else
    run_arm base "$RUNDIR/rep$r"
    run_arm cand "$RUNDIR/rep$r"
  fi
done

restore_candidate
trap - EXIT INT TERM
node scripts/perf/summarize.mjs "$RUNDIR"
