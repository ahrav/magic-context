# latch-wake-cannot-be-lost

## Discovery trigger

A lost-wakeup lens over the contender path: `handle_host_shutdown` polls a
notification and rechecks a mutex-guarded phase, which is the classic shape where
a change landing between check and park is dropped. The in-code comment claims
`enable()` is what prevents it, so the question is whether the primitive actually
used has that requirement.

## Evidence trail

- The waiter loop is `crates/mc-host/src/dispatch.rs:646-681`. Each iteration
  creates the change future at `:650`, pins it at `:651`, enables it at `:652`,
  and only then calls `try_own()` at `:653`. The comment at `:647-649` states the
  rule as "notify_waiters wakes only enabled or polled futures".
- The primitive is `tokio::sync::Notify` (`crates/mc-host/src/lifecycle.rs:1186`),
  woken through `notify_waiters()` at `lifecycle.rs:1237` and `:1243`. The doc
  comment at `:1246-1250` repeats the enable-before-recheck claim.
- **Correction to the catalog's mechanism.** `notify_waiters` stores no permit —
  tokio 1.53.1 `src/sync/notify.rs:710-714` says so explicitly, and
  `inner_notify_waiters` transitions the state to `EMPTY` at `:758` rather than
  `NOTIFIED`. That half of the catalog is right. But "wakes only enabled or
  already-polled futures" is the `notify_one` rule, not the `notify_waiters` rule.
  `notify.rs:529-531` states that a `Notified` "is guaranteed to receive wakeups
  from `notify_waiters()` as soon as it has been created, even if it has not yet
  been polled." The mechanism is a generation counter: `notified()` snapshots
  `notify_waiters_calls` at construction (`notify.rs:562-572`), and the `Init` arm
  of `poll_notified` compares that snapshot against the live counter and completes
  immediately when it differs, both before taking the waiter lock (`:1121-1124`)
  and again with the lock held (`:1153-1156`). `inner_notify_waiters` increments
  the counter even when no waiter is registered (`:749-753`), which is what makes
  a created-but-unpolled future observe it. **So the load-bearing order is
  create-before-recheck, not enable-before-recheck.** `enable()` is sound and
  strictly stronger than required; it would become load-bearing only if either
  wake became `notify_one`, whose `enable()` doc at `notify.rs:1001-1002` links
  exactly that method.
- **Correction to the catalog's asymmetry claim.** The catalog says "reopen
  releases the phase lock before notifying while commit notifies while holding
  it". `commit` is `lifecycle.rs:1241-1244`:
  `*self.phase.lock().expect("latch lock") = LatchPhase::Committed;` on `:1242`,
  then `self.changed.notify_waiters();` on `:1243`. The `MutexGuard` is an
  unbound temporary in an expression statement, so it drops at the semicolon on
  `:1242`. **Commit does not hold the lock while notifying.** `reopen`
  (`:1231-1238`) does the same thing explicitly with `drop(phase)` at `:1236`.
  The asymmetry is in the source's shape, not in its behaviour, so it would not
  matter even under a wake-one primitive.
- The waiter is not unconditionally parked. `dispatch.rs:674-678` is a `biased`
  `select!` whose first arm is `gen.token.cancelled() => return`, so retirement of
  the waiter's own generation always releases it. A fresh change future is built
  each pass at `:650`, so no completed future is re-awaited.
- The stuck-permit cost is real: the request task holds `_pending_permit` at
  `crates/mc-host/src/connection.rs:725-726` for the whole wait.
- Existing check: `lifecycle.rs:1989-2001`,
  `an_enabled_change_future_survives_a_pre_poll_notification`, pins the
  create-enable-check-notify sequence with a one-second timeout. Its doc comment
  at `:1987-1988` restates the overstated rule. `lifecycle.rs:1956-1985` drives a
  real spawned waiter through both reopen and commit. All four latch tests are
  `#[tokio::test]` with the default current-thread runtime.

## Failure scenario

The property holds. The excluded scenario needs the notification to be missed:

1. Two authenticated requesters. The first wins the latch and enqueues its
   response; the second reads `Wait`.
2. The second requester's `try_own()` returns `Wait`, and before it reaches
   `&mut changed` the first attempt fails pre-acknowledgement, so
   `CommitOnAck::drop` calls `reopen()` and `notify_waiters()`.
3. Under a permit-free wake-one primitive with no registered waiter, that
   notification is discarded. The second requester then parks on a future that
   nothing will ever complete.
4. The latch sits at `Open` with no owner. The host never stops, the requester
   never answers, and its pending permit is never released — until its own
   generation retires and the `select!` arm at `dispatch.rs:676` returns.
5. The real code survives this because the future was created at `:650`, before
   the `try_own()` at `:653`, and `notify_waiters` bumps a counter the future
   already snapshotted.

## Timing windows and dependencies

The window is between `try_own()` returning `Wait` at `dispatch.rs:673` and the
first poll of `changed` at `:677`. It is a handful of instructions with no await
between them, so on a current-thread runtime no other task can run inside it and
the interleaving is unreachable. Reaching it needs a multi-thread runtime (fault
class H1, recorded unavailable in the fault map) plus a second requester and a
pre-acknowledgement failure on the first so `reopen` fires rather than `commit`.
The catalog is right that every existing test is current-thread; the in-crate test
at `lifecycle.rs:1989-2001` constructs the ordering by hand on one thread instead
of racing it.

## What a test must construct

A `#[tokio::test(flavor = "multi_thread", worker_threads = 2)]` case with a real
`ShutdownLatch`: an owner, a spawned waiter looping exactly as
`dispatch.rs:646-681` does, and a barrier or `yield_now` schedule that places the
`reopen()` between the waiter's `try_own()` and its first poll. Assert the waiter
returns `Owner` within a bounded timeout. Run the same shape with `commit()` and
assert `Committed`. Because the property is about an absent event, a positive
assertion is not enough on its own: pair it with a mutation that removes the
`changed()` call from before `try_own()` and confirm that variant times out, which
is what proves the create-before-check order is the load-bearing one. An
end-to-end case should drive two authenticated connections whose first owner is
discarded after enqueue, and assert the second settles rather than hanging.

## Investigation log

### Q: (the catalog records none) Is `enable()` actually required for the primitive in use, and does the lock asymmetry matter?

- Sources examined: `lifecycle.rs:1231-1253`, `dispatch.rs:646-681`, and tokio
  1.53.1 `src/sync/notify.rs:520-572`, `:708-760`, `:955-1005`, `:1104-1160`.
- Findings: no on both counts. `notify_waiters` reaches any future already
  created, so `enable()` adds nothing here; and `commit` releases the phase lock at
  the end of `:1242`, so the described asymmetry does not exist. The code and the
  comments are safe but overstate their own requirement, which means the comment
  at `dispatch.rs:647-649` would not warn a future editor about the case it
  actually protects against — moving `changed()` below `try_own()`.
- Missing evidence: nothing in the crate records which of the two orderings is
  load-bearing, and no test distinguishes them, so the distinction rests on the
  tokio version pinned in `Cargo.lock` (1.53.1). A future tokio that weakened the
  `notify_waiters` creation guarantee would change the answer.
- Conclusion: resolved as mechanism. The protocol is correct as written; the stated
  reason for its correctness is not the operative one.
