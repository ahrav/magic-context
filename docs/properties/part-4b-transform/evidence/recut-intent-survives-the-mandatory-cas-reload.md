# recut-intent-survives-the-mandatory-cas-reload

## Discovery trigger

The retry loop discards everything on a `CasConflict` and re-runs `apply_once`
from scratch, so any decision the failed attempt made is lost. One value is
deliberately carried across, which raised the question of what would go wrong
without it.

## Evidence trail

Every reference read back at `HEAD` `76cd6f41`.

The sticky flag, in order of appearance:

- `transform.rs:2270` — `let mut boundary_divergence_retry = false;` outside the loop
- `transform.rs:2272` — `let mut boundary_divergence_detected = false;` inside the loop
- `transform.rs:2280-2281` — both passed into `apply_once`, the second by
  `&mut`
- `transform.rs:3229-3230` — the parameters
- `transform.rs:3232` — `*boundary_divergence_detected = false;` on entry
- `transform.rs:3953` — `*boundary_divergence_detected = boundary_divergence_recut.is_some();`
- `transform.rs:2285-2289` — on a `CasConflict`, with the comment at
  `:2286-2288`: "A historian publish can win after detection but before the
  transform commit. Preserve the recut intent across the mandatory reload so the
  new m1 watermark cannot turn the already-proven inconsistency back into an
  ordinary defer." Then `boundary_divergence_retry |= boundary_divergence_detected;`
  at `:2289`.

What the flag changes on the retry:

- `transform.rs:3889` — `if divergence_candidate.is_some() && !boundary_divergence_retry {`
  gates the revalidation block at `:3890-3907`. On a retry the revalidation is
  skipped, so `post_end_revision_inputs_moved` (`:3903`) cannot clear
  `divergence_candidate`.
- `transform.rs:3924-3939` — the pending-count arithmetic. On a retry, the
  `boundary_divergence_retry || compartment_revision_matches` branch at `:3929`
  sets the count to `0` rather than incrementing.
- `transform.rs:3941-3946` — `let boundary_divergence_recut =
  divergence_candidate.filter(|_| boundary_divergence_retry ||
  compartment_revision_matches || (!active_legitimate_publication_window &&
  boundary_divergence_pending_count >= BOUNDARY_DIVERGENCE_PENDING_PASS_LIMIT));`
  The first disjunct is the sticky flag, so a retry admits the recut
  unconditionally.
- `transform.rs:3947-3949` — `if boundary_divergence_recut.is_some() &&
  !active_legitimate_publication_window { boundary_divergence_pending_count = 0; }`
- `transform.rs:4360-4362` — `if boundary_divergence_recut.is_some() {
  materialize_reason = Some("boundary_divergence_recut".to_string()); }`
- `transform.rs:4079` — the recut also forces the bust decision
- `transform.rs:5621-5628` — the accepted recut logs
  `boundary_divergence_recut session=.. old_coverage=.. new_coverage=..
  live_tail_allowance=..`

The suppression budget the flag bypasses:

- `transform.rs:85` — `const BOUNDARY_DIVERGENCE_PENDING_PASS_LIMIT: u8 = 3;`
  with the doc at `:83-84`
- `transform.rs:3924` — `let active_legitimate_publication_window =
  ctx.historian_active || ctx.wrapup_active;` with the comment at `:3919-3923`
  stating that a damaged row seen during wrapup waits for the latch guard to end,
  "bounded by the 3,800-second wrapup request budget documented on the context"

The detection itself is `detect_boundary_divergence_candidate`
(`transform.rs:6557-6600`), called at `:3877-3887`.

## Failure scenario

Without the sticky flag: attempt 1 detects a divergence, decides to recut, and
renders. A historian publish commits in the meantime, so the terminal CAS at
`:5565` conflicts. Attempt 2 reloads and now sees a fresh `m1_compartment_seq`
that matches the new `max_compartment_seq`, so `compartment_revision_matches` at
`:3913-3918` is true. That alone would still admit the recut through the second
disjunct at `:3943`. The narrower loss is the revalidation at `:3890-3907`: with
`boundary_divergence_retry` false, attempt 2 re-reads the revision signal and
`post_end_revision_inputs_moved` can set `divergence_candidate = None` (`:3904`)
and `divergence_inputs_moved = true` (`:3905`). Then the pending-count branch at
`:3925-3927` retains the prior count rather than incrementing, and the recut
filter finds `None` to filter. The pass proceeds as an ordinary defer, serving
the damaged coverage. The next request repeats the cycle: detect, get overtaken,
revalidate away.

