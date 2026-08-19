# mc-host performance baseline — measurement contract v1

Status: contract frozen before first collection. Results appended below.
Owner: PR 6 perf pipeline. No repository performance policy exists; nothing
here is a pass/fail threshold. Numbers are evidence for optimization
decisions on `crates/mc-host` only.

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

(appended per collection)
