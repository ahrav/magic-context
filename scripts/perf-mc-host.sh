#!/usr/bin/env bash
# docs/perf/mc-host-ipc-budget.md defines the budget and shared-memory operations.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

BUDGET_BENCH=""
BUDGET_CHILD=""
SHM_BENCH=""
# Offered-rate points shared by the plan preview and execution paths. The
# default string stays byte-identical to DEFAULT_RATES in
# crates/mc-host/benches/ipc_budget.rs (parity-tested by
# crates/mc-host/tests/perf_budget_runner.rs).
BUDGET_RATES="${BUDGET_RATES:-20000 50000 80000}"

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

shm_build() {
  local out
  out=$(cd "$ROOT" && cargo bench -p mc-shm-transport --bench hardware_envelope --no-run --locked 2>&1) || {
    echo "$out"
    echo "shared-memory evidence build failed" >&2
    exit 1
  }
  SHM_BENCH=$(echo "$out" | grep -oE 'target/release/deps/hardware_envelope-[0-9a-f]+' | tail -1)
  [[ -n "$SHM_BENCH" && -x "$ROOT/$SHM_BENCH" ]] || {
    echo "could not locate hardware_envelope bench binary" >&2
    exit 1
  }
  SHM_BENCH="$ROOT/$SHM_BENCH"
}

shm_run() {
  local out="${1:?outdir}" mode="${2:?mode}" args=()
  local manifest="$ROOT/crates/mc-shm-transport/benches/manifests/v1.json"
  if [[ "$mode" == "shm-smoke" ]]; then
    args+=(--smoke)
  else
    [[ "${MC_SHM_DESIGNATED_HOST:-}" == "1" ]] || {
      echo "shm-evidence requires MC_SHM_DESIGNATED_HOST=1" >&2
      exit 1
    }
    if grep -q 'UNSET' "$manifest"; then
      echo "shm-evidence refused: designated-host manifest fields remain UNSET" >&2
      exit 1
    fi
    args+=(--designated-host)
  fi
  mkdir -p "$out"
  local evidence="$out/hardware-envelope-${mode#shm-}.json"
  [[ ! -e "$evidence" ]] || {
    echo "refusing existing evidence file $evidence" >&2
    exit 1
  }
  shm_build
  "$SHM_BENCH" "${args[@]}" >"$evidence"
  grep -q '"verdict": "INCONCLUSIVE"' "$evidence" || {
    echo "shared-memory harness did not retain structured INCONCLUSIVE output" >&2
    exit 1
  }
  cat "$evidence"
  echo "evidence: $evidence" >&2
}

budget_env() {
  if [[ -z "${MC_IPC_BUDGET_COMMIT:-}" ]]; then
    # Evidence identity: stamping the clean HEAD hash onto a binary built
    # from modified sources lets two different dirty builds share one
    # BuildId, pass `compatible`, and merge as though they measured the
    # same code. Only bench build inputs gate this; docs and evidence
    # output stay writable during a run.
    if [[ -n "$(git -C "$ROOT" status --porcelain -- crates Cargo.toml Cargo.lock)" ]]; then
      echo "refusing dirty build inputs (crates/, Cargo.toml, Cargo.lock);" \
        "commit or stash, or set MC_IPC_BUDGET_COMMIT explicitly" >&2
      exit 1
    fi
    MC_IPC_BUDGET_COMMIT="$(git -C "$ROOT" rev-parse --short HEAD)"
    export MC_IPC_BUDGET_COMMIT
  fi
  export MC_IPC_BUDGET_RUSTC="${MC_IPC_BUDGET_RUSTC:-$(rustc --version)}"
}

budget_trap() {
  # Interrupts kill the tracked bench child, then finalize the active
  # manifest as interrupted so the attempt stays retained and out of the
  # aggregate. Masking INT/TERM first keeps the handler from re-entering.
  # Only the tracked child is signalled: `kill 0` targets the whole
  # process group, which includes the invoking shell whenever this script
  # runs without job control (CI, wrapper shells).
  trap 'trap "" INT TERM; \
    { [[ -z "${BUDGET_CHILD:-}" ]] || kill "$BUDGET_CHILD" 2>/dev/null || true; }; \
    sleep 0.5; \
    MC_IPC_BUDGET_MODE=finalize-interrupted MC_IPC_BUDGET_OUT="$BUDGET_OUT" \
    "$BUDGET_BENCH" || true; exit 130' INT TERM
}

budget_collect() {
  local arm="$1" class="$2" block="$3"
  shift 3
  # The bench runs as a tracked background child so the INT/TERM trap can
  # signal exactly it; `wait` surfaces the signal to the trap immediately
  # and still propagates the bench's exit status under `set -e`.
  env "$@" \
    MC_IPC_BUDGET_MODE=collect \
    MC_IPC_BUDGET_OUT="$BUDGET_OUT" \
    MC_IPC_BUDGET_ARM="$arm" \
    MC_IPC_BUDGET_CLASS="$class" \
    MC_IPC_BUDGET_BLOCK="$block" \
    ${BUDGET_PAIR:+MC_IPC_BUDGET_PAIR="$BUDGET_PAIR"} \
    "$BUDGET_BENCH" > >(tee -a "$BUDGET_OUT/collection.log") &
  BUDGET_CHILD=$!
  local rc=0
  wait "$BUDGET_CHILD" || rc=$?
  BUDGET_CHILD=""
  return "$rc"
}

