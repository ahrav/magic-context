# stagelc-a-coordination-is-observed-mid-sequence

## Discovery trigger

Every safety record in this lens is about a coordinator holding cross-step state.
All of them can pass on a campaign that only ever sends single-page transforms
and single-batch seeds, because in that case no coordinator ever enters
`Collecting` and every `always` is vacuously true. METHOD.md's second coverage
rule makes this a `sometimes`, not a `reachable`: executing the `Ack` arm's lines
is not the same as producing a partially assembled coordination.

## Evidence trail

All lines read back at `HEAD` = `b5dc778e`;
`git diff --stat 76cd6f41 b5dc778e -- crates/mc-module/` is empty.

The state to be observed and the signals that witness it:

- `:1035-1039` — `TransformPagePhase::Collecting(PendingTransformPage)` is the
  intermediate state. The struct at `:1023-1032` carries `next_index`, `total`,
  `digests`, `pages`, `bytes`, and `queued_at_ms`.
- `:1226-1240` — the first non-final page transitions `Idle` into `Collecting`
  with `next_index: 1` (`:1232`) and returns
  `TransformPageStageAction::Ack(1)` (`:1239`).
- `:1290` — each accepted continuation does `pending.next_index += 1`.
- `:1312-1316` — a non-final continuation returns `Ack(next_index)` (`:1315`)
  after restoring the `Collecting` phase.
- `:9508-9513` — the handler renders an `Ack` as
  `{"ok": true, "staged": true, "next_expected_index": <n>}`.

So `next_expected_index` is the externally visible witness of the intermediate
state, and it is >= 1 by construction whenever the phase is `Collecting`.

The seed analogue, so the marker can cover both coordinators:

- `:906-911` — `StateSyncSeedPhase::Collecting(PendingStateSyncSeed)`, with the
  pending struct at `:893-903` carrying `next_index`, `total`, `digests`,
  `batches`, `bytes`, and `last_activity`.
- `:1004-1018` — the TTL sweep matches this phase and only this phase, which is
  precisely why a campaign that never reaches `Collecting` cannot exercise the
  reaper records at all.

Why the third conjunct is worth asserting separately:

- `:1200-1208` — a first page's bytes are added to `total_staged_bytes` at
  `:1208` before the phase is set. So a genuine `Collecting` phase always implies
  `total_staged_bytes > 0`. Asserting that independently catches the case where
  the coordinator reports an ack but the accounting did not move, without
  asserting any violation.

Reachability, both sides per METHOD.md rule 4:

- Config default: no config leaf controls paging. The Rust side dispatches on
  field presence at `:7985-7986` via `has_transform_page_fields` (`:12326`), and
  the seed path keys off the five envelope fields at `:8643-8653`.
- Shipped setup path:
  `packages/plugin/src/hooks/magic-context/module-wire.ts:1097` emits a single
  unpaged body only when `unpagedBytes <= MODULE_PAGE_MAX_BYTES`, which is
  `512 * 1024` at `module-wire.ts:20`. A larger body is split, and
  `module-wire.ts:1131` stamps `transform_page_id` on each page. The seed side
  pages against the same threshold at `module-state-sync.ts:1268` and `:1274`,
  stamping `seed_batch_index` at `module-state-sync.ts:1173`.
- Class: `default-production`. Reaching a three-page series needs a conversation
  payload over about 1 MiB, which is ordinary for the workload this component
  exists to compress.

## Failure scenario

This record has no failure scenario in the defect sense. Its failure mode is a
campaign-level one: the marker never fires, which means the campaign never
produced a partially assembled coordination, which means every `always` record in
this lens passed without testing anything.

Concretely, if a campaign only ever sends bodies under 512 KiB, then:

- `stage` only ever takes the `Idle` arm with `page_complete == true`
  (`:1210-1224`), going straight to `Applying`.
- `Collecting` is never entered, so
  [stagelc-abandoned-page-collection-is-released-within-a-bounded-window](stagelc-abandoned-page-collection-is-released-within-a-bounded-window.md)
  has nothing to abandon.
- `oldest_queued_at_ms` always returns `None` (`:1153-1163`), so the wedge
  signal is never armed.
