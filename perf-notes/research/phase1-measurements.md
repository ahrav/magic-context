# Research Report: A4 - Measurements and Workload Sensitivity

## Coverage

Used the committed Criterion baseline, identical-artifact A/A calibration, and two clean perf
profiles. External cache papers were treated as workload-specific rather than transferred.

## Findings

**A4.F1: Ancestry cost scales with traversed loose history**

- Claim: near 10k ancestry is about 165us while far/unrelated is about 135ms; stable perf profiles
  attribute the far path to zlib/object decode and traversal.
- Support: DIRECT, `target/criterion/**/main/estimates.json` and
  `perf-notes/profiles/ancestry.md`.

**A4.F2: Warm batch cost is key proof, not verdict cloning**

- Claim: SHA-256 is 40%, SipHash 10%, and allocator functions about 30% of warm 512-candidate
  cycles.
- Support: DIRECT, `perf-notes/profiles/batch-warm.md`.

**A4.F3: Snapshot cost scales with dirty discovery**

- Claim: clean snapshot is about 0.76ms and 1,000 untracked files about 7.45ms.
- Support: DIRECT, committed Criterion baseline.
- Limitation: no monitor-backed alternative exists in the harness.

**A4.F4: Cache-policy workload is unmeasured**

- Claim: no hit-rate, reuse-distance, scan-storm, or one-hit-wonder trace exists for this engine.
- Support: DIRECT absence from current telemetry and benchmarks.
- Decision effect: policy comparisons are not decision-grade.

## Lens conclusion

Prioritize ancestry and warm key construction. Snapshot reuse and policy changes need new evidence;
path tries and interval rewrites are below the measured floor.