# Odd blocks run arms forward, even blocks reversed (matches
# evidence::counterbalanced_schedule).
budget_block() {
  local block="$1"
  shift
  local arms=(atomic-floor ring-serial ring-open ring-throughput)
  if (((block - 1) % 2 == 1)); then
    arms=(ring-throughput ring-open ring-serial atomic-floor)
  fi
  for arm in "${arms[@]}"; do
    if [[ "$arm" == ring-open ]]; then
      for rate in $BUDGET_RATES; do
        budget_collect ring-open same-l3 "$block" "$@" "MC_IPC_BUDGET_RATE=$rate"
      done
    else
      budget_collect "$arm" same-l3 "$block" "$@"
    fi
  done
  # Cross-NUMA paired arms: auto-selection either finds a pair or
  # finalizes a structured skip without failing the block. Their order
  # reverses on even blocks exactly like the same-L3 arms, so
  # time-dependent drift cancels for the cross-NUMA paired comparison
  # too.
  local cross=(atomic-floor ring-serial)
  if (((block - 1) % 2 == 1)); then
    cross=(ring-serial atomic-floor)
  fi
  for arm in "${cross[@]}"; do
    BUDGET_PAIR="${BUDGET_CROSS_PAIR:-}" budget_collect "$arm" cross-numa "$block" "$@"
  done
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
  # The planned attempt set is persisted first: aggregation verifies
  # every planned attempt has a finalized manifest, so a deleted or
  # omitted attempt directory cannot summarize as a smaller experiment.
  MC_IPC_BUDGET_MODE=record-plan MC_IPC_BUDGET_OUT="$BUDGET_OUT" \
    MC_IPC_BUDGET_BLOCKS="$blocks" MC_IPC_BUDGET_RATES="$BUDGET_RATES" \
    "$BUDGET_BENCH"
  budget_trap
  for block in $(seq 1 "$blocks"); do
    budget_block "$block" "$@"
  done
  MC_IPC_BUDGET_MODE=aggregate MC_IPC_BUDGET_OUT="$BUDGET_OUT" "$BUDGET_BENCH" \
    >"$BUDGET_OUT/summary.stdout.json"
  echo "evidence: $BUDGET_OUT"
}

case "${2:-${1:-}}" in
budget-plan)
  budget_build
  MC_IPC_BUDGET_MODE=plan MC_IPC_BUDGET_BLOCKS="${MC_IPC_BUDGET_BLOCKS:-10}" \
    MC_IPC_BUDGET_RATES="$BUDGET_RATES" "$BUDGET_BENCH"
  exit 0
  ;;
budget-preflight)
  budget_build
  budget_env
  MC_IPC_BUDGET_MODE=plan MC_IPC_BUDGET_RATES="$BUDGET_RATES" "$BUDGET_BENCH"
  BUDGET_OUT=$(mktemp -d)
  BUDGET_PAIR="${BUDGET_PAIR:-}"
  budget_trap
  budget_collect atomic-floor same-l3 1 \
    MC_IPC_BUDGET_WARMUP_BATCHES=2 MC_IPC_BUDGET_BATCHES=5 MC_IPC_BUDGET_EXCHANGES=1000
  budget_collect ring-serial same-l3 1 \
    MC_IPC_BUDGET_WARMUP_OPS=200 MC_IPC_BUDGET_MEASURED_OPS=1000
  if [[ -n "${BUDGET_CROSS_PAIR:-}" ]]; then
    # An explicit cross pair must fail preflight, not the final run: an
    # invalid pair finalizes a failed attempt and exits nonzero here.
    BUDGET_PAIR="$BUDGET_CROSS_PAIR" budget_collect atomic-floor cross-numa 1 \
      MC_IPC_BUDGET_WARMUP_BATCHES=2 MC_IPC_BUDGET_BATCHES=5 MC_IPC_BUDGET_EXCHANGES=1000
  fi
  rm -rf "$BUDGET_OUT"
  echo "preflight ok"
  exit 0
  ;;
esac

case "${2:-}" in
shm-smoke | shm-evidence)
  shm_run "${1:?outdir}" "$2"
  exit 0
  ;;
budget-smoke | budget-pilot | budget-final)
  BUDGET_OUT="${1:?outdir}"
  BUDGET_PAIR="${BUDGET_PAIR:-}"
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
    budget_run "${MC_IPC_BUDGET_BLOCKS:-10}" \
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

echo "unknown operation: ${2:-${1:-}}" >&2
exit 1
