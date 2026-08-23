#!/usr/bin/env bash
# docs/perf/mc-host-baseline.md defines the baseline arms;
# docs/perf/mc-host-ipc-budget.md defines the budget-* operations.
# Usage: perf-mc-host.sh <outdir> <arm> [args...]
#   arms: ceiling <conns> <rep> | open <conns> <rate> | large <payload>
#         slowreader | greedy | starvation | strace | perfrec
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/target/release/examples"

BUDGET_BENCH=""

budget_build() {
  local out
  out=$(cd "$ROOT" && cargo bench -p mc-host --bench ipc_budget --no-run --locked 2>&1) || {
    echo "$out"
    echo "bench build failed" >&2
    exit 1
  }
  BUDGET_BENCH=$(echo "$out" | grep -oE 'target/release/deps/ipc_budget-[0-9a-f]+' | tail -1)
  [[ -n "$BUDGET_BENCH" && -x "$ROOT/$BUDGET_BENCH" ]] || {
    echo "could not locate ipc_budget bench binary" >&2
    exit 1
  }
  BUDGET_BENCH="$ROOT/$BUDGET_BENCH"
}

budget_env() {
  export MC_IPC_BUDGET_COMMIT="${MC_IPC_BUDGET_COMMIT:-$(git -C "$ROOT" rev-parse --short HEAD)}"
  export MC_IPC_BUDGET_RUSTC="${MC_IPC_BUDGET_RUSTC:-$(rustc --version)}"
}

budget_trap() {
  # Interrupts kill children, then finalize the active manifest as
  # interrupted so the attempt stays retained and out of the aggregate.
  trap 'kill 0 2>/dev/null || true; sleep 0.5; \
    MC_IPC_BUDGET_MODE=finalize-interrupted MC_IPC_BUDGET_OUT="$BUDGET_OUT" \
    "$BUDGET_BENCH" || true; exit 130' INT TERM
}

budget_collect() {
  local arm="$1" class="$2" block="$3"
  shift 3
  env "$@" \
    MC_IPC_BUDGET_MODE=collect \
    MC_IPC_BUDGET_OUT="$BUDGET_OUT" \
    MC_IPC_BUDGET_ARM="$arm" \
    MC_IPC_BUDGET_CLASS="$class" \
    MC_IPC_BUDGET_BLOCK="$block" \
    ${BUDGET_PAIR:+MC_IPC_BUDGET_PAIR="$BUDGET_PAIR"} \
    "$BUDGET_BENCH" | tee -a "$BUDGET_OUT/collection.log"
}

# Odd blocks run arms forward, even blocks reversed (matches
# evidence::counterbalanced_schedule).
budget_block() {
  local block="$1"
  shift
  local arms=(atomic-floor tcp-serial tcp-open tcp-throughput)
  if (((block - 1) % 2 == 1)); then
    arms=(tcp-throughput tcp-open tcp-serial atomic-floor)
  fi
  for arm in "${arms[@]}"; do
    if [[ "$arm" == tcp-open ]]; then
      for rate in $BUDGET_RATES; do
        budget_collect tcp-open same-l3 "$block" "$@" "MC_IPC_BUDGET_RATE=$rate"
      done
    else
      budget_collect "$arm" same-l3 "$block" "$@"
    fi
  done
  # Cross-NUMA paired arms: auto-selection either finds a pair or
  # finalizes a structured skip without failing the block.
  BUDGET_PAIR="${BUDGET_CROSS_PAIR:-}" budget_collect atomic-floor cross-numa "$block" "$@"
  BUDGET_PAIR="${BUDGET_CROSS_PAIR:-}" budget_collect tcp-serial cross-numa "$block" "$@"
}

