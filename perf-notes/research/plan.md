# Evidence-Backed Research Plan

1. Batch digest representation.
   Files: `crates/mc-store/src/kernel/applicability/engine.rs`.
   Rationale: C6-C7. Store SHA-256 outputs as `[u8; 32]`; clone a precomputed batch prefix before
   candidate-specific fields. Preserve exact digest bytes with a differential test.
2. Re-profile warm 512-candidate batches.
   Files: benchmark/profile artifacts only.
   Acceptance: key hashing remains correct; SHA/allocator share and Criterion warm cells improve
   beyond A/A drift without cold/adversarial regressions.
3. Request-local ancestry graph prototype.
   Files: `checkout.rs`, `resolve.rs`, ancestry tests/benches.
   Rationale: C1-C4. Use locked gix graph primitives, optional commit-graph generation cutoff,
   current walk fallback, per-pop budget checks, and the existing cap.
4. Snapshot and policy remain unchanged.
   Rationale: C5/C8. Reopen only when a monitor API or workload trace exists.

Validation: Phase 1 differentials, exact mc-store guard, per-kernel Criterion cells, full geomean,
and repeated perf profiles. All project-specific digest splitting and budget charge order are
CONSTRAINT-DRIVEN and must be independently tested.
