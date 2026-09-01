# Research Report: A2 - Production and Ecosystem

## Coverage

Inspected gix 0.87.1, gix-revwalk 0.35.0, and gix-commitgraph 0.39.0 source shipped in the lockfile,
plus the current applicability implementation.

## Findings

**A2.F1: gix revision walks already consume commit-graphs**

- Claim: `Repository::rev_walk` automatically loads an enabled commit-graph; loading failure falls
  back to object traversal.
- Support: DIRECT, gix 0.87.1 `src/revision/walk.rs`, `Platform` docs and `selected`, lines 155-216
  and 282-332.
- Version scope: exactly the locked gix 0.87.1.
- Counter-evidence: benchmark fixtures have no commit-graph file, so current baseline measures the
  fallback path; the campaign's real repository does have `.git/objects/info/commit-graph`.

**A2.F2: gix exposes reusable graph and generation primitives**

- Claim: `Repository::revision_graph(cache)` creates a reusable `gix_revwalk::Graph`; lazy commits
  expose parents and optional generation, and absent commits return `None`.
- Support: DIRECT, gix 0.87.1 `src/repository/graph.rs`; gix-revwalk 0.35.0
  `src/graph/mod.rs` (`Graph::new`, `try_lookup`) and `src/graph/commit.rs`
  (`iter_parents`, `generation`).
- Applicability: direct to a request-local ancestry engine.

**A2.F3: Current warm hits rebuild cryptographic and owned keys**

- Claim: every object, including hits, clones four strings and recomputes/hex-formats SHA-256 over
  context and candidate inputs.
- Support: DIRECT, `engine.rs` `evaluate_batch`, `object_cache_key`, and `inputs_digest`.
- Measurement: local profile `perf-notes/profiles/batch-warm.md`.

**A2.F4: Fixed digest bytes preserve collision posture with less representation work**

- Claim: storing `Sha256::finalize()` bytes in cache keys removes hex formatting and its allocation
  without changing digest semantics.
- Support: DIRECT from sha2's fixed-output API already used by the code; project-specific encoding
  remains CONSTRAINT-DRIVEN.

## Lens conclusion

Reuse gix's graph primitives rather than adding a dependency. For batch keys, begin with fixed-byte
digests and shared digest prefixes; more invasive cache lookup redesign waits for re-profiling.

