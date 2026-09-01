# core-fields-mutated-outside-the-step-machine

## Discovery trigger

The cache-state machine is a small, heavily commented state machine with
explicit guards. Checking whether the engine actually routes every transition
through it turned up direct writes to `CoreState` fields, one of which runs
after the machine has already bumped `version` for the pass.

**Correction recorded during authoring.** The first draft of this record claimed
a lost-reconcile-intent failure: that `core.reconcile_pending = true` at
`transform.rs:4430` is cleared by `step_defer` and never reinstated. That is
wrong. `transform.rs:5191-5196` re-sets the flag after the step, with a comment
that states exactly why. The refuted scenario is removed and replaced with the
ordering dependency that actually exists.

## Evidence trail

Every reference read back at `HEAD` `76cd6f41`.

`CoreState` exposes every field publicly
(`../commons/crates/cortexkit-cache-core/src/lib.rs:84-97`):

```
pub struct CoreState {
    pub version: u64,
    pub boundary_id: String,
    pub frozen_units: Vec<FrozenUnit>,
    pub pending_changes: Vec<FrozenUnit>,
    pub reconcile_pending: bool,
}
```

so nothing type-level requires a transition to go through `step`.

### `reconcile_pending`: two out-of-machine writes, and the order matters

- `transform.rs:3452-3459` — `let mut lineage_anchor_failure = false; if let
  Err(detail) = validate_lineage_anchor(&loaded.meta, req, &projection) {
  lineage_anchor_failure = true; eprintln!("mc-module: lineage anchor validation
  failed closed for {}: {detail}", ..) }`. Function body at `:2484-2547`.
- `transform.rs:4429-4433` — the **pre-step** write: `if lineage_anchor_failure {
  core.reconcile_pending = true; plan = PassPlan::Defer; materialize_reason =
  Some("lineage_anchor_mismatch".to_string()); }`
- Whichever `core.step` runs then reassigns the field. `step_defer` assigns it
  unconditionally at cache-core `:197`:
  `self.reconcile_pending = !boundary_match && !self.boundary_id.is_empty();`
  `step_hard` assigns `false` at cache-core `:250`.
- `transform.rs:5191-5196` — the **post-step** write, which is the effective
  one:

```
if lineage_anchor_failure {
    // The soft-pressure path can preserve an existing reconcile state but cannot create
    // one. Because the anchor check detected a new failure, set the pending flag after the
    // state-machine step and commit it with the no-trim response.
    core.reconcile_pending = true;
}
```

Nothing reads the mutated `core.reconcile_pending` between `:4430` and `:5195`.
Every read in that span is against the loaded copy: `:4642`
(`loaded.core.reconcile_pending`) and `:5245`
(`!loaded.core.reconcile_pending`). The first read of the mutated field is
`:5673`, in the response. So the `:4430` assignment to that field has no effect
on any path that reaches a `core.step`, which is every non-subagent path and
every subagent path whose pass is not a Defer (`:4539-4540`). Its sibling
assignments on the same line group, `plan` and `materialize_reason`, are
load-bearing.

The consequence worth cataloging: correctness of the reconcile latch depends on
`:5195` existing and running after the step. A reader who sees `:4430` and
concludes `:5195` is redundant would be inverting the actual dependency.
`lineage_anchor_failure` is also read a third time at `:5371-5375`, where it
forces a no-trim output meta with `coverage_ordinal = None`.

### `frozen_units`: pruned after the version bump

- `transform.rs:5098-5106` — the coverage-extending `core.step(PassInput {
  proposed: Some(mc_core::Action::Soft), .. })`
- cache-core `:232` — `self.version += 1;` inside `step_soft`
- `transform.rs:5108-5118` — `if let Some((_, ord)) = m1.new_coverage {
  meta.coverage_ordinal = Some(ord); .. prune_covered_red_units(&mut core, &live,
  meta.coverage_ordinal); prune_covered_caveman_units(&mut core, &live,
  meta.coverage_ordinal); }`

Both prune bodies `retain` directly on the frozen set:

- `transform.rs:6926-6947` — `prune_covered_red_units`, `retain` at `:6932`
- `transform.rs:6385-6398` — `prune_covered_caveman_units`, `retain` at `:6390`

The comment at `:5111-5116` explains why the prune is needed and is convincing:
a covered reduction that survives a coverage-extending SOFT is "silent bloat"
and would false-fire the monotonicity conflict guard on a later re-decide. The
property is not that the prune is wrong. It is that the committed
`core.version` was bumped by the step *before* the frozen set was pruned, so
`version` does not identify the frozen set that was committed. The HARD arm
shows the alternative shape already exists in the same file:
`surviving_red_units` (`:6949-6968`) computes survivors as a value and hands them
to the step as `rendered_units`.

### The discarded verdict

All five `core.step` call sites (`:4541`, `:4794`, `:5002`, `:5098`, `:5151`)
discard the returned `StepResult`, so the machine's own `reconcile_pending`
verdict (cache-core `:199-202`, `:233-236`, `:252-255`) is never compared with
the engine's expectation. Reading `core.reconcile_pending` afterwards is
equivalent in value, so nothing is lost; the cross-check opportunity is.

