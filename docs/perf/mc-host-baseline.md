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

- **Completion latency**: terminal receipt minus *scheduled* send time
  (open-loop arms) — coordinated-omission honest. Closed-loop arms measure
  from actual send and are labeled closed-loop; they estimate ceilings, not
  latency.
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
