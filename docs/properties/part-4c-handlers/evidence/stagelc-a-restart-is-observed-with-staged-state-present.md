# stagelc-a-restart-is-observed-with-staged-state-present

## Discovery trigger

Both restart records in this lens describe what happens when a process boundary
is crossed while a coordination is in flight. Neither can be refuted by a
campaign that never restarts mid-sequence. This is the situation-coverage marker
that makes them non-vacuous, and it is a `sometimes` rather than a `reachable`
for the same reason as the mid-sequence marker: the operational situation is the
thing under test, not the reset statement's lines.

## Evidence trail

All lines read back at `HEAD` = `b5dc778e`;
`git diff --stat 76cd6f41 b5dc778e -- crates/mc-module/` is empty.

The two sides of the boundary, both observable:

- `:12048` — `async fn shutdown(&self) -> Result<(), ShutdownError>` in the
  `CompositeComponent` impl (`:11934-12115`).
- `:12095-12099` — inside it, the three coordinators are replaced with fresh
  `Default` values:

  ```
  *self.state_sync_seeds.lock()... = StateSyncSeedCoordinator::default();
  *self.transform_pages.lock()... = TransformPageCoordinator::default();
  *self.state_imports.lock()... = StateImportCoordinator::default();
  ```

  This is the graceful side. It is the only place that empties the page
  coordinator's `sessions` map, since that impl has no removal path.
- `:3463-3467` — construction produces empty coordinators, so the post-boundary
  state is directly assertable on a fresh handler.
- `:946-955`, `:1075-1085`, `:1349-1360` — the three `Default` impls, each with an
  empty `sessions` and `total_staged_bytes: 0`.

The pre-boundary state that must be present for the marker to mean anything:

- `:1035-1039` — a `TransformPagePhase::Collecting(PendingTransformPage)` phase,
  whose `pages.len()` is the staged item count and whose `total` is the series
  length.
- `:906-911` — the seed equivalent, `Collecting(PendingStateSyncSeed)` with
  `batches` and `total`.
- `:1334-1337` — the import equivalent, `Collecting(PendingStateImport)` with
  `compartments` and `batch_count`.

The abrupt side of the boundary, which behaves differently and must be covered
separately:

- An abrupt termination never runs `:12095-12099`. The distinction matters
  because only the graceful path is observable from inside the old process, and
  because a campaign that only ever calls `shutdown` would never exercise the
  abrupt case at all.
- `src/bin/ck_mc_host/serve.rs:603-620` — the daemon installs a
  `SignalKind::terminate` handler and drives a graceful shutdown, so SIGTERM
  takes the graceful path. A `kill -9` or a panic-abort takes the abrupt one.

Reachability, both sides per METHOD.md rule 4:

- Config default: the reset at `:12095-12099` is on the unconditional
  `CompositeComponent::shutdown` path, and paging is not config-gated.
- Shipped setup path: the daemon lifecycle is
  `src/bin/ck_mc_host/serve.rs`; mid-sequence staging is reached from the shipped
  plugin per `packages/plugin/src/hooks/magic-context/module-wire.ts:1097` and
  `:1131` against `MODULE_PAGE_MAX_BYTES` = `512 * 1024`
  (`module-wire.ts:20`), and `module-state-sync.ts:1173` for seeds.
- Class: `default-production`.

## Failure scenario

No defect of its own. The campaign-level failure is that the marker never fires,
in which case:

- [stagelc-staged-state-does-not-survive-a-restart](stagelc-staged-state-does-not-survive-a-restart.md)
  passes trivially, because with no staged state at the boundary the
  post-construction emptiness assertion is true for uninteresting reasons and the
  `attempt_mismatch` rejection is never reached.
- [stagelc-restart-drops-the-only-page-level-replay-guard](stagelc-restart-drops-the-only-page-level-replay-guard.md)
  is entirely untested, because the guard at `:9446-9460` can only be shown to be
  missing after a boundary crossed with a `completed` slot present.

A campaign can restart a handler a thousand times between test cases and satisfy
neither, because the interesting precondition is that a coordination was in
flight, not that a restart happened.

## Timing windows and dependencies

The boundary itself is the timing point. Both crossing modes must be covered:

