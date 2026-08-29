# Stale-findings ledger — DRY audit remediation (2026-08-29)

Execution branch: `chore/dry-audit-exec-2026-08-29`. Every audit finding was
re-verified against worktree HEAD immediately before application. Findings that
no longer matched were skipped without substitution and recorded here.

## Pre-existing gate failures (baseline, before any change)

Recorded on the untouched worktree at `171ffd3e^` (code identical to
`9c1eb4d1`). Typecheck and both lints are green. The failing suites below are
environment-dependent (mc-host native lifecycle) and fail on the untouched
tree; later gate runs are interpreted modulo this exact set.

- TS (`sh scripts/test-shard.sh packages/plugin`): 31 failures confined to
  `src/shared/mc-host-lifecycle/policy.test.ts` (28),
  `src/hooks/magic-context/module-transport.test.ts` (2),
  `src/features/magic-context/memory/storage-claim-operations-crash.test.ts` (1).
  `pi-plugin`, `cli`, `retina-local-fs` suites: green.
- Rust (`cargo nextest run --workspace --no-fail-fast`): 7 failures —
  `mc-module::lifecycle_cli` (6 tests) and
  `mc-host::shm_transport preflight_matrix_keeps_static_and_dynamic_states_distinct_and_side_effect_free`.

## Held items (bead-check verdicts)

- `seed_workspace_member` (mc-store/src/lib.rs): HOLD — beads 6bd and a7v are
  open and both plan mc-store workspace-member prune/write changes; the seam
  stays.
- `hardware_matches` (mc-shm-transport/src/descriptor.rs): HOLD — ymc.12 is
  in-progress (P1) on the shm transport backend qualification; the descriptor
  predicate stays.

## Stale findings (dropped)

| Finding | Reason |
|---|---|
| features T0-1/CC-4 (storage-meta.ts half) | Gate-narrowed: replacing `storage-meta.ts` with three `export *` lines widens its surface by 45 unintended names (declaration-surface diff). Applied the `storage.ts` half only (+1 blessed name, `PendingSessionCleanupRetryResult`). |
| mc-module T0-2 (test-only `stats` fields) | Stale: four test readers exist at HEAD, not two; `lib.rs` tests also assert `delta_fallback_reason` from the stored stats, and the apply-once path exposes no `cache_stats` alternative. Fields kept. |
| mc-host F3a / F3b / F3d | Premise fails: `harness_closure.rs` is compiled standalone by `tests/harness_closure.rs` via `#[path]`, so it cannot import `crate::instance`. Only F3c (generation.rs `owner_uid` fold) applied. |
| hooks O1 (3 of 21 symbols) | Drifted: `hasLoggedCtxReducePermissionDeny`, `markCtxReducePermissionDenyLogged` (consumed by `transform-postprocess-phase.ts`) and `resetNoteNudgeCooldownOnly` (consumed by `hook-handlers.ts`) now have external consumers; kept exported. |
| docs D2 (`autoresearch-results.tsv`) | Already absent at HEAD; nothing to remove. |

## Wave review dispositions

- Wave 1: independent fresh-context review (claude CLI, print mode) over
  `b4f75a88..2114cd06`; 20 findings. Fixed in `995e732c`: unused imports,
  dangling doc comments, three comment rewrites that inverted or weakened
  meaning, stale mirror references, benchmark header, docs index link, RSS
  guidance reconciliation, `S_ISVTX` visibility revert, additional stale
  dashboard-consumer comments. Declined: `export *` barrel revert (covered by
  the declaration-surface gate), `issue-135-wire-fixtures.ts` rename (not
  scheduled in Wave 1), `paths.ts` alias collapse (Wave 2c / F-8),
  `mural-selection.ts` file move (beyond minimal edit), auto-search no-op
  deletion (F-22 T2 slice, deferred), `MAX_EMERGENCY_REQUEST_BUDGET` doc
  wording (minor, pre-existing).

## Guarded skips (report scheduled work the guard forbids)

| Finding | Guard |
|---|---|

## Exclusions carried by plan decisions

- KTD10 bead-gated T2 items: C14 (0fm), C15/M9-hooks (80a), F6 mc-host (kp5),
  mc-module T2-3 (q4i), F13a (ymc), F-11/F-12 (c50).
- KTD7: mc-host F9 filed as a bead, not implemented.
- KTD11: tests T2-1 (`project-security.test.ts` deletion) prepared but held for
  human sign-off; file kept.
- KTD8: claim-payload round-trip fixture filed as a bead (0fm-gated).

## Bead count reconciliation

(recorded during Wave 4)
