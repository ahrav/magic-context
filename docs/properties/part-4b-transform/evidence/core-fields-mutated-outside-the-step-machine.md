# core-fields-mutated-outside-the-step-machine

## Discovery trigger

The cache core exposes mutable state fields, while the module also uses the
core's `step` transition. This record checks which writes bypass `step` and
whether their ordering changes behavior.

## Provenance

Magic citations were verified against source commit
`af5e153c12750354a82f91bc796367031ac5c658` plus the current companion U6 diff
on 2026-09-01. Cache-core citations use the exact source at commons U6 commit
`cb5a5c01a5a98df8d80fd41f16c4de5a5cc16d`.

## Evidence trail

`CoreState` exposes its durable fields publicly
(`commons@cb5a5c01:crates/cortexkit-cache-core/src/lib.rs:82-98`). The type therefore
does not require callers to route every mutation through `CoreState::step`.

### `reconcile_pending`: the pre-step write is live on one path

Lineage-anchor validation is implemented at
`crates/mc-module/src/transform.rs:2316-2377` and records failure at
`crates/mc-module/src/transform.rs:3261-3268`. A failure then performs three
pre-transition writes at `crates/mc-module/src/transform.rs:4128-4132`:

```rust
core.reconcile_pending = true;
plan = PassPlan::Defer;
materialize_reason = Some("lineage_anchor_mismatch".to_string());
```

That field write is not always dead:

- A subagent does not dispatch on `plan`. It enters the subagent branch at
  `crates/mc-module/src/transform.rs:4234-4251`. When the scheduler decision is
  not `Defer`, the branch calls `step` with `Action::Soft` at `:4235-4249`.
- `step` computes `boundary_match` and dispatches to `step_soft` at
  `commons@cb5a5c01:crates/cortexkit-cache-core/src/lib.rs:164-173`.
- `step_soft` preserves `self.reconcile_pending` and, when `boundary_match` is
  true, reads it in the boundary-advance guard at
  `commons@cb5a5c01:crates/cortexkit-cache-core/src/lib.rs:234-241`. This call
  supplies `new_boundary_id: None` (`transform.rs:4246`), so the guard cannot
  move the boundary. The pre-step write remains the post-step latch value.

The non-subagent path has different ordering:

- A lineage failure forces `plan = PassPlan::Defer` before `is_bust_pass` is
  derived (`crates/mc-module/src/transform.rs:4128-4138`).
- The non-subagent `match plan` starts at
  `crates/mc-module/src/transform.rs:4251-4254`; its `Defer` arm calls
  `Action::SoftPlus` at `:4774-4787`.
- `step_defer` overwrites `reconcile_pending` at
  `commons@cb5a5c01:crates/cortexkit-cache-core/src/lib.rs:181-212`, using
  `!boundary_match && !self.boundary_id.is_empty()`.
- The module restores `true` after the transition at
  `crates/mc-module/src/transform.rs:4813-4815`.

Thus the same pre-step write has two roles. A subagent Soft transition preserves
it; a non-subagent Defer transition overwrites it and the module restores it
after the step. If a subagent scheduler decision is itself `Defer`, no step
executes and the write remains set. The earlier claim that the assignment is
always dead was false and has been removed.

The post-step value is later exposed in the response at
`crates/mc-module/src/transform.rs:5263-5275`. Lineage failure also selects
no-trim output metadata at `:4973-4980`.

### `frozen_units`: coverage pruning follows the version bump

The non-refold Soft path calls `step` at
`crates/mc-module/src/transform.rs:4737-4744`. `step_soft` applies rendered
units and increments `version` at
`commons@cb5a5c01:crates/cortexkit-cache-core/src/lib.rs:234-246`. When the Soft pass
extends coverage, the module then updates coverage and prunes covered red and
caveman units at `crates/mc-module/src/transform.rs:4745-4749`.

Both pruning helpers mutate `core.frozen_units` directly:

