# Shared-memory hardware envelope

## Installed release gate

`scripts/mc-shm-release-gate.ts` compares an installed shared-memory ring
package with a frozen pre-cutover TCP run. It does not run a TCP implementation
from the current source tree. The baseline is immutable JSON whose file digest,
source commit, and package digest are pinned by
`release/mc-shm-release-gate.json`.

The candidate collector must run the installed package under Bun and Node and
emit `magic-context.mc-shm-installed-performance-suite/v1` JSON containing one
ordered `magic-context.mc-shm-installed-performance-run/v1` run for each
runtime. Missing either runtime blocks the gate. `run` executes only a
digest-bound collector without a shell and passes the package path in
`MC_SHM_PERF_PACKAGE`. `verify` accepts an already collected candidate file.
Both paths reject source-tree evidence, candidate TCP transport, interrupted or
missing blocks, malformed fields, and mixed host, runtime, harness, or workload
identity.

Each block records a unique process ID, raw latency observations, elapsed time,
completed operations, body-copy count, allocation count, CPU time, and wakeups.
Duplicate process IDs are rejected. The report derives p50 and p99 latency,
throughput, and totals for the remaining metrics. Its schema is frozen in
`docs/perf/mc-shm-release-gate-report.schema.json`.

The report can say only `blocked`, `ready`, or `evidence_complete`. It cannot say
that either arm passes, wins, or regresses because no performance threshold is
part of this task's contract. A policy decision must consume the descriptive
comparison separately.

Check current readiness without collecting data:

```bash
bun scripts/mc-shm-release-gate.ts status release/mc-shm-release-gate.json
```

Run the release-gate script tests from the repository root:

```bash
bun test scripts/mc-shm-release-gate.test.ts
```

Run a configured installed-path collector on the designated host:

```bash
bun scripts/mc-shm-release-gate.ts run \
  release/mc-shm-release-gate.json \
  artifacts/mc-shm-release-gate-report.json
```

Validate an existing candidate run against the frozen baseline:

```bash
bun scripts/mc-shm-release-gate.ts verify \
  release/mc-shm-release-gate.json \
  artifacts/candidate-run.json \
  artifacts/mc-shm-release-gate-report.json
```

The checked-in configuration is blocked. No designated benchmark host or
qualified frozen TCP artifact is available. This is an explicit failed release
gate, not a synthetic benchmark result. The machine-readable evidence is
`release/mc-shm-release-gate-report.json`.

## Current verdict

**INCONCLUSIVE / NO QUALIFYING ARM**

Manifest: `crates/mc-shm-transport/benches/manifests/v1.json`, schema version 1.

No production or default shared-memory provider ships. Production host and client provider registries remain empty.

Current disqualification reasons are exact and cumulative:

1. Linux and macOS designated-host fields are `UNSET_REQUIRES_DESIGNATED_HOST`.
2. No designated-host paired statistical campaign has run.
3. Explicit host shared-memory control performs one accounted receive copy through `lease.to_vec()`. It is non-selectable and cannot support zero-copy or hardware-limited claims.
4. Cold native wake behavior has not qualified against a paired H2 control.
5. macOS has not run on the current Linux host.

Native addon mechanisms and TypeScript lease propagation activate under Bun 1.4.0. Hosted Node 24 aborts inside `napi_detach_arraybuffer`, so Node preflight omits shared memory before alias creation and records the runtime as unavailable. This clean omission does not substitute for H2 paired measurements and does not change the verdict.

## Smoke evidence

Run:

```sh
out="docs/perf/runs/mc-shm-smoke-$(date -u +%Y%m%dT%H%M%SZ)"
sh scripts/perf-mc-host.sh "$out" shm-smoke
```

Script source-builds `hardware_envelope`, runs `--smoke`, and retains one JSON document at:

```text
$out/hardware-envelope-smoke.json
```

Smoke output is structured as schema 1 with:

```json
{
  "campaign": "smoke_non_selecting",
  "manifest": "benches/manifests/v1.json",
  "verdict": "INCONCLUSIVE",
  "selection": "NO_QUALIFYING_ARM",
  "verdict_reasons": [
    "designated_hosts_unset",
    "paired_statistical_campaign_not_run",
    "host_explicit_control_has_one_accounted_receive_copy",
    "cold_native_wake_not_qualified",
    "macos_not_run"
  ]
}
```