The second thing the flag protects is the budget. `BOUNDARY_DIVERGENCE_PENDING_PASS_LIMIT`
is 3, so without the retry disjunct a session that is always overtaken would
consume its three-pass suppression budget on retries rather than on genuine
observations, and the escalation the constant exists to guarantee would be
delayed.

## Timing windows and dependencies

Window: from `detect_boundary_divergence_candidate` at `:3877` to the terminal
commit at `:5565`. A compartment publish committing in that window is what
produces the conflict, and the conflict is the trigger for the retry.

Dependency: the conflict must actually be a `CasConflict`. A publish that changes
compartments without touching `mc_cache_state` would not conflict on
`row_version`; it conflicts because the recut pass is a bust, so it passes
`compartment_max_seq` (`:5574`) and the store's compartment predicate at
`mc-store/src/lib.rs:7378-7387` catches it. So the sticky flag and the
bust-only compartment fence are coupled: the fence is what turns the interleaved
publish into a retry, and the flag is what makes the retry repair rather than
defer.

## What a test must construct

An existing test already does this, which is why the confidence is high:
`boundary_divergence_recut_retries_after_interleaved_historian_publish`
(`transform.rs:20433`). It seeds an astro-shaped divergence
(`seed_astro_divergence`), builds a `HistorianSelectedMessageIdentity` and a
`CompartmentSetGeneration`, then uses a `Cell` to publish once during the pass.

What is not covered and would complete the property:

1. Assert that the accepted pass carries `materialize_reason ==
   Some("boundary_divergence_recut")`, tying the outcome to `:4361` rather than
   to the coverage numbers alone.
2. Assert that `meta.boundary_divergence_pending_count` after the firing is `0`
   and not `1`, which pins the budget-preservation half at `:3947-3949`.
3. A negative control: the same interleave with `ctx.historian_active` true, so
   `active_legitimate_publication_window` holds. The recut filter's third disjunct
   is then disabled and `:3948` does not reset the count. Asserting that the
   retry disjunct still admits the recut separates the two admission routes.

The metamorphic form is worth stating: the served output of a firing that
retried N times should be identical to the served output of a firing that
retried zero times against the same final state. That is the real claim behind
"the reload is mandatory but not lossy", and it is checkable by comparing
`served_output_fingerprint` across the two.

## Investigation log

### Q: Is the `3,800-second wrapup request budget` enforced anywhere reachable from the transform?

- Sources examined: `transform.rs:3919-3924`; searched `transform.rs` for
  `3800`, `3_800`, and `wrapup` budget constants; `ProducerContext` fields at
  `:548-608` for `wrapup_active` and `historian_active`.
- Findings: `ctx.wrapup_active` and `ctx.historian_active` are plain booleans on
  the producer context. No budget constant appears in `transform.rs`. The comment
  attributes the bound to "the wrapup request budget documented on the context",
  which points at the handler side (`wrapup_operation_budget` and
  `remaining_wrapup_budget` are in `lib.rs:5445-5589` per the scope map's region
  table), not at anything the transform enforces.
- Missing evidence: the actual constant and where it is checked, which is in the
  4a scope.
- Conclusion: unresolved, needs 4a. Worth flagging because the transform's
  suppression of a known-damaged coverage row is bounded only by a value it
  neither holds nor checks. If the handler's budget were ever removed or widened,
  the transform would keep suppressing with no local bound.

### Q: Does the sticky flag ever cause a recut that should not happen?

- Sources examined: `transform.rs:2289`, `:3232`, `:3953`, `:3941-3946`,
  `:3889`.
- Findings: `boundary_divergence_detected` is reset to `false` at the top of every
  `apply_once` (`:3232`), so it reflects only the attempt that just ran.
  `boundary_divergence_retry` is monotone within a firing, never reset. So once
  any attempt in a firing proves a divergence, every later attempt in that firing
  recuts. Within one firing the array is fixed, so a divergence proven on attempt
  1 is still a divergence on attempt 2 against the same array; only the store side
  moved. That is exactly the intended semantics.
- Missing evidence: none.
- Conclusion: resolved with answer — the stickiness is scoped to one firing and
  one array, so it cannot carry a stale verdict into a later request.