- `prune_covered_caveman_units`:
  `crates/mc-module/src/transform.rs:5953-5966`
- `prune_covered_red_units`:
  `crates/mc-module/src/transform.rs:6442-6457`

The ordering fact is narrow: `version` increments inside `step_soft` before the
two direct `retain` operations. The final `core` value, including those prunes,
is what the commit receives at `crates/mc-module/src/transform.rs:5154-5169`.
The HARD arm demonstrates a value-before-step alternative for red units:
`surviving_red_units` is called at `:4408-4414`, its result is added to the
rendered vector at `:4444-4451`, and that vector enters the Hard step at
`:4453-4460`.

### Returned transition verdicts are discarded

All seven current `core.step` sites discard `StepResult`:
`crates/mc-module/src/transform.rs:2785-2792`, `:2852-2859`, `:4236-4249`,
`:4453-4460`, `:4649-4656`, `:4737-4744`, and `:4782`.
`StepResult` contains the executed action and post-transition reconcile value
(`commons@cb5a5c01:crates/cortexkit-cache-core/src/lib.rs:134-139`). The value remains
available through `core.reconcile_pending`; discarding the result loses only an
opportunity to cross-check the module's intended action and latch state.

## Failure scenario

The live maintenance hazard is removing the post-step restore as apparently
redundant. On a non-subagent lineage-anchor failure with a present boundary,
`step_defer` computes `reconcile_pending = false`; without the restore at
`transform.rs:4813-4815`, the committed latch would no longer record the
lineage failure.

The direct prune is a separate ordering dependency. A coverage-extending Soft
pass increments `core.version` inside the core and then changes the frozen set
outside the core before commit. Any replay or audit logic that models a Soft
transition only from `PassInput` and `StepResult` will miss those later prunes.

## Timing windows and dependencies

These are single-pass ordering facts, not concurrency claims.

The lineage validator checks continuation-anchor identity and content
(`transform.rs:2316-2377`). Boundary presence is resolved separately and encoded
as `boundary_token` at `transform.rs:3329-3338`. A lineage mismatch can therefore
coexist with a present cache boundary, which is the case where the non-subagent
post-step restore matters.

## What a test must construct

For the reconcile ordering:

1. Seed valid lineage metadata and a present stored boundary.
2. Change the live anchor so `validate_lineage_anchor` returns `Err`.
3. On a non-subagent pass, assert the result is Defer and the committed
   `core.reconcile_pending` is `true`.
4. On a subagent pass whose scheduler decision is not Defer, assert the Soft
   transition preserves `reconcile_pending == true` in the committed core.

For the prune ordering:

1. Seed covered `red:` and `cav:` units.
2. Drive a non-refold Soft pass with `m1.new_coverage.is_some()`.
3. Assert `version` advances once and the committed frozen set excludes units
   pruned by `prune_covered_red_units` and `prune_covered_caveman_units`.
4. Treat the assertion as a replay-order check: step first, then the two module
   prunes.

## Investigation log

### Q: Is the pre-step reconcile assignment dead?

- Sources examined: `transform.rs:4128-4138`, `:4234-4251`, `:4774-4787`,
  `transform.rs:4813-4815`;
  `commons@cb5a5c01:crates/cortexkit-cache-core/src/lib.rs:164-173`,
  `:181-212`, `:234-241`.
- Finding: no. Subagent Soft preserves the value. Non-subagent Defer overwrites
  it and the module restores it.
- Missing evidence: none for the source-level ordering.

### Q: Does the module mutate the frozen set after a core transition?

- Sources examined: `transform.rs:4737-4749`, `:5953-5966`, `:6442-6457`;
  `commons@cb5a5c01:crates/cortexkit-cache-core/src/lib.rs:234-246`.
- Finding: yes, on a coverage-extending non-refold Soft pass.
- Missing evidence: no test was run; this record describes source structure.
