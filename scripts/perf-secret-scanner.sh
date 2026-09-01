#!/usr/bin/env bash
# baseline: save the current build's timings as the 'main' Criterion baseline.
# compare: benchmark against 'main'; stdout is the geomean speedup float.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
case "${1:-compare}" in
  baseline)
    cargo bench -p mc-secret-scanner --bench scanner -- --save-baseline main
    cargo bench -p mc-core --bench redaction -- --save-baseline main
    ;;
  compare)
    cargo bench -p mc-secret-scanner --bench scanner -- --baseline main 1>&2
    cargo bench -p mc-core --bench redaction -- --baseline main 1>&2
    python3 scripts/perf-geomean.py target/criterion \
      scan_comprehensive scan_conservative construction redaction
    ;;
  *)
    echo "usage: $0 [baseline|compare]" >&2
    exit 2
    ;;
esac
