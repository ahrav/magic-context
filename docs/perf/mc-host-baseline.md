# mc-host performance baseline — measurement contract v1

Status: contract frozen before first collection. Results appended below.
Owner: PR 6 perf pipeline. No repository performance policy exists; nothing
here is a pass/fail threshold. Numbers are evidence for optimization
decisions on `crates/mc-host` only.

> **Erratum (IPC budget follow-up).** Three properties of this contract
> make its numbers non-comparable with the IPC budget in
> [mc-host-ipc-budget.md](./mc-host-ipc-budget.md), which is the
> authority for transport comparisons going forward:
>
> 1. **Closed-loop latency did not use the documented actual-send
>    boundary.** The load generator subtracted the *scheduled* timestamp
>    in closed-loop arms too, so "closed-loop p50" here includes
>    in-flight permit queueing, and headline closed-loop arms pipelined
>    32 requests — those values are queued completion latency, not
>    serial RTT.
> 2. **Raw request bodies.** Arms used a mode-byte + zero-fill body, not
>    the committed compact JSON fixture that matches the production
>    client's small-message shape.
> 3. **No topology contract.** Runs did not pin or verify CPU pairs, so
>    no hardware floor can be paired with these numbers.
>
> The results below stay frozen as recorded; do not infer improvements
> or regressions by comparing them against IPC-budget values.

## System under test

- `crates/mc-host` host runtime, release build (`--release`,
  `CARGO_PROFILE_RELEASE_DEBUG=true` for symbol attribution).
- Handler: `examples/perf_host.rs` `EchoHandler` — echoes the request body
  (mode byte 0) or sleeps N ms then echoes (mode byte 1). No JSON parsing on
  the request path, so handler cost is a floor, not a workload model.
- Transport: loopback TCP, three-message auth, one route per connection.
- Host config: `HostConfig::default()` (max_connections 64, pending 1024,
  handler tasks 256, resident bytes 256 MiB, writer queue 64 frames,
  frame_deadline 30 s, liveness off).
- Load generator: `examples/perf_load.rs`, separate process.

## Metrics and semantics

- **Completion latency**: terminal receipt minus *scheduled* send time —
  in every arm, including closed-loop (see erratum item 1). Closed-loop
  values therefore include in-flight permit queueing and estimate
  ceilings, not serial RTT.
- **Throughput**: completed terminals / wall seconds of send window.
- Percentiles computed over all requests of one run (exact, sorted vector).
- Steady state: first 10% of the send window discarded as warmup.
- Repeats: headline arms (A1) run 3×; the median-throughput run is reported.
  Other arms run 1× (mechanism probes, not estimates).
- Host-side allocations: counting global allocator in `perf_host`
  (relaxed atomics; adds one fetch_add per alloc — noted perturbation).
  Reported as allocs/request = delta(allocs)/completed.
- Syscalls: `strace -f -c` on the host process for a fixed-count arm;
  reported as syscalls/request by class. strace slows the host; those runs
  report counts only, never latency.
- CPU attribution: `perf record -e cycles:u` (paranoid=2 → user space only;
  kernel/syscall time invisible — syscall cost inferred from strace counts +
  latency deltas, not cycles).

## Synapse instrument semantics

`SynapseComponent::metrics()` returns a component-incarnation snapshot with these
top-level fields:

- `cpu_wait`, `cpu_hold`, and `inference`. Each contains `query` and `batch`.
  Each lane contains `buckets`, `count`, and `sum_us`.
- `cpu_wait_outcome`, which contains `query` and `batch` counter arrays.
- `queue_full`, `poll_outcome`, and `batch_items_embedded`.
- `free_cpu_permits`, `free_query_permits`, `jobs_active`, `jobs_retained`,
  `queued_text_bytes`, and `retained_result_bytes`.

The six duration histograms are `cpu_wait.query`, `cpu_wait.batch`,
`cpu_hold.query`, `cpu_hold.batch`, `inference.query`, and `inference.batch`.
Their fixed millisecond edges are
`[1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000]`, followed by an
overflow bucket. Bucket 0 is `[0, 1)` ms, each middle bucket is
`[previous_edge, edge)` ms, and the overflow bucket is `[5000, +∞)` ms. Each
observation increments one bucket and `count`. `sum_us` is the sum of observed
durations in microseconds and saturates at `u64::MAX`; the host does not
compute percentiles.

`cpu_wait` starts before the worker task is spawned, includes task-scheduling
delay, and records only waits that acquire a CPU permit. `cpu_hold` starts at
permit acquisition. Query hold ends after inference settlement and the worker's
result send. Batch hold ends after settlement and `publish_ready` or
`publish_failed`, so it includes publication copies and the job-table lock.
Thus hold includes inference plus settlement and publication work. The
per-lane accounting invariants are
`cpu_wait.count == cpu_wait_outcome.granted`,
`cpu_hold.count == cpu_wait_outcome.granted`, and
`inference.count <= cpu_wait_outcome.granted`. Lane-failure and shutdown
short-circuits after permit acquisition still record a hold but do not record
inference.

