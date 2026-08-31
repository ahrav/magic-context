# crash-before-publish-commit-refires-without-partial-state

## Discovery trigger

The task asked whether a crash between chunk write and publish is recoverable.
Answering it required first establishing what "chunk write" means here, because
the chunk bytes are never written before the publish. What is written before the
publish is the pinned chunk *description*: the range, the fingerprint, and the
identity vector. Everything else is recomputed on recovery.

## Evidence trail

### What is durable before the publish

`crates/mc-module/src/historian.rs`, in order:

1. `:1260-1263` fingerprint verified against the caller's observation.
2. `:1264-1278` load, `fire`, persist. This writes the phase `Firing`, the
   incremented `firing_seq`, the `chunk_range`, the `chunk_fingerprint`, the
   `selected_range_identities`, the `expected_revert_epoch`, and the
   `compartment_set_generation` (`:255-275`).
3. `:1332-1338` `producer_started`, persist. This writes phase `AwaitingProducer`
   plus the producer session id, run id, and harness (`:278-297`), and clears any
   prior failure detail and cooldown (`:292-295`).
4. `:1663-1664` `output_received`, persist. Phase `Validating`.
5. `:1706-1707` `validation_ok`, persist. Phase `Publishing`. The return value is
   the row version the publish CAS will use.
6. `mc-store:9360-9505` the publish transaction.

Steps 2 through 5 are four separate `persist_historian_state` calls, each of which
is its own `store.commit` (`historian.rs:391-403`). The chunk text, the transcript,
the raw messages, and the validated compartments exist only in memory until step 6.

### What recovery does with each phase

`crates/mc-module/src/historian.rs:620-655`:

- `:628` `Idle` yields `RestartAction::Done`.
- `:629-647` `AwaitingProducer` yields `ReattachProducer` with the durable ids, or,
  if the ids are missing, abandons and yields
  `AbandonedAndRefireEligible` (`:630-639`).
- `:648-653` `Firing | Validating | Publishing` all abandon and yield
  `AbandonedAndRefireEligible`.

The doc at `:616-619` states the reasoning: "If publish had committed before the
crash, the load observes idle and returns `Done`; if it still observes a
publishing row, the transaction did not commit, so the stale single-flight is
abandoned and a future trigger may refire when eligible."

That reasoning is sound because step 6 resets the phase to idle inside the same
transaction that appends the rows (`mc-store:9489`). A surviving `Publishing` row
is therefore proof of non-commit, not merely evidence of it.

`abandon_with_detail` (`historian.rs:348-361`) rebuilds the state from
`HistorianDurableState::default()`, preserving only `firing_seq`, the new backoff,
the failure detail, and `consecutive_publish_failures`. So the chunk range,
fingerprint, and identity vector are cleared, which is what forces the refire to
re-assemble rather than reuse a stale pin.

### Why a resumed stale run cannot commit

Even if a stale in-flight task survived and reached the publish after a recovery
abandon, it would carry the row version captured at step 5. The abandon bumped the
row version (`persist_historian_state` commits at `historian.rs:402`), so the CAS
at `mc-store:9373-9382` fails. The predicate would also fail, because the abandon
cleared `producer_run_id` and the identity vector (`:9398-9407`). Two independent
gates reject it.

### Recovery entry point

`crates/mc-module/src/lib.rs:4614-4806` `maybe_spawn_reattach` is what runs this on
the next transform request:

- `:4625-4631` load, and `Idle` reports `recovered`.
- `:4632-4639` defers to a live in-process firing.
- `:4640-4650` the `reattaching_sessions` latch, with per-phase status strings.
- `:4661-4788` the `AwaitingProducer` arm, which rebuilds the chunk and spawns a
  reattach.
- `:4789-4803` the `Firing | Validating | Publishing` arm, which spawns only
  `handle_restart_load`, that is, the abandon.

### The non-abandoning case

