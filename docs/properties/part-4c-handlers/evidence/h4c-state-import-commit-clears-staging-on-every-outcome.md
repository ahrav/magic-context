# h4c-state-import-commit-clears-staging-on-every-outcome

## Discovery trigger

`handle_state_import_value` is the most carefully guarded handler in this lens's
scope: it calls a `discard` closure on nine separate rejection paths so a bad
request never leaves staged bytes behind. Reading the successful-assembly arm, the
same care produces a different result: `complete()` runs *before* the commit
outcome is examined, so a retryable store failure also clears the staging.

References are to `crates/mc-module/src/lib.rs` unless stated. Verified at `HEAD`
`b5dc778e`; `mc-module` is unchanged between `76cd6f41` and `b5dc778e`.

## Evidence trail

**The disciplined rejection paths.** The closure is defined once:

```
5621        let discard = |handler: &McHandler| {
5622            handler
5623                .state_imports
5624                .lock()
5625                .expect("state import mutex")
5626                .discard(&parsed.session_id);
5627        };
```

and called on every rejection: version mismatch `:5629`, empty session id `:5636`,
bad `import_id` `:5640`, bad batch window `:5646`, unbound route `:5656`, session
mismatch `:5663`, store unavailable `:5674`, duplicate preflight `:5680`,
session-not-empty `:5689`, preflight error `:5697`, and compartment validation
failure `:5712`. Two earlier paths, before `parsed` exists, do the same by hand at
`:5599-5604` and `:5612-5617`. This is thorough.

**Validation precedes the write.** The order is: 1 MiB body cap at `:5596-5606`,
deserialization at `:5609`, `v == 1` at `:5628`, session id at `:5635`,
`import_id` bounds at `:5639` against `STATE_IMPORT_MAX_ID_BYTES` (128, `:651`),
batch window at `:5645`, route binding at `:5653`, store availability at `:5671`,
preflight at `:5678`, and compartment validation at `:5711`. Only then is anything
staged at `:5716-5729` or committed at `:5738`.

**The idempotency key and its two duplicate reports.** `import_id` is
caller-supplied. The preflight recognises a prior successful import:

```
5678        match store.preflight_state_import(&parsed.session_id, &parsed.import_id) {
5679            Ok(StateImportPreflight::Duplicate { imported }) => {
5680                discard(self);
5681                return respond(json!({
5682                    "ok": true,
5683                    "imported": imported,
5684                    "duplicate": true,
5685                }));
```

and the commit result reports it again:

```
5749                    Ok(result) => respond(json!({
5750                        "ok": true,
5751                        "imported": result.imported,
5752                        "duplicate": result.duplicate,
5753                    })),
```

So a resend after a *successful* commit is correctly recognised. This is what
bounds the record to lost work rather than double-apply.

**The ordering at issue.**

```
5734            Ok(StateImportStageOutcome::Apply {
5735                import_id,
5736                compartments,
5737            }) => {
5738                let outcome = store.commit_state_import(
5739                    &parsed.session_id,
5740                    &import_id,
5741                    &compartments,
5742                    created_at,
5743                );
5744                self.state_imports
5745                    .lock()
5746                    .expect("state import mutex")
5747                    .complete(&parsed.session_id, &import_id);
5748                match outcome {
```

`complete()` at `:5744-5747` is unconditional. It is not inside the `match` at
`:5748`, and it is not guarded by the outcome. Then:

```
5762                    Err(StateImportError::Store(error)) => PreparedOutcome::Error {
5763                        code: "store_write_failed".to_string(),
5764                        message: error.to_string(),
5765                    },
```

`store_write_failed` is the generic retryable-looking error, and by the time it is
returned the staged batch set is gone.

**A related detail worth recording.** `created_at` is taken once at `:5705`, before
the compartments for *this* batch are built at `:5706-5710`, and the same value is
passed to `commit_state_import` at `:5742`. On a multi-batch import the earlier
batches were converted using their own request's `created_at`, since `:5706-5710`
runs per request. So the committed set can carry per-batch creation stamps while
the commit call receives only the last batch's. Whether that matters depends on
what the store does with the parameter; noted, not claimed.

## Failure scenario

1. A caller imports a session in three batches with `import_id = "imp-9"`.
2. Batches 0 and 1 stage successfully, each returning `{ok: true, staged: n}` at
   `:5732`.
3. Batch 2 arrives. Preflight at `:5678` returns `Ready`. Compartment validation at
   `:5711` passes. `stage` at `:5716` returns `Apply` with all three batches'
   compartments.
4. `commit_state_import` at `:5738` fails with `StateImportError::Store`, for
   example `SQLITE_BUSY` past the timeout or a disk error.
5. `:5744-5747` clears the staging regardless.
6. `:5762-5765` returns `store_write_failed`.
7. The caller retries. If it retries only batch 2, the coordinator has no batches 0
   and 1 and the assembly cannot complete. If it retries from batch 0, up to three
   times 1 MiB is resent.

