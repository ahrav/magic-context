# docs/ index

Map of the tracked documentation tree. Root-level `STRUCTURE.md`,
`ARCHITECTURE.md`, `CONFIGURATION.md`, `AUDITOR.md`, and `README.md` carry the
top-level narrative; this directory holds the specs, evidence, and working
records behind them.

## Protocols and subsystem references

- [mc-host-wire-protocol.md](mc-host-wire-protocol.md) — the module-host wire
  protocol spec (framing, auth, lifecycle, budgets).
- [mc-host-shm-transport.md](mc-host-shm-transport.md) — shared-memory
  transport design for the client↔daemon fast path.
- [migration-version-lanes.md](migration-version-lanes.md) — SQLite schema
  migration lanes and version fences.
- [synapse-model-bundle.md](synapse-model-bundle.md) — the bundled embedding
  model contract.
- [beads.md](beads.md) — condensed `bd` tracker reference.

## Specs

- [specs/context-window-geometry.md](specs/context-window-geometry.md) —
  window overlay geometry contract.
- [specs/git-dedup-heuristic.md](specs/git-dedup-heuristic.md) (+
  `git-dedup-goldens.json`) — commit-dedup heuristic and its golden set.
- `specs/prompt-surface/` — ratified prompt-surface records
  (sha256-pinned; see its own README).

## Performance records

- [rust-transform-perf-round4-2026-08-16.md](rust-transform-perf-round4-2026-08-16.md)
  — canonical round-4 transform/native-attachment performance record
  (absorbs the incremental-cache design and the native roll-forward
  incident).
- [rust-mode-transport-overhead-2026-08-10.md](rust-mode-transport-overhead-2026-08-10.md)
  — measured framing-cost evidence (retained by the wire-protocol spec).
- [nudge-hygiene-calibration-2026-08-16.md](nudge-hygiene-calibration-2026-08-16.md)
  — note-nudge calibration record.
- `perf/` — frozen benchmark contracts and evidence bundles;
  [perf/synapse-tail-contract.md](perf/synapse-tail-contract.md) is the frozen
  acceptance contract and [perf/runs/README.md](perf/runs/README.md) indexes
  the synapse-tail epochs.

## Evidence and inventories

- `evidence/` — frozen verification artifacts (subc compiler closure,
  release qualification, shm traceability, retrieval benchmark, claims
  backfill, surface probes).
- [subc-api-surface-inventory-2026-08-17.md](subc-api-surface-inventory-2026-08-17.md)
  — the subc API surface inventory backing the mc-host boundary work.
- [prompt-surface-registration-fixture.md](prompt-surface-registration-fixture.md)
  — prompt-surface fixture provenance notes.
- [AUDIT-KNOWN-ISSUES.md](AUDIT-KNOWN-ISSUES.md) — piolium audit
  known-issues ledger.

## Working areas

- `plans/` — gitignored working plans (untracked by design).
- `plans-archive/` — tracked, completed plan records.
- `research/` — audit and research records.