The design intent the direct writes route around is stated in cache-core itself
at `:222-224`: "Under a correct harness classifier this never arises
(`reconcile_pending` routes Defer or HARD, never a coverage-extending SOFT), but
this is a shared cache-stability primitive, so the guard is enforced in the core,
not assumed."

## Failure scenario

**Version does not identify the frozen set.** A coverage-extending SOFT commits
`core.version = N+1` with a frozen set that has had `red:` and `cav:` units
removed after the version bump. Anything that caches or compares by
`(session_id, core.version)` and expects the frozen set to be a function of the
version is wrong for that pass. The response exposes the version
(`transform.rs:5674`).

**Latent, not live: the reconcile latch's ordering dependency.** Today the latch
survives because `:5195` runs after the step. If `:5195` were removed as
apparently redundant with `:4430`, a lineage-anchor failure on a pass whose
boundary is still present would commit `reconcile_pending == false`, and the next
pass would keep serving m0 bytes built on a rejected anchor with no rematerialize
scheduled. This is a maintenance hazard, not a defect at `HEAD`, and the record
exists so a future change cannot make it one silently.

## Timing windows and dependencies

No concurrency. Both are single-pass ordering facts.

Dependency for the latch: `boundary_match` compares `input.boundary_present`
with `self.boundary_id` (cache-core `:158`). `boundary_present` is
`boundary_token` (`transform.rs:3540-3544`), which equals
`loaded.core.boundary_id` when the boundary is present and `"-"` otherwise. So
`boundary_match` is exactly the engine's `boundary_present` flag. A lineage
anchor mismatch and a present boundary are independent:
`validate_lineage_anchor` (`:2484-2547`) checks the continuation-summary anchor,
not the coverage boundary. Both can hold at once, which is precisely the case
`:5195` was written for.

## What a test must construct

For the frozen-set property:

1. Seed a session with at least one frozen `red:` unit whose target sits in the
   live tail.
2. Drive a coverage-extending SOFT (`m1.new_coverage.is_some()`) whose advance
   folds that target below the new coverage end.
3. Capture `core.version` and the frozen key set from the committed row.
4. Assert the committed frozen set is reproducible from `loaded.core` plus the
   declared Soft units plus the declared prune rule, and record that `version`
   advanced by exactly one while the set shrank. The general form of the check is
   replay-reproducibility, not a specific key list.

For the latch's ordering dependency, a regression test rather than a bug test:

1. Seed `meta.anchor_block_id` and keep the stored `boundary_id` present in the
   live array, so `boundary_present` is true.
2. Supply an array whose continuation-summary block no longer matches the stored
   anchor, so `validate_lineage_anchor` returns `Err` and `:3455` logs.
3. Assert the pass is a Defer with `materialize_reason ==
   Some("lineage_anchor_mismatch")` and, critically, that the **committed**
   `core.reconcile_pending` is `true`. That assertion passes today and fails if
   `:5195` is ever removed.

## Investigation log

### Q: Does the pre-step write at `:4430` survive to the commit?

- Sources examined: `transform.rs:4429-4433`, `:4539-4540`, `:4541`, `:5151`,
  `:5191-5196`, `:5673`; every occurrence of `reconcile_pending` in
  `:4369-5700` (`:4430`, `:4642`, `:5195`, `:5245`, `:5673`); cache-core `:197`,
  `:250`.
- Findings: no. Whichever step runs reassigns the field. `:5195` then re-sets it
  for the `lineage_anchor_failure` case, so the committed value is correct. The
  `:4430` assignment to that field is dead on every path that steps. The first
  draft of this record asserted the opposite and was wrong.
- Missing evidence: none.
- Conclusion: resolved with answer — the latch is correct at `HEAD`. The record
  is reframed from a defect to an ordering dependency plus the frozen-set finding.

### Q: Is the prune-after-step ordering forced?

- Sources examined: `transform.rs:5091-5118`, `:6926-6947`, `:6385-6398`,
  `:6949-6968`; cache-core `:225-237`.
- Findings: the prune needs `meta.coverage_ordinal`, assigned at `:5109` from
  `m1.new_coverage`, which is also the value handed to the step as
  `new_boundary_id`. So the data is available before the step and the ordering is
  a choice, not a dependency. The HARD arm computes survivors as a value with
  `surviving_red_units` instead of mutating after the fact.
- Missing evidence: none.
- Conclusion: resolved with answer — the ordering is incidental. No fix proposed,
  per METHOD.md rule 6.

### Q: Is the discarded `StepResult` hiding anything?

- Sources examined: all five call sites; cache-core `:199-202`, `:233-236`,
  `:252-255`.
- Findings: `StepResult.reconcile_pending` is a copy of the post-transition field
  value, and the engine reads that field directly at `:5673`. So no information
  is lost. What is absent is any assertion that the machine's verdict matches
  what the engine intended, which is what would have caught the first draft's
  hypothesised bug automatically.
- Missing evidence: none.
- Conclusion: resolved with answer. Whether to add the assertion is a
  guard-placement decision for
  `/low-level-systems:defensive-assertions-and-invariant-guards`; kept as a lens
  open question needing human input.
