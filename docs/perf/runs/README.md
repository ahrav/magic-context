# Synapse tail evidence epochs

Each subdirectory is one frozen U7 evidence epoch: the canonical `report.md`,
its integrity `SHA256SUMS`, the environment record, and the analysis scripts.
Raw sample subdirectories are gitignored per the frozen contract
(`.gitignore`, `docs/perf/` block); the tracked report, manifest, environment,
and hashes are retained. Prior epochs are never rewritten — each new epoch
links, and supersedes only by selection status.

## Epoch index

| Epoch | Commit | Status | Canonical report |
| --- | --- | --- | --- |
| `synapse-tail-6e5ffc03` | `6e5ffc03` | **INCOMPLETE** (pilot) — valid for its recorded cells; the release harness could not produce the full frozen R3 matrix | [report](synapse-tail-6e5ffc03/report.md) |
| `synapse-tail-af8ef126` | `af8ef126` | **INCONCLUSIVE** — every schedule position attempted (A/A 299/576 valid, treatment 1,244/2,304 valid); a harness/schedule blocker, not evidence that queueing is engine-bound | [report](synapse-tail-af8ef126/report.md) |
| `synapse-tail-881be45b` | `881be45b` | **PROVISIONAL SELECTION — variant `a+c`, `K=1`.** Eight of nine frozen acceptance criteria pass; criterion 8 (production-bundle confirmatory run, R16) stays gate-blocked on `magic-context-c50.8` | [report](synapse-tail-881be45b/report.md) |

## Selection headline (881be45b)

`a+c` (K=1) removes both target modes against the hygiene-only reference:
query 1.0× p95 falls 585→10.0 ms (5 ms S) and 541→28.5 ms (25 ms S) with
amplification → 1.0 and terminal blocking 0.187/0.163 → 0; batch closed-1 p95
falls 51.6→13.6 ms (5 ms S) and 51.6→30.8 ms (25 ms S). Permit-wait p95 stays
3.5–6.7 ms against the descriptive 100 ms budget. K=1 is the smallest feasible
positive bound; K=2 is indistinguishable at 1.0×.

Recorded trade-offs: ~2 ms fast-first regression on already-ready zero-delay
batch paths, roughly 2–3.7× voluntary context switches from escalating polls,
and slightly more terminal rejection than A alone at 2× query overload
(bounded, explicit).

The 881be45b report also carries the post-hoc **warmup re-analysis** (the
frozen first-10%-of-hold exclusion applied by timestamp re-analysis without
recollection): headline directions, candidate zero terminal blocking, A/A
medians, and K=1 feasibility remain intact, so the provisional `a+c` K=1
selection is unchanged. The reconstruction is approximate — see the report's
"Boundary reconstruction is approximate" — and exact application requires
recollection with the hold boundaries emitted.

Rejected alternatives (unchanged across epochs): A alone (leaves 50 ms poll
quantization), C alone (leaves query staircase), B (keeps loss semantics),
D (needs a completion notifier and per-method handler accounting), push/E
(protocol change). Unbounded queues, waiters, and deadline extension remain
prohibited.

Other run families in this directory (`ipc-budget-*`, `synapse-metrics-*`)
follow the same frozen-bundle convention and are indexed by their own
`report.md` files.