- The seed TTL sweep's filter never matches (`:1009`), so
  [stagelc-seed-and-import-reapers-only-run-on-fresh-traffic](stagelc-seed-and-import-reapers-only-run-on-fresh-traffic.md)
  is untested.

## Timing windows and dependencies

None. This is the enabling state for the other records rather than a fault
window. No interleaving, no concurrency, no injected failure.

The one sampling requirement: the observation must happen while the phase is
`Collecting`, that is after an `Ack` response and before the final page. Because
the `Ack` response is itself the witness, the observation point is simply "on
receipt of an ack", which needs no instrumentation inside the lock.

## What a test must construct

Per METHOD.md's coverage rules, the check asserts independent preconditions that
jointly create the state, and never the violation. Marker name is constant and
globally unique.

Marker: `stagelc_coordination_mid_sequence`.

Fire it when all three hold simultaneously:

1. A `transform_page` response was received with `"staged": true` and
   `next_expected_index >= 1`.
2. The series' `transform_page_total` for that `transform_page_id` is `>= 3`, so
   the observed index is strictly inside the series rather than being the
   last-but-one of a two-page series. This is what distinguishes a genuinely
   intermediate state from the degenerate minimum.
3. `total_staged_bytes > 0` for that coordinator at the moment of observation.

Construction:

1. Build a handler with a store and bind route 1 to session A.
2. Build a transform body large enough that the plugin's pager, or the test's own
   equivalent, produces at least three pages. The existing plugin test
   `packages/plugin/src/hooks/magic-context/rust-mode-transform.test.ts:2165`
   filters request bodies for `"transform_page_id" in body`, which is a working
   model for generating them.
3. Send pages 0 and 1. Assert `next_expected_index` is 1 then 2.
4. Fire the marker after the page-1 ack, having checked all three conjuncts.
5. Send page 2 to completion so the test also leaves the coordinator clean.

A second arm should do the same for the seed coordinator with a three-batch seed,
asserting the `state_sync` staged response and `state_sync_seeds`
`total_staged_bytes > 0`.

Every conjunct holds on a correct implementation, so the marker fires on a
healthy system. It is not paired with any `always(!X)`, per METHOD.md's
coverage-check rules.

## Investigation log

### Q: Is `reachable` on the `Ack` arm sufficient, making this record redundant?

- Sources examined: the two `Ack` construction sites (`:1239`, `:1315`), the
  response rendering (`:9508-9513`), and the states the downstream records
  depend on (`:1009`, `:1153-1163`, `:1131-1144`).
- Findings: no. `reachable` on `:1239` would be satisfied by a two-page series,
  which produces a `Collecting` phase that lives only for the duration of one
  request round trip and never sits at an interior index. The records about
  abandonment and reaping need a phase that persists with a partial payload, and
  the third conjunct (byte accounting moved) is not implied by line coverage at
  all. METHOD.md's rule that "a campaign can execute a branch's lines while never
  producing the operational state the branch represents" is exactly this case.
- Missing evidence: none.
- Conclusion: resolved with answer. `sometimes` is the correct semantics.

### Q: Does any existing test already produce this state on the Rust side?

- Sources examined: the inline test module's function names matching page-related
  keywords (`:16001-30279`), which yielded
  `session_status_compartment_pages_are_bounded_and_contract_shaped` (`:27246`)
  and `note_facade_pages_ready_notes_beyond_one_hundred_with_shared_offset_semantics`
  (`:25028`), neither of which is about transform paging; and the
  `#[cfg(test)]` discard-log hook (`:2949`) written at `:4003` and read nowhere.
- Findings: no Rust test drives a multi-page transform series through the
  coordinator. The TypeScript side does exercise its own pager
  (`rust-mode-transform.test.ts:1680-1686`, `:2165`), but that asserts on the
  outbound bodies, not on the Rust coordinator's state.
- Missing evidence: none; the search was over test function names plus the
  keyword histogram in
  `part-4-module/_lenses/scope-map-and-risk-ranking.md`, which reports only 18
  `lib.rs` test names in the state sync/import/page bucket.
- Conclusion: resolved with answer. Existing coverage is `partial` and indirect,
  and is recorded as such on the record's Existing check line.
