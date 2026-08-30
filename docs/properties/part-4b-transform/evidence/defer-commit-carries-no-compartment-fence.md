# defer-commit-carries-no-compartment-fence

## Discovery trigger

Reading `commit_transform`'s CAS predicate showed three independent checks:
row version, claim snapshot vector, compartment max sequence. Tracing what the
transform actually passes for the third one showed it is conditional on the pass
being a bust, while a Defer still writes a compartment-derived watermark.

## Evidence trail

Every reference read back at `HEAD` `76cd6f41`.

The store's three-part predicate, all inside one fenced transaction
(`mc-store/src/lib.rs:7260`):

- `:7352-7358` — read `current` row version
- `:7360-7367` — row-version CAS; conflict returns from an empty transaction
- `:7368-7377` — claim-vector predicate, active only when
  `claim_snapshot_vector` is `Some`
- `:7378-7387` — compartment predicate, active only when `compartment_max_seq`
  is `Some`:

```
if let Some(expected_seq) = compartment_max_seq {
    let current_seq: i64 = tx.query_row(
        "SELECT COALESCE(MAX(sequence), 0) FROM mc_compartments WHERE session_id = ?1",
        params![session_id],
        |row| row.get(0),
    )?;
    if current_seq != expected_seq {
        return Ok(CommitOutcome::CasConflict(current.max(0) as u64));
    }
}
```

What the transform passes:

- `transform.rs:5574` — `compartment_max_seq: is_bust_pass.then_some(m1_signal.max_compartment_seq),`
- `transform.rs:4435-4438` — `let is_provider_prefix_mutation_pass = matches!(plan,
  PassPlan::Hard | PassPlan::MigrateHard | PassPlan::Soft);`
- `transform.rs:4439` — `let is_bust_pass = !req.is_subagent && is_provider_prefix_mutation_pass;`

So a `PassPlan::Defer` passes `None` and the compartment predicate is skipped
entirely. Subagent passes also pass `None`.

What a Defer nonetheless writes:

- `transform.rs:5151-5158` — the `PassPlan::Defer` arm:

```
core.step(PassInput {
    proposed: Some(mc_core::Action::SoftPlus),
    boundary_present: boundary_token,
    ..Default::default()
});
if compartment_seq_changed_since_meta
    && current_m1_digest == loaded.meta.m1_revision
{
    meta.coverage_compartment_seq = Some(m1_signal.max_compartment_seq);
}
```

`m1_signal` is read at `transform.rs:3846-3856`
(`revision_signal_for_context`), possibly replaced by the revalidation at
`:3892-3902`, and both are ordinary reads outside any commit predicate.
`compartment_seq_changed_since_meta` is computed at `:3950-3951`:

```
let compartment_seq_changed_since_meta = loaded.meta.initialized
    && m1_signal.max_compartment_seq != meta_coverage_compartment_seq(&loaded.meta);
```

A Defer commits whenever `state_changed` (`:5555`) is true, and writing
`meta.coverage_compartment_seq` makes `meta != loaded.meta`, so this write does
reach the store.

Why the row-version CAS does not cover it: compartments are appended by
`append_compartments` (`mc-store/src/lib.rs:9167`), which runs
`append_compartments_tx` (`:9174`) and does not touch `mc_cache_state`. Nothing
in that path bumps `row_version`. So a compartment append is invisible to the
row-version predicate.

What the watermark is used for on later passes:

- `transform.rs:3912-3918` — `compartment_revision_matches`, which falls back to
  the combined digest when `m1_compartment_seq` is absent and otherwise compares
  `applied == m1_signal.max_compartment_seq`
- `transform.rs:3950-3951` — `compartment_seq_changed_since_meta`, the input to
  the Defer write itself and to the SOFT arm's `else if` at `:5136-5138`
- `transform.rs:3941-3946` — `boundary_divergence_recut`, which admits a recut
  when `compartment_revision_matches` holds

## Failure scenario

A historian publish appends compartments. A transform request for the same
session is in flight and classifies to Defer. Its `m1_signal` was read before
the append, so `m1_signal.max_compartment_seq` is the pre-append maximum and
`compartment_seq_changed_since_meta` is true for some earlier reason. The Defer
commits `meta.coverage_compartment_seq = pre_append_max`. The row-version CAS
passes, because the publish did not touch `mc_cache_state`, and the compartment
predicate is skipped because this is not a bust.

