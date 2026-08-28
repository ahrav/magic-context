# Synapse concurrency stop report

## Decision

**Inconclusive. No production topology decision and no concurrency knob.**

Gate 1 produced deterministic delay-engine mechanism evidence and a complete
provisional B0/B0 A/A schedule. It did not produce tiny-bundle ORT evidence:
`MC_SYNAPSE_TEST_ORT_LIBRARY` was absent, so no real-engine command ran and no
ORT result is claimed. Gate 2 did not open. At collection time,
`magic-context-c50.8` was `IN_PROGRESS`, while `magic-context-chj` and
`magic-context-18r` were `OPEN`. No production bundle, corpus, or ORT identity
was available to byte-verify.

KTD9 follows the frozen descriptive branch. There are no owner-set effect or
resource boundaries, no powered block count, no confidence intervals, and no
Holm correction. Point estimates cannot select or reject a topology.

## Evidence and provenance

Evidence lives under
`docs/perf/runs/synapse-concurrency-gate1-1af5dc75/`. The release artifact is
`target/release/examples/synapse_perf`, built with `bench-topology` from base
commit `1af5dc7549f57f3ab7c8d43d65e2695ecb34da3d`; its SHA-256 is
`6ad6d1ad4839f43e59f7574c8c8e00bf336396601e1c464d696ce6aafc0bca9c`.
The working tree was dirty because the driver provenance split and this report
were not committed. This is recorded rather than presented as a clean-commit
artifact.

`mechanism-provenance.json` records contract, driver, test, artifact, toolchain,
kernel, CPU-budget mechanism, and production-input absence. `commands.txt`
records every collection and verification command. The A/A and smoke
subdirectories contain manifests, realized argv, redacted environments, load
samples, exit status, raw-output digests, and `SHA256SUMS`. Top-level
`SHA256SUMS` covers the retained summaries and nested integrity manifests.

Delay-engine provenance is intentionally artifact-only. It contains no bundle,
ORT, model-file, or corpus identity because those inputs are neither required
nor used. Real-engine driver mode still requires complete bundle/model/ORT/
corpus provenance, byte-verifies every file before every letter, and requires
the c50.8/chj/18r entry-gate states.

## Gate 1 results

### Generator correction and retained invalid evidence

The first A/A attempt is retained under `aa/`. Its first slot failed with
`measured_offered=0`: rates of one query and one batch per second placed both
scheduled operations in the first 10% warmup window. This was a generator
configuration defect, not an SUT outcome. The driver now takes and records an
explicit base query rate and delay. Collection restarted in a new `aa-v2/`
epoch at 10 query sessions/s, 10 or 40 batch sessions/s, and 5 ms deterministic
service. The failed epoch was not overwritten or counted.

### B0/B0 provisional A/A

Two complete blocks ran at 4, 8, and 16 logical CPUs, including the supported
4-CPU co-tenancy construct. All 64 schedule positions exited zero, conserved
their ledgers, had zero missed slots, and were classified valid. Both labels
used the same artifact and B0 topology.

| CPU construct | Ratio | Query p99 range | Batch deadline goodput |
| --- | --- | ---: | ---: |
| 4 CPUs | 1:1 | 6.384–7.038 ms | 160 items/s |
| 4 CPUs | 4:1 | 6.084–7.209 ms | 640 items/s |
| 4 CPUs + one busy co-tenant | 1:1 | 11.179–12.482 ms | 160 items/s |
| 4 CPUs + one busy co-tenant | 4:1 | 7.528–12.331 ms | 640 items/s |
| 8 CPUs | 1:1 | 6.304–7.262 ms | 160 items/s |
| 8 CPUs | 4:1 | 6.040–7.197 ms | 640 items/s |
| 16 CPUs | 1:1 | 6.412–7.167 ms | 160 items/s |
| 16 CPUs | 4:1 | 6.033–7.112 ms | 640 items/s |

Mechanical A/A integrity passed. Null calibration remains descriptive and
inconclusive: no owner boundary classifies the observed spread, and co-tenancy
widens it. B0 screening cannot produce a retain decision because the frozen
query-p99 materiality boundary is absent and this engine is not the production
model.

### Topology smokes

One pinned 4-CPU mixed-arm delay-engine smoke ran for B0, T1(2), T2, T3, and
T4(2). Every run exited zero, conserved its ledger, recorded zero missed slots,
and reported no adverse outcome. Raw outputs remain in `smoke/`.

These smokes prove only construction, routing, accounting, and teardown for the
recorded mechanism. Their p99 values and RSS samples are not candidate
comparisons: each topology has one process observation, the delay engine does
not exercise ORT intra-op parallelism, the 1×16 T3 workload does not cross its
64-row chunk boundary, and delay-mode T4 does not load N model instances.

## Candidate evaluation within evidence scope

- **B0:** mechanically complete A/A and valid delay-engine smoke. Production
  query tail, goodput, CPU demand, RSS, and drain behavior remain unknown.
- **T1:** constructor/dispatch smoke passed. No ORT ran, so thread-scaling,
  spinning, idle CPU, and 4-CPU contention rejection conditions are unevaluated.
- **T2:** deterministic alternation/lifecycle tests and smoke passed. No
  production mixed-load comparison exists, so neither benefit nor starvation
  risk is resolved.
- **T3:** lifecycle and lane-recheck tests passed, but this smoke did not cross a
  chunk boundary. Throughput cost, padding behavior, publication semantics under
  production load, and result-byte bounds remain unevaluated.
- **T4:** pool lifecycle tests passed, but delay-mode smoke is not an N-model
  pool. N-times load/certification cost, weight RSS, startup cost, idle CPU, and
  representative-host capacity remain unevaluated.

No candidate meets a production rejection condition on available evidence, and
none has enough evidence for adoption.

## Gate 2 blockers and required owner inputs

Gate 2 requires all of the following before any production letter:

1. `magic-context-c50.8` complete with a byte-verified production bundle,
   manifest, model, corpus, and installed ORT identity.
2. `magic-context-chj` and `magic-context-18r` merged or owner-confirmed out of
   the declared collection window.
3. A real `MC_SYNAPSE_TEST_ORT_LIBRARY` path, version, and SHA-256. The current
   environment has no path.
4. Owner acceptance of the descriptive decision process and final human
   selection criteria, plus confirmation on representative low-core hardware
   before adoption because cpuset emulation does not reproduce cache, memory,
   NUMA, or turbo behavior.

Until those inputs exist, production A/A, the three-block variance pilot,
fixed-block treatment collection, service-demand bounds, Little's Law checks,
and candidate ranking do not run. USL is not applicable: declared T1 and T4
levels are fewer than six and have no inferential replication.

## Verification

- Driver tests: 7 passed.
- Default guard suites: 38 passed.
- `bench-topology` guard and topology suites: 46 passed.
- `synapse_perf` example tests: 13 passed.
- Release `synapse_perf` build: passed.
- Feature clippy with warnings denied: passed.
- `cargo fmt --check`: passed.

This stop report satisfies the plan-authorized U8 exit: retained mechanism-only
evidence, explicit Gate 2 blockers, candidate-by-candidate limits, and no
production change.
