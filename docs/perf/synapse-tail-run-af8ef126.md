# Synapse tail run at af8ef126

U7 result: **inconclusive; no variant selected**. The run attempted every
frozen A/A and treatment schedule position, but the harness could not produce a
complete admissible matrix. This is a harness/schedule blocker, not evidence
that queueing is engine-bound.

Local raw bundle: `docs/perf/runs/synapse-tail-af8ef126/` (gitignored).
Integrity manifest: `docs/perf/runs/synapse-tail-af8ef126/SHA256SUMS`.
Release artifact SHA-256:
`3524f6744a8ddda4afebf876be6b85cd26ed34c15bd758c7280adef82a241ba7`.

## Collection

- Commit: `af8ef1264f5af48fc8e27a8115b804a2a66d50f1`.
- Duration: 2026-08-26 19:45:41Z to 20:47:15Z, 61 minutes 34 seconds wall time.
- A/A: 576/576 positions attempted; 299 valid, 277 invalid.
- Treatment: 2,304/2,304 positions attempted; 1,244 valid, 1,060 invalid.
- Validation: every emitted summary passed logical and attempt ledgers, raw
  logical/attempt counts, and raw service-sample counts. Invalid attempts were
  retained and never replaced.
- USL: not applicable because the design has two descriptive repetitions and
  the gate requires at least five repetitions with confidence intervals.

## Decision

No candidate satisfies the full nine-criterion selection gate in this epoch.
Valid cells show that A removes the query retry staircase at 25 ms service and
C removes much of the 50 ms batch-poll step at 5 and 25 ms service. But the A/A
control was unstable, ten frozen rates were rejected by the scheduler's exact
nanosecond interval requirement, and high-load batch cells produced fatal
outcomes. K=1 is the smallest feasible positive bound, but the strict terminal-
blocking objective did not distinguish it because valid 1.0x baseline cells had
zero terminal rejection.

Rejected alternatives remain unchanged: D needs a completion notifier and
per-method handler accounting; push is a separate protocol change; unbounded
waiting, retries, or deadline extension remain prohibited.

Residual risks: unsupported frozen rates, high-load batch job eviction and
connection loss, wide A/A p95 range, coarse CPU tick resolution, missing
per-block host-load samples, and no production-bundle confirmation.

Blockers: U7 needs a new versioned harness epoch before selection.
`magic-context-c50.8` remains in progress and blocks U8. `magic-context-18r`,
`magic-context-chj`, and `magic-context-ioi` remain open.