The next pass computes `compartment_seq_changed_since_meta` as
`post_append_max != pre_append_max`, which is true, so this particular staleness
is self-correcting for that predicate. The sharper consequence is
`compartment_revision_matches` at `:3915-3917`: it compares `applied ==
m1_signal.max_compartment_seq`, and an `applied` value that names a sequence the
session has already moved past makes the comparison false, which suppresses the
recut admission at `:3941-3946` for up to
`BOUNDARY_DIVERGENCE_PENDING_PASS_LIMIT` passes (`:85`, value 3) rather than
admitting it immediately.

The honest summary: this is a stale-watermark write on a path with no fence,
whose downstream effect is a delayed repair rather than a permanent wedge. It is
recorded because the absence of the fence is asymmetric with the bust path and
nothing documents why.

## Timing windows and dependencies

Window: `transform.rs:3846` (the `m1_signal` read) to `:5565` (the commit). A
compartment append committing anywhere in that window is undetected on a Defer.

Dependency: whether a historian publish can commit concurrently with a live
transform for the same session. The publish path has its own fences, which
Part 4a owns. If those fences serialise publishes against transforms, this
window closes and the property becomes vacuous but still worth stating.

## What a test must construct

1. Seed a session with `meta.initialized` true, compartments present, and
   `meta.coverage_compartment_seq` set to a value below the current maximum so
   `compartment_seq_changed_since_meta` is true.
2. Arrange `current_m1_digest == loaded.meta.m1_revision` so the Defer arm's
   inner condition at `:5155-5156` holds.
3. Register the `#[cfg(test)]` attempt hook (`:5563-5564`,
   `run_transform_attempt_hook`) to append a compartment just before the commit,
   simulating the interleaved publish. Note the hook fires before
   `commit_transform`, which is exactly the window.
4. Drive a pass that classifies to Defer.
5. Assert the commit succeeded, then assert
   `meta.coverage_compartment_seq == MAX(sequence)` of `mc_compartments`. That
   assertion fails, showing the watermark records a superseded value.
6. Repeat with a Soft pass and show the commit instead returns `CasConflict`,
   demonstrating the asymmetry.

As a coverage check, assert the independent preconditions rather than the
mismatch: a Defer pass observed to write `meta.coverage_compartment_seq`, and a
compartment append observed to commit inside the window. Never pair `always(!X)`
with `sometimes(X)`.

## Investigation log

### Q: Does any writer append compartments concurrently with a live transform for the same session?

- Sources examined: `mc-store/src/lib.rs:9167-9185` (`append_compartments`),
  `:9174` (`append_compartments_tx`); `transform.rs:5574`, `:4435-4439`;
  `mc-module/src/lib.rs:8322` (the only production caller of the engine) and its
  surrounding `async fn`.
- Findings: `append_compartments` does not write `mc_cache_state`, so it cannot
  be caught by the row-version CAS. The transform runs inline in an `async fn`
  (`lib.rs:8322`), not under `spawn_blocking`, and nothing visible in
  `lib.rs:8007-8615` takes a per-session lock, so two requests for one session
  can be in flight on different tokio workers. Whether the historian's publish
  path serialises against a live transform is a Part 4a question.
- Missing evidence: the historian publication fence semantics, and whether any
  route-level serialisation exists in the dispatch layer that this lens's scope
  does not cover.
- Conclusion: unresolved, needs the 4a publish-fence result and the 4c dispatch
  result. Recorded as a dependency rather than assumed either way.

### Q: Is the omission of the compartment fence on Defer deliberate?

- Sources examined: `transform.rs:5574` and the surrounding `TransformCommit`
  literal `:5567-5600`; every comment in `:5540-5600`; the comment on
  `compartment_revision_matches` at `:3908-3912`.
- Findings: no comment explains the `is_bust_pass` gate on
  `compartment_max_seq`. The plausible reading is cost: the predicate adds a
  `MAX(sequence)` query to every commit, and a Defer that writes nothing
  compartment-derived would not need it. But a Defer *can* write a
  compartment-derived value, at `:5157`, which is what makes the gate
  questionable.
- Missing evidence: no transform specification exists outside the source; the
  scope map established that.
- Conclusion: needs human input. Whether the gate is a deliberate cost trade or
  an oversight is a design question the code does not answer.
