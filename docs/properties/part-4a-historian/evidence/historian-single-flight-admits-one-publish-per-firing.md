# historian-single-flight-admits-one-publish-per-firing

## Discovery trigger

The task asked whether two concurrent runs can both publish or interleave partial
results. The answer needs three independent layers checked, because the module
guards in memory, the state machine guards durably, and the store guards at the
commit point, and only the last one is authoritative.

## Evidence trail

### Layer 1, in-process claim

`crates/mc-module/src/lib.rs`:

- `:4556-4581` `try_claim_live_historian_session` takes the
  `live_historian_sessions` mutex, returns `Busy` with a completion `Notify` if an
  entry exists, otherwise inserts one and returns a `SessionSetGuard`.
- `:5146-5163` the pressure path claims it and returns `Busy` on contention.
- `:5286-5291` the wrapup path claims it and returns `Busy` on contention.
- `:4632-4639` the reattach path defers entirely when a live entry exists.
- `:4640-4650` the reattach path has its own `reattaching_sessions` latch.
- `:3106` `LiveHistorianCompletionWait`, and `:4543-4554`
  `live_historian_completion_wait`, are how a waiter joins rather than racing.

This layer is per-process only. It does not survive a restart and does not span
processes.

### Layer 2, durable state machine

`crates/mc-module/src/historian.rs`:

- `:232-234` the doc: "Single-flight is enforced here: any non-idle phase returns
  `Busy` with the unchanged state."
- `:251-253` the check itself.
- `:255-275` the fired state, with `firing_seq: current.firing_seq.saturating_add(1)`
  at `:257`.
- `:1013-1035` `historian_producer_session_id` folds `firing_seq` into the
  producer session id, and the doc at `:1009-1012` explains that a fallback
  attempt must never resume a failed run.
- `:5211-5216` in `lib.rs`, the wrapup path additionally refuses any non-idle
  phase before assembling.

### Layer 3, the commit point

`crates/mc-store/src/lib.rs:9351-9505`:

- `:9373-9382` the row-version CAS against `expected_row_version`.
- `:9389-9396` the phase gate.
- `:9398-9407` the predicate: `firing_seq`, `producer_run_id`,
  `chunk_fingerprint`, `selected_range_identities`, and
  `compartment_set_generation` must all match the durable row.
- `:9436-9455` re-reads the compartment-set generation inside the transaction and
  rejects a mismatch, so a publish that landed between this run's assembly and
  this run's commit retires this run.
- `:9489` resets `meta.historian` to idle at the same `firing_seq`, and `:9491`
  bumps the row version, so the first committer invalidates every gate for a
  second.

The expected row version is the one written by the `Publishing` transition, not a
fresh read. `historian.rs:1706-1707` captures it, `:1719` passes it, and the
comment at `:1709-1713` states why: "reloading here would adopt a racing sync's
version and erase the CAS conflict that must retire this stale run."

### Layer 4, cross-process

`../commons/crates/cortexkit-store/src/lib.rs`:

- `:265-277` the single-writer lease is acquired before the file is opened, so a
  second live writer is rejected rather than sharing the file.
- `:211-218` every transaction re-checks the writer epoch and rejects when a newer
  writer owns the database.

### Losing-race disposition

`crates/mc-module/src/historian.rs:531-594` differentiates four outcomes:

- `FenceRejected` abandons without arming the cooldown (`:533-547`, helper at
  `:1786-1801`), so an immediate retry on a fresh snapshot is admitted.
- `CompartmentOverlap` does the same (`:548-559`), described as "the storage
  backstop found an overlap after the optimistic fence".
- `CasConflict` abandons with the cooldown (`:560-583`).
- Any other error records a publish failure and leaves the producer run available
  (`:584-593`).

## Failure scenario

Two commits at one `firing_seq` would mean the same summarized range appended
twice. The range-overlap backstop at `mc-store:12637-12646` catches an identical
or overlapping range and returns `CompartmentOverlap` rather than writing, so the
worst realistic outcome is two folds whose ranges are disjoint but which both
consumed the same producer output. A more damaging shape needs the two publishers
to carry different validated compartment sets, which requires two different
producer runs, which requires two `firing_seq` values, which the CAS then serializes.

The shape that would actually bite is a publish committing while a transform
holds a stale view. That is what the compartment-set generation re-read at
`:9436-9455` and the snapshot fences at `lib.rs:3296` and `:3332` exist for, and
the pressure path deliberately runs without the latter (`lib.rs:5178-5183`).

## Timing windows and dependencies

The window is between the `Publishing` persist (`historian.rs:1707`) and the
transaction at `mc-store:9360`. It is short, but the whole model run precedes it,
so two firings can easily reach it if the in-process guard is bypassed.

Dependencies: the store's row-version CAS, the lease, and the epoch fence. The
lease's own liveness under SIGKILL is Part 2a territory and is not established
here.

## What a test must construct

The in-process guards make a true race hard to stage from the handler surface, so
target the pure seam:

1. Drive one firing to `Publishing` with a producer double, capture the predicate
   and row version, then call `publish_validated_chunk` twice with the same
   arguments. Assert the first returns `Ok` and the second returns
   `StateMismatch` or `CasConflict`, and that `count(mc_compartments)` increased
   by exactly the compartment count once.
2. Two firings on one session id, forced by constructing two `McHandler`s over one
   store path, which the lease should reject at open. Assert the rejection rather
   than the publish.
3. `historian.rs:3011` `concurrent_lineages_reattach_and_publish_in_isolated_sessions`
   already covers two lineages publishing in isolation; the missing case is two
   publishers on **one** session id.

## Investigation log

No open questions. All four layers were read at `HEAD` and each is independently
sufficient to serialize a second publisher for the same session and firing
sequence. The remaining uncertainty is about the lease's behaviour under abnormal
termination, which is out of Part 4a scope and is noted in the lens file's open
questions rather than here.
