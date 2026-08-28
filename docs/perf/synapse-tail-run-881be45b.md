# Synapse tail run at 881be45b

U7 result: **provisional selection of variant `a+c` with `K=1`.** Eight of the
nine frozen acceptance criteria pass; criterion 8 (production-bundle
confirmatory run, R16) is gate-blocked because `magic-context-c50.8` remains
IN_PROGRESS, so the selection is provisional per the frozen stop condition.

Local raw bundle: `docs/perf/runs/synapse-tail-881be45b/` (gitignored).
Integrity manifest: `docs/perf/runs/synapse-tail-881be45b/SHA256SUMS`.
Release artifact SHA-256:
`304571f903697540689d755497f098b1db25cd6f7511868c5801abb76665aa66`.
Prior epochs `6e5ffc03` (pilot) and `af8ef126` (inconclusive) untouched.

## Collection

- Commit: `881be45b552625935a6b725a7ef830165a4c2f00` (clean tree, no commit made).
- Duration: 2026-08-26 22:15:21Z to 23:21:42Z, 66 minutes 21 seconds wall.
- Calibration: 4/4 valid; mean S 5.0567 ms and 25.0595 ms reproduced the
  af8ef126 rates exactly; every frozen rate executable this epoch.
- A/A: 576/576 attempted; 570 valid, 6 invalid (all single missed slots).
- Treatment: 2,304/2,304 attempted; 2,288 valid, 16 invalid (all missed
  slots); zero fatal errors, zero connection losses, zero ledger failures.
- Load average sampled before every phase block (af8ef126 gap closed).
- USL: not applicable — two repetitions without confidence intervals; the
  gate requires at least five repetitions with CIs.

## Decision

A/A control is **stable**: 284 paired valid cells, all six outcome medians at
unity (p95 median ratio 1.0002), 269/284 within ±10%; extremes confined to
sub-2 ms cells and one staircase-bimodal closed-loop cell.

`a+c` (K=1) removes both target modes against the hygiene-only reference:
query 1.0× p95 falls 585→10.0 ms (5 ms S) and 541→28.5 ms (25 ms S) with
amplification → 1.0 and terminal blocking 0.187/0.163 → 0; batch closed-1 p95
falls 51.6→13.6 ms (5 ms S) and 51.6→30.8 ms (25 ms S). Permit-wait p95 stays
3.5–6.7 ms against the descriptive 100 ms budget. Overload stays explicit
`queue_full` with bounded amplification (max 17.8, poll max 27; query-arm 2×
amplification 2.9–3.3 versus baseline 7.4). K=1 is the smallest feasible
positive bound; K=2 is indistinguishable at 1.0×.

Recorded trade-offs: ~2 ms fast-first regression on already-ready zero-delay
batch paths (p95 0.18→2.29 ms), roughly 2–3.7× voluntary context switches from
escalating polls, and slightly more terminal rejection than A alone at 2×
query overload (bounded, explicit).

Rejected alternatives unchanged: A alone (leaves 50 ms poll quantization), C
alone (leaves query staircase), B (keeps loss semantics), D (needs completion
notifier and per-method handler accounting), push/E (protocol change).
Unbounded queues, waiters, and deadline extension remain prohibited.

No production bundle was built or run; U8 remains gated on
`magic-context-c50.8` (IN_PROGRESS). `magic-context-18r`, `magic-context-chj`,
and `magic-context-ioi` remain OPEN; every queue model here assumes c = 1.


## Warmup re-analysis

The original analysis missed the frozen first-10%-of-hold warmup exclusion. A post-hoc timestamp re-analysis of the retained raw evidence applied that pre-collection rule without recollection; headline directions, candidate zero terminal blocking, A/A medians, and K=1 feasibility remain intact, so the provisional `a+c` K=1 selection is unchanged.

That re-analysis is approximate, not exact. This epoch's harness never emitted its hold origin, so the script reconstructs it from the earliest observed start, which cannot precede the true origin. Both boundaries therefore sit later than frozen by the startup delay, admitting some startup interval as measured and an equal tail of post-boundary sends. See `docs/perf/runs/synapse-tail-881be45b/report.md`, "Boundary reconstruction is approximate". Exact application requires recollection with the boundaries emitted.