Elapsed measurements in local smoke output are plumbing evidence only. They are not published thresholds, benchmark winners, or hardware claims.

## Counters and purity gate

Every attempt records:

- `body_copies`
- `native_allocations`
- `syscalls`
- `park_wakes`
- `generic_queue_hops`
- `scheduler_handoffs`

`injected_avoidable_operations` is a non-selectable gate-control arm. It injects one copy, native allocation, queue hop, syscall, park/wake, and scheduler handoff. `purity_gate_rejects_injected_copy_allocation_queue_and_wake` proves the gate emits each R18 disqualification reason. A harness that stops recording one of these fields fails manifest traceability rather than silently qualifying the arm.

Hot selectable evidence requires every counter above to be zero. Cold evidence may retain only a separately qualified native park/wake and matching scheduler transition. No cold exception is currently qualified.

Required JavaScript wrapper and external-ArrayBuffer allocations belong in the paired H2 runtime control. They must never be reported as zero transport cost merely because the Rust harness cannot see them.

## Arms

| Family | Arms | Selection status |
| --- | --- | --- |
| H0 | `h0_metadata_cacheline_ping_pong` | non-selectable hardware control |
| H1 | `h1_raw_descriptor_ring_payload_touch` | non-selectable analytic/raw-ring control |
| H2 | `h2_rust_napi_runtime_crossing` | non-selectable runtime control; mechanism tests exist, paired campaign absent |
| ownership ablations | copied/direct producer crossed with copied/leased receiver | non-selectable |
| context controls | Unix socket and TCP | non-selectable |
| gate control | `injected_avoidable_operations` | always non-selectable and expected to fail purity |
| candidates | `ring`, `iceoryx_0_9_3` | selectable only after full qualification |

H0 measures metadata/cacheline exchange. H1 measures raw descriptor-ring payload touch and still requires analytic validation. H2 must include Rust, N-API, runtime-required object allocation, alias revocation, and completion behavior under actual Bun and Node runtimes. TCP-gap recovery remains context only.

## Designated campaign procedure

A full campaign is explicit. `shm-evidence` refuses to run unless both conditions hold:

- `MC_SHM_DESIGNATED_HOST=1`
- every `UNSET` field in manifest v1 has been replaced before the campaign, including designated host identity and frozen equivalence margin

Preparation on each designated Linux or macOS host:

1. Record redacted host identity, CPU and memory topology, clock and power policy, OS/kernel, compiler, Bun, and Node versions in manifest v1.
2. Freeze A/A-derived equivalence margin before candidate runs.
3. Verify core placement, park state, prefault state, and all counter collectors.
4. Source-build Rust host, transport, iceoryx2 0.9.3, and native addon.
5. Run native and plugin lifetime suites under Bun. Under Node 24, require either a subprocess-proven safe detach mechanism or clean preflight omission.
6. Run every manifest workload class, payload boundary, depth, scheduling family, seed, and ABBA/BAAB period without changing the frozen manifest.
7. Retain failed and interrupted attempts. Do not delete them from the aggregate.
8. Apply simultaneous paired intervals and the preregistered `WINNER`, `HARDWARE_EQUIVALENT`, or `INCONCLUSIVE` predicates.

Command after manifest freeze:

```sh
out="docs/perf/runs/mc-shm-designated-$(date -u +%Y%m%dT%H%M%SZ)"
MC_SHM_DESIGNATED_HOST=1 \
  sh scripts/perf-mc-host.sh "$out" shm-evidence
```

The current manifest is intentionally unset, so this command currently refuses before measurement. Smoke remains available for harness validation. No hosted CI job runs hardware thresholds.

## Evidence boundary

Only a complete designated-host campaign can retain a target profile. Correctness tests, hosted CI, raw Rust smoke, native mechanism probes, and host control results remain supporting evidence. If no arm satisfies correctness, lifecycle, counter purity, and paired statistical predicates, action remains `ship_no_shared_memory_provider`.