Counter arrays use these fixed slot orders:

- `cpu_wait_outcome.query`: `[granted, timeout, waiter_gone,
  cancelled_or_closed]`.
- `cpu_wait_outcome.batch`: `[granted, cancelled, closed]`.
- `queue_full`: `[parse_reservation_unsatisfiable,
  parse_resident_exhausted, coverage_short, query_admission, job_admission,
  result_page_resident]`.
- `poll_outcome`: `[restarted, key_mismatch, bad_cursor, failed,
  pending_queued, pending_running, page]`.

Query `timeout` and `waiter_gone` race at the same deadline. `timeout` means
the worker's timer won. `waiter_gone` means the response receiver disappeared,
including when the handler deadline won first. For a controlled run without
route loss or other receiver cancellation, consumers combine `timeout +
waiter_gone` when measuring deadline expiry while waiting for a CPU permit
rather than interpret either slot alone. General traffic cannot isolate that
expiry from these counters because `waiter_gone` also includes route loss. A
handler deadline reached after permit grant remains classified as `granted`.

Poll counters describe handler attempts, not jobs. Every `embed.result` request
that enters `handle_result` either increments `result_page_resident` before the
poll or increments exactly one `poll_outcome` slot after `JobTable::poll`.
`pending_queued` and `pending_running` split the internal pending result, and
`page` means the job table produced one page, so a multi-page job can increment
`page` several times. Later response reservation or encoding can still fail.
Requests rejected during decode or validation never enter this accounting. The
handler identity is therefore `requests entering handle_result ==
sum(poll_outcome) + queue_full[result_page_resident]`.

`batch_items_embedded` adds the number of texts once immediately before a batch
backend call. Together with `inference.batch.count`, it gives aggregate items
per completed backend call when the backend does not panic. A panicked call
adds its items but no inference observation. The counter does not provide
latency for any item.

The six depth fields are gauges computed when the snapshot is read rather than
stored metric counters. `free_cpu_permits` and `free_query_permits` read the
two semaphores; the query value is binary because that semaphore has one
permit. `jobs_active` counts stored jobs that are not complete,
`jobs_retained` counts completed jobs held for pickup, `queued_text_bytes`
counts the UTF-8 text bytes in admitted queued or running batches, and
`retained_result_bytes` counts vector bytes plus retained item ID and content
hash bytes. These are logical accounting bytes, not allocator residency.
Reading job depth takes the table lock but deliberately does not sweep expired
jobs. Gauges can therefore include expired jobs until another job-table
operation sweeps them.

Metric counters use relaxed atomics, and a snapshot reads counters and gauges
one at a time without a global consistency barrier. A snapshot taken during
updates can mix nearby instants and temporarily violate cross-field identities.
At quiescence, histogram and counter snapshots merge additively; gauges do not.
Compute counter and histogram deltas between quiescent snapshots for an
interval, assuming component-incarnation counters have neither wrapped nor
saturated.

Cardinality and content are fixed: the snapshot has 117 scalar values, uses no
string labels, and contains no job ID, request key, content hash, text, or
per-item state. It does not provide a total request-rate denominator, a count
of idempotent batch replays, or per-item latency. Those require separate
request accounting or tracing and must not be inferred from these counters.

### Synapse metrics overhead gate

Both arms used this command from their recorded environment files:

```text
cargo run -q -p mc-host --release --example synapse_perf -- --rate 1000 --seconds 5
```

The baseline artifacts are in
`docs/perf/runs/synapse-metrics-baseline-3dec75b9/` at commit
`3dec75b9ad5566833b5281680098266cceb9dde1`. Across n=3 runs,
successful-response throughput was
`[939.8, 938.8, 932.8]` requests/s and p99 was
`[1493141, 2041107, 1253284]` ns. The baseline min–max envelopes are
932.8–939.8 requests/s and 1,253,284–2,041,107 ns. Rejected responses were
`[301, 306, 336]`.

The post-instrument artifacts are in
`docs/perf/runs/synapse-metrics-after-6b491392/` at commit
`6b4913922b6cfe486c80d2d5507a1b34bd5bd1ba`. Across n=3 runs,
successful-response throughput was
`[931.2, 954.4, 934.0]` requests/s and p99 was
`[1696156, 1664541, 1704532]` ns. Post medians were 934.0 requests/s and
1,696,156 ns; both are inside the corresponding baseline envelope. Rejected
responses were `[344, 228, 330]`. Both p99 arrays contain successful responses
only.

Verdict: no detectable regression.

This is low-resolution evidence from three five-second runs per arm. Recorded
pre-run load also differed: 2.40/1.66/0.99 for the
baseline and 2.34/4.26/4.07 after instrumentation. Do not use this result to
claim a smaller effect than the run spread can resolve.

## Environment record (fill per collection)

host, kernel, CPUs, load before run, rustc, commit.

## Arms

