# mc-host IPC budget — loopback TCP vs core-to-core floor

Status: measured. This document is the authority for transport
comparisons (`magic-context-ymc.10`); the frozen
[mc-host-baseline.md](./mc-host-baseline.md) numbers are historical and
non-comparable (see its erratum). No value here is a pass/fail
threshold: correctness, configuration validity, evidence integrity, and
the sample floor are the only gates.

Retained evidence: `runs/ipc-budget-20260823T202243Z-ed82528a/`
(60 complete manifests, 20 structured cross-NUMA skips, checksummed
HdrHistogram sidecars, byte-stable `summary.json`), kept on the
measurement host. `docs/perf/runs/` is git-ignored, so the run
directory is not in repository history; on a checkout that holds a copy
of it, `scripts/perf-mc-host.sh <run-dir> budget-summarize` reproduces
every table below from the sidecars without rerunning the benchmark.

## Measurement contract

- **Workload:** committed compact JSON fixture `compact-json-v1`
  (69 bytes, sha256 `b5a3d6…36c9`, binary=false), echoed and validated
  byte-for-byte before a request counts as success.
- **Serial TCP RTT:** one established authenticated connection, one
  route, one request in flight; timing is issue-to-validated-terminal
  and excludes authentication, route setup, and admission waits.
- **Atomic floor:** full initiator→responder→initiator ping-pong on two
  pinned native threads (acquire/release on one padded cache line),
  batch-timed on the initiator; per-batch mean RTT is the observation.
  Timer bracket cost (~31 ns per `Instant::now()` pair) is retained,
  never subtracted.
- **Pairing:** ten fresh-process counterbalanced run blocks; each
  block's atomic-floor and serial-TCP attempts join on (build, host,
  ordered CPU pair, run block). Uncertainty is run-block spread plus a
  deterministic run-block bootstrap; individual requests are never
  bootstrapped.
- **Topology:** ordered pair (0, 1) — distinct physical cores, one NUMA
  node, shared unified L3 — validated from sysfs with singleton
  affinity readback before timing.

## Environment

| | |
| --- | --- |
| Host | dev-dsk-ahrav-2b (shared dev host) |
| CPU | aarch64, 32 cores, 1 socket, no SMT, one 32 MiB L3, 1 NUMA node |
| Kernel | 6.12.100-125.179.amzn2023.aarch64 |
| rustc | 1.94.1, release profile |
| Commit | `ed82528a` |
| Load (1 min) | ≈3–4 throughout collection (recorded per attempt in each manifest) |

## Budget table (same-L3 pair 0→1, 10 paired blocks)

| Quantity | Value |
| --- | --- |
| Atomic floor, median of block medians | **219 ns** (block spread 146–269 ns) |
| Serial TCP RTT p50, median of blocks | **24.2 µs** (block spread 23.9–24.6 µs) |
| Serial TCP RTT p99 (median of blocks) | 28.9 µs |
| Serial TCP RTT p99.9 (median of blocks) | 62.0 µs |
| Paired gap, median | **24.0 µs** (block spread 23.7–24.5 µs; bootstrap 95% 23.8–24.1 µs) |
| Paired ratio, median | **110×** (block spread 89–164×; bootstrap 95% 93–135×) |

Each serial repetition recorded 150,000 successful post-warmup
observations (headline p99.9 floor is 100,000); merged across blocks the
serial histogram holds 1.5 M samples. Atomic blocks each retain 200
batch means of 10,000 full round trips.

**Interpretation.** The atomic ping-pong is a cache-coherence lower
bound for moving one line between these two cores, not wholly
recoverable application headroom: any real transport still pays
serialization, syscalls or polling, scheduling, and protocol validation
on top of it. The budget says a loopback TCP round trip costs ~110×
the hardware floor on this host; a shared-memory transport has roughly
24 µs of theoretical room to claim some of.

### Cross-NUMA

Skipped (structured): the host has one CPU-bearing NUMA node, so no
cross-NUMA pair exists. Each block retains a skipped manifest with that
reason; no synthetic values were fabricated.

## Loaded TCP (open loop, frozen offered rates) — not RTT

Separate operating points, never comparable with or subtracted from the
serial RTT or the atomic floor. Medians across 10 blocks:

| Offered rate | sched→completion p50 | issue→completion p50 | scheduler lag p99 | sched→completion p99 |
| --- | --- | --- | --- | --- |
| 20 k/s | 612 µs | 131 µs | 1.05 ms | 1.14 ms |
| 50 k/s | 35.9 µs | 26.1 µs | 21.0 µs | 67.8 µs |
| 80 k/s | 58.9 µs | 44.4 µs | 26.5 µs | 100.1 µs |

Known generator ceiling, retained deliberately: at 20 k/s the
single-threaded generator sleeps between slots and tokio's coarse timer
wakes it up to ~1 ms late, so scheduled-to-completion at that point is
dominated by recorded scheduler lag, not host latency (the
issue-to-completion column and the lag column separate this exactly as
the contract requires). At 50–80 k/s the loop stays busy and lag
collapses. Outcome conservation held at every point; a 120 k/s pilot
point exceeded what the host tolerates on one connection (connection
retired before measurement) and is rejected as an invalid operating
point rather than reported.

Known defect in the retained 80 k/s evidence: one of its ten blocks
(b10) had its connection retired ~2.2 s into the 12 s window (393
peer-closed outcomes) yet was finalized as complete, because the harness
at that commit only checked conservation over the slots reached. The
harness now rejects any attempt whose connection fails before the
warmup+measure window completes. The effect on the published row is
small — recomputing the medians without b10 moves issue→completion p50
from 44.4 to 43.6 µs, lag p99 from 26.5 to 26.2 µs, and sched p99 from
100.1 to 99.9 µs — so the table retains the as-published values from
all ten blocks.

## Sustained TCP throughput (closed loop, depth 32) — not latency

Timestamp-minimal closed loop, medians across 10 blocks:

| Quantity | Value |
| --- | --- |
| Successful completions/s | **100.7 k/s** (block spread 99.8–102.1 k/s) |
| Offered = terminal = successful | yes (zero errors, zero losses) |
| Goodput (fixture bytes echoed) | 6.95 MB/s |

## Reproducing

```sh
# preflight + smoke on any Linux target host
./scripts/perf-mc-host.sh budget-preflight
./scripts/perf-mc-host.sh /tmp/smoke budget-smoke

# frozen final contract (this document's numbers)
./scripts/perf-mc-host.sh docs/perf/runs/ipc-budget-<UTC>-<commit> budget-final

# regenerate this document's tables from retained sidecars (requires a
# local copy of the git-ignored run directory)
./scripts/perf-mc-host.sh docs/perf/runs/ipc-budget-20260823T202243Z-ed82528a budget-summarize
```

Explicit pairs (`BUDGET_PAIR=a,b`, `BUDGET_CROSS_PAIR=a,b`) fail
preflight on any violation; auto-selection produces structured skips
for unavailable topology classes. `cargo bench -p mc-host --bench
ipc_budget` runs the Criterion scalar fixtures (developer regression
diagnostics only — retained histograms own every tail conclusion).
