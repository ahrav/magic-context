#!/usr/bin/env bash
# Baseline arms for crates/mc-host per docs/perf/mc-host-baseline.md.
# Usage: perf-mc-host.sh <outdir> <arm> [args...]
#   arms: ceiling <conns> <rep> | open <conns> <rate> | large <payload>
#         slowreader | greedy | starvation | strace | perfrec
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/target/release/examples"
OUT="${1:?outdir}"
ARM="${2:?arm}"
shift 2
mkdir -p "$OUT"

HOST_PID=""
DATA=""
PUB=""

start_host() {
  DATA=$(mktemp -d)
  local log="$OUT/host-$ARM$LABEL_SUFFIX.log"
  local host_args=("$DATA")
  [[ -n "${FRAME_DEADLINE:-}" ]] && host_args+=("$FRAME_DEADLINE")
  if [[ "${HOST_WRAP:-}" == "strace" ]]; then
    strace -f -c -o "$OUT/strace-$ARM$LABEL_SUFFIX.txt" \
      "$BIN/perf_host" "${host_args[@]}" >"$log" 2>&1 &
  else
    "$BIN/perf_host" "${host_args[@]}" >"$log" 2>&1 &
  fi
  HOST_PID=$!
  for _ in $(seq 200); do
    grep -q READY "$log" 2>/dev/null && break
    sleep 0.1
  done
  PUB=$(awk '/READY/{print $2; exit}' "$log")
  [[ -n "$PUB" ]] || {
    echo "host failed to publish"
    cat "$log"
    exit 1
  }
}

stop_host() {
  kill -INT "$HOST_PID" 2>/dev/null || true
  wait "$HOST_PID" 2>/dev/null || true
  rm -rf "$DATA"
}

load() {
  "$BIN/perf_load" "$PUB" "$@" | tee -a "$OUT/results.txt"
}

LABEL_SUFFIX=""
case "$ARM" in
ceiling)
  CONNS="${1:?conns}"
  REP="${2:?rep}"
  LABEL_SUFFIX="-c$CONNS-r$REP"
  start_host
  load --label "A1-ceiling-c$CONNS-r$REP" --conns "$CONNS" --payload 256 --pipeline 32 --secs 15
  stop_host
  ;;
open)
  CONNS="${1:?conns}"
  RATE="${2:?rate}"
  LABEL_SUFFIX="-c$CONNS-rate$RATE"
  start_host
  load --label "A1-open-c$CONNS-rate$RATE" --conns "$CONNS" --payload 256 --rate "$RATE" --secs 20
  stop_host
  ;;
large)
  PAYLOAD="${1:?payload}"
  LABEL_SUFFIX="-p$PAYLOAD"
  start_host
  load --label "A2-large-p$PAYLOAD" --conns 4 --payload "$PAYLOAD" --pipeline 4 --secs 15
  stop_host
  ;;
slowreader)
  start_host
  load --label A3-stall --stall-big 2 --payload 33554432 --secs 40 &
  STALL_PID=$!
  sleep 2
  load --label A3-victims --conns 8 --payload 256 --rate 2000 --secs 30
  wait "$STALL_PID" || true
  stop_host
  ;;
greedy)
  start_host
  load --label A4-greedy --conns 1 --payload 256 --pipeline 512 --secs 25 &
  GREEDY_PID=$!
  sleep 2
  load --label A4-victims --conns 8 --payload 256 --rate 800 --secs 20
  wait "$GREEDY_PID" || true
  stop_host
  ;;
starvation)
  start_host
  load --label A5-hogs --conns 3 --payload 8388608 --sleep-ms 2000 --pipeline 8 --secs 25 &
  HOG_PID=$!
  sleep 2
  load --label A5-victims --conns 2 --payload 256 --rate 400 --secs 20
  wait "$HOG_PID" || true
  load --label A5-recovery --conns 2 --payload 256 --rate 400 --secs 10
  stop_host
  ;;
strace)
  HOST_WRAP=strace
  start_host
  load --label ATTR-strace --conns 8 --payload 256 --pipeline 16 --secs 10
  pkill -INT -x perf_host || true
  wait "$HOST_PID" 2>/dev/null || true
  rm -rf "$DATA"
  HOST_PID=""
  ;;
perfrec)
  start_host
  load --label ATTR-perf-warm --conns 8 --payload 256 --pipeline 32 --secs 3 >/dev/null
  perf record -e cycles:u -F 397 -g --call-graph fp -p "$HOST_PID" \
    -o "$OUT/perf-small.data" -- sleep 12 &
  PERF_PID=$!
  load --label ATTR-perf-small --conns 8 --payload 256 --pipeline 32 --secs 12
  wait "$PERF_PID" || true
  perf record -e cycles:u -F 397 -g --call-graph fp -p "$HOST_PID" \
    -o "$OUT/perf-large.data" -- sleep 12 &
  PERF_PID=$!
  load --label ATTR-perf-large --conns 4 --payload 1048576 --pipeline 4 --secs 12
  wait "$PERF_PID" || true
  stop_host
  ;;
*)
  echo "unknown arm $ARM"
  exit 1
  ;;
esac