| Arm | Purpose (finding) | Shape |
| --- | --- | --- |
| A1 | Baseline latency/throughput (#2,#4,#5,#6 scaling) | echo 256 B; conns {1, 8, 64}; closed-loop pipeline 32 for ceiling; open-loop at ~50% of measured ceiling for latency |
| A2 | Large-body copy cost (#3) | echo {64 KiB, 1 MiB, 16 MiB}; conns 4; pipeline 4 |
| A3 | Slow-consumer egress stall (#8) | 8 conns echo 256 B open-loop + 1 stalled conn holding 2×32 MiB responses; compare p99 vs A1; observe retirement at frame_deadline |
| A4 | Greedy-client permit starvation (#10) | 1 conn closed-loop depth 512 + 8 conns open-loop low rate; count server_busy on the 8 |
| A5 | Ingress-budget starvation / recovery (#9) | 24 in-flight 8 MiB sleep-2000ms bodies (≈192 MiB ingress) + 1 conn small echo; observe kills/latency; stop big load; verify recovery |
| ATTR | Attribution for #2,#3,#4,#7 | strace -c (syscall counts) and perf record (user cycles), A1-8conn and A2-1MiB shapes |

## Comparison rule for candidate changes

Same host, same commit-recorded contract, same arms, 3× A1 repeats,
median-run comparison per arm. Report absolute values and deltas with
run-to-run spread (min–max across repeats). No threshold classification —
`/performance:perf-regression` stays blocked until a repository policy
exists.

---

## Results

### Collection 1 — baseline `99a12e8e` vs candidate (opt1)

Environment: dev-dsk 128×CPU, kernel 6.12.95, rustc 1.97.1, shared box
(1-min load 39–42 at run start; treat single-digit-percent deltas as noise).
Raw runs: `docs/perf/runs/baseline-99a12e8e/` and `docs/perf/runs/candidate-opt1/`,
kept on the measurement host (`docs/perf/runs/` is git-ignored).

Candidate changes: buffered connection reads (64 KiB), uninitialized body
read via `read_buf`+`take`, split large-frame writes (no header-prepend
copy ≥ 16 KiB), amortized abort-handle pruning, `TCP_NODELAY` on accepted
sockets.

A1 closed-loop ceilings, 256 B echo (median of 3, rps):

| conns | baseline | candidate | Δ |
| --- | --- | --- | --- |
| 1 | 33.7k (p50 0.72 ms) | 76.5k (p50 0.23 ms) | +127% |
| 8 | 205.8k (p50 1.24 ms) | 204.5k (p50 1.22 ms) | ~0 (loadgen-bound) |
| 64 | 162.6k (p50 12.7 ms) | 243.5k (p50 8.4 ms) | +50%, negative 8→64 scaling gone |

A1 open-loop, 8 conns, 256 B:

| rate | baseline p50/p99/max (ms) | candidate p50/p99/max (ms) |
| --- | --- | --- |
| 20k | 1.99 / 3.22 / 60.5 | 1.17 / 2.14 / 2.8 |
| 100k | 2.27 / 3.31 / 51.3 | 1.39 / 2.31 / 6.3 |

A2 closed-loop, 4 conns × pipeline 4 echo (rps): 64 KiB 41.3k→42.3k;
1 MiB 4.09k→3.75k (box noise; echo-handler copy dominates);
16 MiB 158→190 (+20%, p50 93→79 ms).

Attribution (strace `-f -c`, 8 conns × pipeline 16, 256 B):
recvfrom/request 4.0→0.29; sendto/request 1.0→1.0;
host allocs/request ≈7.0→7.0 (unchanged; not a top cost).
perf cycles:u — small path: `AbortHandle::is_finished` scan gone
(3.5%→0); large path: `memset` of fresh body vectors gone (34.7%→0),
encode `copy_within` gone; remaining memmove is the echo handler's own
`reserve_output`+`extend_from_slice` copy plus BufReader drain.

Robustness arms (behavior, not thresholds):

- A3 slow reader holding 2×32 MiB echoes: victims p99 1.6 ms in both
  builds; host retires the stalled generation (writer frame_deadline).
- A4 greedy client (depth 512): victims p99 ≈2 ms, zero `server_busy`
  on victims in both builds.
- A5 ingress starvation (24×8 MiB sleeping bodies ≈ whole 192 MiB ingress
  pool): victims' 256 B requests stall p50 898 ms (baseline) / 500 ms
  (candidate); full immediate recovery after load stops in both.
  KNOWN CEILING, unchanged by design: the shared FIFO ingress budget
  head-of-line-blocks small frames behind large holders. Upgrade path if a
  real multi-client deployment needs it: reserved small-frame sliver or
  per-connection ingress sub-budgets.

Deferred (measured but not changed): two task spawns + settlement
machinery per request (~6% small-path cycles) — collapsing it reworks
first-terminal-wins arbitration for single-digit gain; per-request alloc
churn (~7 allocs/request) — below syscall/copy costs after this round.