The error code gives the caller no way to know which of those two it must do.

## Timing windows and dependencies

Not a race. The window is three statements wide, `:5738` to `:5748`, and the
trigger is a store error rather than an interleaving.

Dependency: how the TypeScript sender classifies `store_write_failed`. If it
already resends from batch zero on any error, the practical cost is only the
re-transmission. If it resends only the failed batch, the import wedges until
staleness expiry clears the coordinator, and the sibling lens owns that expiry
path.

Dependency: `MAX_FACADE_FRAME_BYTES` at `:14279` is 1 MiB and is applied per
request at `:5597`, so the resend cost scales with `batch_count`.

## What a test must construct

- An empty session, so the preflight returns `Ready` at `:5687`. Several existing
  tests build this: `state_import_two_batches_bootstrap_hard_folds_and_mints_tail_anchor`
  (`:26893`) is a multi-batch fixture, and `state_import_request` (`:18365`) is the
  request builder.
- A multi-batch import so `batch_count > 1` and the final batch reaches `Apply`.
- A store fault on `commit_state_import` returning `StateImportError::Store`. Note
  the fault must be `Store`, not `SessionNotEmpty` or `Validation`: those two arms
  at `:5754-5761` are terminal rejections where clearing the staging is correct, and
  a test that faults them proves nothing.
- Oracle: after a `store_write_failed` response, assert either that the staged
  batch set is still present for `(session_id, import_id)`, or that the response
  distinguishes "resend all" from "retry this batch". Both are readable without
  constructing a corrupt state.
- Coverage form for the preconditions, per METHOD.md: assert independently that
  the response code was `store_write_failed` and that `batch_count > 1`. Those two
  facts hold on a correct implementation and jointly identify the window.
- Effect accounting: for one `import_id`, attempted commits versus acknowledged
  commits. Observed imported sets must be at most one, which the preflight already
  guarantees; the bounds screen here confirms no double-apply rather than exposing
  this record.

## Investigation log

### Q: Does the TypeScript sender resend from batch zero on `store_write_failed`?

- Sources examined: the error construction at `:5762-5765`; the other error codes
  this handler emits, namely `state_import_version` (`:5631`), `batch_seq_mismatch`
  (`:5648`), `route_unbound` (`:5658`), `session_mismatch` (`:5665`),
  `session_not_empty` (`:5691`, `:5755`), `store_load_failed` (`:5699`); the staging
  error codes visible in the coordinator's own constants at `:1456-1585`, which
  include `state_import_in_progress`, `state_import_attempt_mismatch`,
  `state_import_digest_mismatch`, `state_import_buffer_overflow`, and
  `state_import_capacity`.
- Findings: the code vocabulary is rich and clearly designed for a sender that
  branches on it. `state_import_attempt_mismatch` and `state_import_digest_mismatch`
  in particular imply the sender is expected to restart an attempt on some codes. But
  `store_write_failed` is a generic code shared with four other handlers in this
  scope (`:5763`, `:5886`, `:5970`, `:5989`, `:6071`, `:6090`, `:6120`, `:6157`), so
  it carries no state-import-specific meaning.
- Missing evidence: the sender, which is not in this repository's Rust crates.
- Conclusion: unresolved, needs the TypeScript state-import client. The generic
  reuse of `store_write_failed` is the supporting observation: whatever the sender
  does, it cannot be reacting to a state-import-specific signal, because there is
  none.

### Q: Is clearing the staging on a store failure deliberate?

- Sources examined: the nine `discard` call sites versus the single `complete` call;
  the distinction between `discard` (`:5621-5627`) and `complete` (`:5744-5747`),
  which are different coordinator methods.
- Findings: the author distinguished discard from complete, so the two are not
  interchangeable in intent. `complete` is placed to run after the commit *attempt*,
  which reads as "the attempt is over" rather than "the import succeeded". That is a
  coherent design if the sender is expected to restart the attempt on any terminal
  response.
- Missing evidence: whether `complete` and `discard` leave different coordinator
  state, which is the sibling lens's territory.
- Conclusion: unresolved, needs the sibling lens on coordinator lifecycle. The
  handler-side fact is established: the commit outcome does not influence whether
  the staging is cleared.

### Q: Does the shared `created_at` across batches cause a defect?

- Sources examined: `:5705` where it is taken; `:5706-5710` where per-request
  compartments are stamped with it; `:5742` where the last batch's value is passed to
  the commit.
- Findings: each request stamps its own compartments with its own `created_at`, so
  the values inside the compartment set vary across batches. The commit receives one
  scalar.
- Missing evidence: what `commit_state_import` does with the `created_at` parameter
  given the compartments already carry their own.
- Conclusion: unresolved, needs `mc-store`. Not promoted to a record because I could
  not establish an effect; recorded here so a later pass does not have to rediscover
  the observation.
