# publish-admits-awaiting-producer-phase-at-commit

## Discovery trigger

Checking whether every route into the store's publish goes through validation
first. The module header advertises a five-phase machine with `validating` between
`awaiting_producer` and `publishing` (`historian.rs:1-6`), and the validation
module claims its work happens "before any side effect can publish it"
(`historian_validate.rs:1-9`). The commit point's phase gate admits two phases,
not one, and the second is the pre-validation phase.

## Evidence trail

### The documented contract

`crates/mc-module/src/historian.rs:1-6`:

> Historian writer orchestration: the durable firing state machine
> (idle -> firing -> awaiting_producer -> validating -> publishing) ...

`crates/mc-module/src/historian_validate.rs:1-9`:

> ... validate it against the raw chunk and already-persisted compartment ranges
> before any side effect can publish it. ... That keeps persistence code
> fail-closed: malformed ranges, stale chunks, bad message-id endpoints, and
> boundary-healing decisions are resolved before any database write is possible.

### The state machine enforces it on the way in

`crates/mc-module/src/historian.rs`:

- `:299-307` `output_received` requires `AwaitingProducer` and moves to
  `Validating`.
- `:309-316` `validation_ok` requires `Validating` and moves to `Publishing`.
- `:318-325` `tx_committed` requires `Publishing`.
- `:1760-1773` `require_phase` returns `InvalidTransition` otherwise.
- `:1663-1664` the persist of `Validating` happens before validation runs.
- `:1706-1707` the persist of `Publishing` happens after validation succeeds and
  returns the row version used for the CAS.

So the module cannot skip `Validating` through `publish_output_from_awaiting`.

### The commit point does not enforce it

`crates/mc-store/src/lib.rs:9389-9396`:

```
if !matches!(
    meta.historian.state,
    HistorianPhase::Publishing | HistorianPhase::AwaitingProducer
) {
    return Ok(PublishTxnOutcome::InvalidState(
        meta.historian.state.as_str().to_string(),
    ));
}
```

`AwaitingProducer` is the phase a firing sits in **before** validation. A caller
that constructed a valid predicate and reached `publish_historian_chunk` from
`AwaitingProducer` would pass this gate, and every subsequent gate is about
freshness rather than validation: the predicate identity (`:9398-9407`), the
content identities (`:9413-9425`), the revert epoch (`:9427-9434`), and the
compartment-set generation (`:9436-9455`). None of them observes that a
validation happened.

Nothing in the code or comments explains the second alternative. `:9409-9412`
comments on the identity fence, `:9345-9350` comments on the render-state
contract, and there is no comment on the phase gate.

### Reachability of the widened arm

In-repo callers of `publish_historian_chunk`:

- `crates/mc-module/src/historian.rs:529`, the direct call.
- `crates/mc-module/src/lib.rs:3310`, inside `WrapupSnapshotPublicationFence`.
- `crates/mc-module/src/lib.rs:3347`, inside `ReattachSnapshotPublicationFence`.

All three receive a `HistorianPublishRequest` built at `historian.rs:513-526`,
which is only reached from `publish_validated_chunk`, which is only called from
`publish_output_from_awaiting` (`:1714`), which transitioned to `Publishing`
first. So no in-repo production path exercises the widened arm today.

The store's own test at `:18221`
`publish_historian_chunk_fails_loud_from_non_publish_state` proves some phase is
refused. It does not pin which phases are admitted.

## Failure scenario

The failure is not a bug that fires today; it is a missing enforcement point that
makes a future or external caller's mistake silent. Concretely:

1. Someone adds a recovery path that redrains a terminal producer run and, seeing
   the durable phase is already `AwaitingProducer`, calls the publish directly
   rather than routing through `publish_output_from_awaiting`.
2. Every freshness gate passes, because the chunk really is fresh.
3. Unvalidated model text is appended as compartment rows and folded on the next
   pass.

The whole risk premise of Part 4a is that `historian_validate.rs` is the sole gate.
If the commit point does not require that the gate ran, then the gate is enforced
only by the module's own call graph, which is exactly the kind of invariant that
survives review and dies in a refactor.

## Timing windows and dependencies

No timing window. The gap is static: one `matches!` expression.

Dependency: whether `mc-store` has consumers outside this workspace. If it does,
the widened arm is reachable by construction from outside the module's call graph.

## What a test must construct

The property to assert is that the observed durable phase at the commit point is
`Publishing`. Two forms:

1. Store-level: build a durable `AwaitingProducer` row with a matching predicate
   and a valid identity vector, call `publish_historian_chunk`, and assert it is
   **refused**. Today it will commit, so this test fails on `HEAD`. Written as a
   coverage check rather than an expected-failure test, it asserts the two
   independent preconditions instead: that the phase gate admits more than one
   phase, and that at least one publish route exists which does not go through
   `publish_output_from_awaiting`. Both are true and both fire on a correct
   implementation.
2. Module-level: assert that the only construction site of
   `HistorianPublishRequest` is reached from a `Publishing` state, which is a
   structural claim better served by narrowing the store gate than by a test.

The honest disposition is that this is a hardening finding with a cheap fix
(remove `| HistorianPhase::AwaitingProducer`), and the test is the regression
guard after that fix, not before it. No fix is applied here.

## Investigation log

### Q: Is admitting `AwaitingProducer` deliberate, for example to support a recovery path not yet written, or is it a leftover?

- Sources examined: `crates/mc-store/src/lib.rs:9389-9396` and its surrounding
  comments at `:9345-9350` and `:9409-9412`; every in-repo caller of
  `publish_historian_chunk`; `crates/mc-module/src/historian.rs:299-325`
  (the transitions), `:1663-1707` (the persist order), `:1714-1733` (the single
  publish call site); `crates/mc-store/src/lib.rs:18221-18280`
  (`publish_historian_chunk_fails_loud_from_non_publish_state`) to see which phase
  that test uses.
- Findings: `:18221`'s test drives an `Idle` state, so it proves only that `Idle`
  is refused. No test covers `Firing` or `Validating`, and none covers
  `AwaitingProducer` being admitted. No comment, plan, or doc explains the
  alternative. The reattach path is the most plausible motive, since
  `handle_restart_load` returns `ReattachProducer` from `AwaitingProducer`
  (`historian.rs:629-647`), but that path still transitions through `Validating`
  before publishing (`:1592-1610` builds a `PublishOutputRequest`, which calls
  `output_received` at `:1663`).
- Missing evidence: git history for the phase gate, and whether `mc-store` has an
  external dependent. I did not run `git log -L` on that region, and the answer
  would tell whether the alternative was added with the reattach path or predates
  it.
- Conclusion: needs human input. The widening is verified; its intent is not
  recoverable from the code. Confidence on the record is `medium` for exactly this
  reason: the gap is certain, the reachability is not.