budget_run() {
  local blocks="$1"
  shift
  budget_build
  budget_env
  [[ -e "$BUDGET_OUT" && -n "$(ls -A "$BUDGET_OUT" 2>/dev/null)" ]] && {
    echo "refusing nonempty evidence directory $BUDGET_OUT" >&2
    exit 1
  }
  mkdir -p "$BUDGET_OUT"
  budget_trap
  for block in $(seq 1 "$blocks"); do
    budget_block "$block" "$@"
  done
  MC_IPC_BUDGET_MODE=aggregate MC_IPC_BUDGET_OUT="$BUDGET_OUT" "$BUDGET_BENCH" \
    > "$BUDGET_OUT/summary.stdout.json"
  echo "evidence: $BUDGET_OUT"
}

case "${2:-${1:-}}" in
budget-plan)
  budget_build
  MC_IPC_BUDGET_MODE=plan MC_IPC_BUDGET_BLOCKS="${MC_IPC_BUDGET_BLOCKS:-10}" "$BUDGET_BENCH"
  exit 0
  ;;
budget-preflight)
  budget_build
  budget_env
  MC_IPC_BUDGET_MODE=plan "$BUDGET_BENCH"
  BUDGET_OUT=$(mktemp -d)
  BUDGET_PAIR="${BUDGET_PAIR:-}"
  budget_trap
  budget_collect atomic-floor same-l3 1 \
    MC_IPC_BUDGET_WARMUP_BATCHES=2 MC_IPC_BUDGET_BATCHES=5 MC_IPC_BUDGET_EXCHANGES=1000
  budget_collect tcp-serial same-l3 1 \
    MC_IPC_BUDGET_WARMUP_OPS=200 MC_IPC_BUDGET_MEASURED_OPS=1000
  rm -rf "$BUDGET_OUT"
  echo "preflight ok"
  exit 0
  ;;
esac

case "${2:-}" in
budget-smoke | budget-pilot | budget-final)
  BUDGET_OUT="${1:?outdir}"
  BUDGET_PAIR="${BUDGET_PAIR:-}"
  BUDGET_RATES="${BUDGET_RATES:-20000 60000 120000}"
  case "$2" in
  budget-smoke)
    BUDGET_RATES="${BUDGET_SMOKE_RATES:-20000}"
    budget_run 1 \
      MC_IPC_BUDGET_WARMUP_BATCHES=5 MC_IPC_BUDGET_BATCHES=20 MC_IPC_BUDGET_EXCHANGES=2000 \
      MC_IPC_BUDGET_WARMUP_OPS=500 MC_IPC_BUDGET_MEASURED_OPS=5000 \
      MC_IPC_BUDGET_WARMUP_SECS=1 MC_IPC_BUDGET_MEASURE_SECS=2
    ;;
  budget-pilot)
    budget_run 3 \
      MC_IPC_BUDGET_WARMUP_BATCHES=20 MC_IPC_BUDGET_BATCHES=100 MC_IPC_BUDGET_EXCHANGES=10000 \
      MC_IPC_BUDGET_WARMUP_OPS=10000 MC_IPC_BUDGET_MEASURED_OPS=120000 \
      MC_IPC_BUDGET_WARMUP_SECS=2 MC_IPC_BUDGET_MEASURE_SECS=5
    ;;
  budget-final)
    budget_run "${BUDGET_BLOCKS:-10}" \
      MC_IPC_BUDGET_WARMUP_BATCHES=50 MC_IPC_BUDGET_BATCHES=200 MC_IPC_BUDGET_EXCHANGES=10000 \
      MC_IPC_BUDGET_WARMUP_OPS=20000 MC_IPC_BUDGET_MEASURED_OPS=150000 \
      MC_IPC_BUDGET_WARMUP_SECS=2 MC_IPC_BUDGET_MEASURE_SECS=10
    ;;
  esac
  exit 0
  ;;
budget-summarize)
  BUDGET_OUT="${1:?outdir}"
  budget_build
  MC_IPC_BUDGET_MODE=aggregate MC_IPC_BUDGET_OUT="$BUDGET_OUT" "$BUDGET_BENCH"
  exit 0
  ;;
esac

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
