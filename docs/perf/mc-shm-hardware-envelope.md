# Shared-memory hardware envelope

## Installed release gate

`scripts/mc-shm-release-gate.ts` compares installed pre-change and candidate ring artifacts. Both arms must use transport `ring`, identical runtime, host, harness, workload, and callback-budget identities, and independent process blocks. Candidate TCP and source-tree evidence are rejected.

Each paired block retains workload (`setup`, `cold_first_frame`, `end_to_end`, `active_path`, or `idle`), connection count (1, 8, or 64), callback budget, raw latency observations, event-loop delay, throughput inputs, CPU, RSS/PSS, residency, page-table bytes, fd and watcher counts, eventfd attempts/successes/`EAGAIN`/reads, parks, spurious wakes, publications, TSFN callbacks, scheduler handoffs, reclaim scans/bytes/runs, `MADV_REMOVE` calls/pages, copies, allocations, queue hops, and wakeups. The report schema is `docs/perf/mc-shm-release-gate-report.schema.json`.

Local measurement and designated-host release readiness are separate fields. Local evidence can be complete while `designated_host_verdict.state` remains `blocked`. A blocked Node baseline remains a performance-evidence blocker under A6; it is never converted to pass or regression and does not waive Node correctness.

```bash
bun scripts/mc-shm-release-gate.ts status release/mc-shm-release-gate.json
bun test scripts/mc-shm-release-gate.test.ts
```

`run` executes only a digest-bound installed-artifact collector. `verify` accepts an existing candidate suite. Both refuse to overwrite reports.

## Current verdict

**LOCAL BLOCKED / DESIGNATED HOST BLOCKED**

No frozen pre-change ring A/A artifact exists. No designated-host campaign ran. No callback-budget sweep ran. No equivalence margin, resource ceiling, or supported tmpfs/cgroup envelope is claimed. `release/mc-shm-release-gate-report.json` records these blockers without synthetic measurements.

## Fixed harness identity

`crates/mc-shm-transport/benches/hardware_envelope.rs` exercises one `eventfd_sparse_ring` profile. It uses eventfd-backed ring waits, not `SchedulingMode`, 50 microsecond sleeps, TCP, or Unix-socket fallback arms. The smoke campaign is local mechanism evidence only and cannot produce a designated-host verdict.

`crates/mc-shm-transport/benches/manifests/v1.json` fixes:

- Linux-only host designation;
- exact 64 MiB and 64 MiB plus one probes;
- 1, 8, and 64 connection campaigns;
- one eventfd sparse-ring profile;
- `UNSET_REQUIRES_REACTOR_SWEEP` callback budget;
- `UNSET_REQUIRES_AA_PILOT` equivalence margin;
- `UNSET_REQUIRES_DESIGNATED_HOST` tmpfs/cgroup envelope.

Run local smoke evidence:

```bash
bash scripts/perf-mc-host.sh shm-smoke
```

Run designated evidence only on the declared host after every manifest field is frozen:

```bash
MC_SHM_DESIGNATED_HOST=1 bash scripts/perf-mc-host.sh shm-evidence
```

The script rejects designated execution while manifest fields remain `UNSET` and refuses existing evidence files.

## Resource accounting

One connection transfers two memfds and four eventfds. It charges 64 ring descriptors, 128 MiB sparse virtual arena capacity, 64 leases, two mappings, six file descriptors, one client instance, no endpoint worker, and no pinned worker. JS integration owns one environment watcher. Application bytes remain in memfd-backed rings. Setup socket, eventfds, and TSFN callbacks carry control or readiness only.

## Platform boundary and Darwin inventory

Native shared-memory support is `linux-x64-gnu` only. Repository Darwin references were inventoried before withdrawal:

- `mc-host-darwin-arm64` and `mc-host-darwin-x64` host payload packages remain for unrelated host distribution;
- release-manifest and payload tooling still describes those host packages;
- `@cortexkit/mc-shm-native` selects only `linux-x64-gnu`;
- macOS shared-memory source-build and runtime CI execution was removed;
- capability tests assert Darwin x64 and arm64 are unsupported before addon loading.

Repository inventory does not prove whether an active deployment still requires Darwin shared-memory transport. Owner confirmation remains a release blocker. No second readiness, reclaim, polling, or fallback implementation exists.