`historian.rs:1497-1513` deliberately does **not** abandon when
`producer.status` fails, and the comment at `:1499-1504` explains: every status
failure is inconclusive, the original run may still be active, and abandoning
"would authorize a second billable firing". Only an explicit `Missing` answer
refires (`:1517-1526`). This is the same conservatism as the cancel-proof rule and
is worth pinning.

## Failure scenario

The bad outcome is a wedge, not a loss. If `handle_restart_load` did not abandon a
surviving `Publishing` row, `fire` would refuse every future trigger for that
session (`historian.rs:251-253`), and the session would never fold again. Context
pressure would rise until the emergency path forwarded a raw array, which is
exactly the state the module exists to prevent.

The second bad outcome is a double model spend: a crash between step 3 and step 6
leaves a run that Broca may have completed. The reattach path is what recovers it,
and it redrains from the start rather than re-sending
(`historian_producer.rs:864-878`, test at `historian.rs:2881`).

## Timing windows and dependencies

Four windows, one per gap between the six writes. The last is the interesting one:
between the `Publishing` persist and the transaction commit. Its width is the time
to serialize the request and open a transaction, so microseconds to milliseconds,
which makes it the hardest to hit by chance and the most important to reason about
rather than test by luck.

Dependencies:

- `persist_historian_state` short-circuits when the meta is unchanged
  (`historian.rs:399-401`), returning the current row version without committing.
  That matters for the CAS: if the `Publishing` transition were a no-op, the
  returned version would be the pre-existing one. It cannot be a no-op here,
  because the phase changed.
- The publish transaction's atomicity, which is
  `publish-transaction-is-the-single-commit-point`.

## What a test must construct

1. Simulated restart, which already exists: `historian.rs:4596`
   `restart_mid_awaiting_exposes_reattach_ids` and `:4647`
   `restart_mid_publishing_with_committed_tx_detects_idle`. The gap is that
   neither uses a real process kill, and neither asserts the negative for
   `Firing` and `Validating`.
2. Stale-resume rejection: drive to `Publishing`, capture the predicate and row
   version, run `handle_restart_load` to abandon, then attempt the publish with the
   captured values. Assert `CasConflict` or `StateMismatch` and no compartment
   appended. This tests the two-gate rejection directly and needs no fault
   injection.
3. Wedge absence: after an abandon from each of the three phases, assert a
   subsequent `fire` returns `Fired` once the backoff has elapsed, so the session
   can make progress. Ties to the liveness side.
4. Real crash: a SIGKILL harness in each of the four windows. Expensive; belongs
   with crash-consistency work.

## Investigation log

### Q: `handle_restart_load` abandons an `AwaitingProducer` row with missing producer ids, and `publish_predicate` also errors on missing ids. Do the two paths agree on what a partially written `AwaitingProducer` row means?

- Sources examined: `crates/mc-module/src/historian.rs:629-647` (the recovery
  branch), `:374-389` (`publish_predicate`, which errors with
  `MissingProducerIds` when `producer_run_id` is `None`), `:278-297`
  (`producer_started`, which sets session id, run id, and harness together in one
  state), `:391-403` (`persist_historian_state`).
- Findings: `producer_started` writes all three producer fields in one state and
  one commit, so a durable row with the phase `AwaitingProducer` and a missing run
  id should be unreachable through the normal path. The recovery branch checks only
  `producer_session_id` and `producer_run_id`, not `producer_harness`, and
  `maybe_spawn_reattach` defaults a missing harness to `opencode` with a comment
  explaining that legacy rows came from a factory that hardcoded it
  (`lib.rs:4671-4685`). So the two paths agree on run id and differ on harness,
  deliberately.
- Missing evidence: whether an older build could have written `AwaitingProducer`
  without a run id, which would make the recovery branch's guard live rather than
  defensive. That is a schema-history question I did not pursue.
- Conclusion: unresolved, needs a targeted test that constructs each partial
  `AwaitingProducer` shape and asserts recovery and publish agree. The harness
  default is documented and intentional; the missing-run-id case is defensive and
  untested.
