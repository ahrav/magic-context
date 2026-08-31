# exactly-one-core-step-executes-per-pass

## Discovery trigger

Mapping the cache-state transition required knowing how many transitions one
pass applies. `grep`ing `core.step` in `transform.rs` returned five call sites,
which raised the question of whether two could fire on one pass.

## Evidence trail

Every reference read back at `HEAD` `76cd6f41`.

The five call sites and their guards:

| Line | Action | Guard |
| --- | --- | --- |
| `4541` | `Soft` | inside `if req.is_subagent {` at `:4539`, and `if !matches!(scheduler_outcome.pass, PassDecision::Defer)` at `:4540` |
| `4794` | `Hard` | `match plan` arm `PassPlan::Hard \| PassPlan::MigrateHard` at `:4556` |
| `5002` | `Hard` | the `if` half of the `PassPlan::Soft` arm's refold branch |
| `5098` | `Soft` | the `else` half of the same branch |
| `5151` | `SoftPlus` | `match plan` arm `PassPlan::Defer` |

The structure is `if req.is_subagent { .. } else { match plan { .. } }`, with
the `else` opening at `:4553` and the `match plan` at `:4554`. `PassPlan::Reject`
at `:4555` returns `Err` before any step. So the five sites are mutually
exclusive by control flow.

The compiler also enforces it. `boundary_token` is a `String`:

- `transform.rs:3540-3544` — `let boundary_token = if boundary_present {
  loaded.core.boundary_id.clone() } else { "-".to_string() };`

Every `PassInput` construction takes it by value:

- `transform.rs:4543` — `boundary_present: boundary_token,`
- `transform.rs:4796` — `boundary_present: boundary_token,`
- `transform.rs:5004` — `boundary_present: boundary_token,`
- `transform.rs:5100` — `boundary_present: boundary_token,`
- `transform.rs:5153` — `boundary_present: boundary_token,`

`PassInput.boundary_present` is `String`
(`../commons/crates/cortexkit-cache-core/src/lib.rs:105`), so each of these
moves the token. Two of them on one path would not compile.

The transitions themselves, for reference on what a second step would do:

- cache-core `:154-165` — `step` dispatches on the proposed action
- cache-core `:172-203` — `step_defer`: drains `input.queued` into
  `pending_changes` (`:173-175`), retains only `Lineage` units on `run_started`
  (`:181-183`), and assigns `reconcile_pending` at `:197`. Does not bump
  `version`.
- cache-core `:225-237` — `step_soft`: `apply_units` then a guarded boundary
  advance (`:227`), `version += 1` at `:232`
- cache-core `:243-256` — `step_hard`: `units.append(&mut
  self.pending_changes)` at `:245`, `apply_units` at `:246`, unconditional
  boundary mint at `:247-249`, `reconcile_pending = false` at `:250`,
  `version += 1` at `:251`
- cache-core `:261-270` — `apply_units` replaces a unit with an existing key in
  place and appends a new key, "the cached-prefix byte order is load-bearing"
  (`:259-261`)

Every call site discards the returned `StepResult`; none of the five assigns it.

## Failure scenario

A second `Hard` step on one pass would call `units.append(&mut
self.pending_changes)` twice. The first drain empties `pending_changes`, so the
second append is a no-op on that field, but `apply_units` would run again with
the same rendered set (replacing by key, so bytes survive) and `version` would
advance by two. A committed `core.version` that advanced by two for one accepted
pass makes the version useless as a pass counter for anything comparing it, and
the module's byte-stability reasoning is stated in terms of one render per bust.

A second `Soft` after a `Hard` would be worse: `step_soft`'s boundary advance is
guarded on `boundary_match && !reconcile_pending` (cache-core `:227`), and
`step_hard` has just set `reconcile_pending = false` (`:250`), so the guard the
core added deliberately to prevent stranding a stale m0 under a fresh anchor
would evaluate against state the same pass mutated.

## Timing windows and dependencies

None. This is a structural property.

The dependency worth recording is fragile: the compiler's help comes entirely
from `boundary_token` being moved rather than cloned. A refactor that changes
`:3540` to produce a value used by reference, or that clones at each call site
for convenience, removes the check with no other visible change. The control-flow
exclusivity would still hold at that moment but nothing would keep it holding.

## What a test must construct

An assertion rather than a test case. Options, cheapest first:

1. A `#[cfg(test)]` thread-local counter incremented in a wrapper around
   `core.step`, asserted to be at most one at the end of `apply_once`. This
   needs a module-side wrapper because `CoreState::step` lives out of repo.
2. A compile-time proof by leaving `boundary_token` a moved `String` and adding
   a comment at `:3540` recording that the move is load-bearing. This is a
   guard-placement question, so it belongs to
   `/low-level-systems:defensive-assertions-and-invariant-guards`, not here.
3. A behavioural proxy: on every accepted pass, assert `committed_core.version -
   loaded_core.version` is exactly zero for a Defer and exactly one for a Soft or
   Hard. This is constructible today with no new instrumentation and it catches a
   double step indirectly.

Option 3 is the one to catalog, because it is expressible against the public
`row_version`/`core.version` pair the response already returns
(`transform.rs:5674` — `version: core.version`).

## Investigation log

### Q: Is there any path that reaches two `core.step` calls?

- Sources examined: `transform.rs:4539-4553` (the subagent `if` and its
  `else`), `:4554-5170` (the `match plan` and all arms), `:4541`, `:4794`,
  `:5002`, `:5098`, `:5151`, `:3540-3544`;
  `../commons/crates/cortexkit-cache-core/src/lib.rs:102-117` for `PassInput`
  field types.
- Findings: the subagent branch and the `match plan` are the two halves of one
  `if/else`. Within the `match`, `Hard | MigrateHard`, `Soft` and `Defer` are
  distinct arms and `Reject` returns early. Within the `Soft` arm the two step
  calls are the two halves of one `if/else` on the refold condition. Plus the
  move of `boundary_token` makes a second call a borrow error.
- Missing evidence: none.
- Conclusion: resolved with answer — no path reaches two steps at `HEAD`.

### Q: Does discarding `StepResult` hide a disagreement?

- Sources examined: all five call sites; cache-core `:199-202`, `:233-236`,
  `:252-255` for what `StepResult` carries.
- Findings: `StepResult` carries `action` and `reconcile_pending`. `action` is
  always the proposed action, so it is near-tautological, which cache-core's own
  test module notes at `:277-281`. `reconcile_pending` is the useful field: after
  `step_defer` it is the freshly computed latch. The engine does read
  `core.reconcile_pending` afterwards through the struct, for example when
  building the response (`transform.rs:5673` — `reconcile_pending:
  core.reconcile_pending`), so the value is not lost, only the opportunity to
  cross-check it against the engine's expectation.
- Missing evidence: none.
- Conclusion: resolved with answer — nothing is lost, but nothing is verified
  either. Whether to add a cross-check is a guard decision, recorded as a lens
  open question needing human input.