- Graceful, via `shutdown` (`:12048`), which executes the reset.
- Abrupt, by dropping the handler or terminating the process, which does not.

Dependency: this marker composes with
[stagelc-a-coordination-is-observed-mid-sequence](stagelc-a-coordination-is-observed-mid-sequence.md).
The mid-sequence marker establishes that a `Collecting` phase with an interior
index occurs at all; this one establishes that one of them coincided with a
boundary. Firing the first does not imply the second.

## What a test must construct

Marker name is constant and globally unique:
`stagelc_restart_with_staged_state`.

Fire it when all three preconditions hold, none of which is a violation:

1. Immediately before the boundary, at least one of the three coordinators has a
   non-empty `sessions` map containing a `Collecting` phase.
2. That phase's staged item count is `>= 1` and strictly less than its declared
   total, that is `pages.len() < total` for pages, `batches.len() < total` for
   seeds, or `next_seq < batch_count` for imports. This is what makes the state
   genuinely mid-sequence rather than momentarily pre-apply.
3. The boundary was crossed, witnessed either by `shutdown` returning `Ok` or by
   a freshly constructed handler reporting `total_staged_bytes == 0` and an empty
   `sessions` map.

Construction, graceful arm:

1. Build handler H1 over a fixed store directory. Bind route 1 to session A.
2. Stage pages 0 and 1 of a three-page series. Assert both acked with
   `next_expected_index` 1 and 2.
3. Read the coordinator and check preconditions 1 and 2. Do not assert anything
   about correctness here; just record that the state exists.
4. Call `H1.shutdown()`. Assert `Ok`. Check precondition 3. Fire the marker.
5. Build H2 over the same store directory. This is where the two restart records
   take over with their own assertions.

Construction, abrupt arm:

6. Repeat steps 1 to 3, then drop H1 without calling `shutdown`, build H2, and
   fire the marker on precondition 3's second witness form. This arm is the one
   that matters for a crash, and it is cheaper than it looks because dropping the
   handler in-process is sufficient; a real process kill is not required to
   establish that nothing was reconstructed.

A third arm should stage a partial seed rather than pages, so the marker is not
satisfied only by the page coordinator.

## Investigation log

### Q: Does an existing test cross a restart boundary with staging state present?

- Sources examined: the inline test module (`:16001-30279`); the historian's
  seeded-phase recovery family, `assert_seeded_phase_recovers_then_refires_after_backoff`
  (`:29793`) and its three wrappers at `:29822`, `:29827`, `:29832`, plus the
  `seed_historian_phase` helper (`:29717`) and `seed_awaiting` (`:29658`); and
  `state_import_batch_gap_and_staleness_evict_partial_attempts` (`:27013`).
- Findings: the historian family does cross a boundary with durable phase state
  present, which is the closest analogue in the crate and a good structural
  model, but it seeds `mc-store` rows rather than a coordinator, so it exercises
  the durable-resume path this lens's records are contrasted against. The state
  import test stays inside one handler. No test builds a second handler over the
  same store with a coordinator mid-sequence.
- Missing evidence: none; the search covered test function names plus the
  scope map's keyword histogram, which reports 18 `lib.rs` tests in the state
  sync/import/page bucket and 49 in the historian/wrapup bucket.
- Conclusion: resolved with answer. No existing coverage. The record's Existing
  check line says so and names the historian family as the nearest analogue.

### Q: Should the marker require both crossing modes, or is one enough?

- Sources examined: the reset block (`:12095-12099`) and its position inside
  `shutdown` (`:12048`); the constructors (`:3463-3467`); and
  `src/bin/ck_mc_host/serve.rs:603-620`, which routes SIGTERM to the graceful
  path.
- Findings: the two modes differ in exactly one observable respect, whether
  `:12095-12099` runs. Neither mode preserves anything, so for the purpose of the
  two restart records they are equivalent in outcome. But a campaign that only
  covers the graceful mode leaves the crash case unobserved, and the crash case is
  the one an operator actually hits.
- Missing evidence: none.
- Conclusion: resolved with answer. The marker fires on either witness form, and
  the test construction above includes both arms so the campaign covers each at
  least once.
