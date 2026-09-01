#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

case "${1:-compare}" in
baseline)
  cargo bench -p mc-store --bench scope_algebra -- --save-baseline main
  ;;
compare)
  cargo bench -p mc-store --bench scope_algebra -- --baseline main
  python3 scripts/perf-geomean.py target/criterion
  ;;
*)
  echo "usage: $0 [baseline|compare]" >&2
  exit 2
  ;;
esac
