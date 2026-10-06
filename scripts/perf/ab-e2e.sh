#!/usr/bin/env bash
# Interleaved paired A/B for the E2E production-build benchmark.
#
# Usage: scripts/perf/ab-e2e.sh <label> <reps>
#
# Same swap-manifest mechanism as ab-unit.sh, but each arm rebuilds the site and
# runs the in-page flood benchmark against the production preview server.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
GB_PERF_ARM_SCRIPT="scripts/perf/e2e-arm.sh" exec "$REPO/scripts/perf/ab-unit.sh" "$@"
