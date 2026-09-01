# shutdown-commit-effects-are-all-or-nothing

## Discovery trigger

A fallible-step lens over the commit point: the write-acknowledgement hook runs
three effects as three statements. Ask what state the host is in after each
prefix, and whether any prefix is recoverable. Two of the three statements can
panic, and the hook's own `Drop` behaves differently depending on which one does.

## Evidence trail

- The hook is `crates/mc-host/src/dispatch.rs:720-733`, installed as the frame's
  `written` callback. Its body is three statements in order:
  `shared.draining.store(true, Ordering::SeqCst)` (`:729`),
  `shared.registry.freeze_admission()` (`:730`), `commit.acknowledge()` (`:731`).
  The comment at `:723-728` reasons about ordering — the fence must flip
  "atomically with" the commit — and says nothing about partial application.
- **The hook is not panic-isolated.**
  `crates/mc-host/src/tcp_frame_channel.rs:393-394` calls `written(completed_at)`
  with no `catch_unwind`, in contrast with `:349`, where the same function wraps
  `direct.into_owned()` in `std::panic::catch_unwind`. So the surrounding
  protection exists in that loop and does not cover this call.
- **An abort cannot split the hook.** The closure at `dispatch.rs:722-732` is a
  synchronous `FnOnce` with no await point, invoked synchronously at
  `tcp_frame_channel.rs:394`. Tokio cancellation lands only at await points, so
  the catalog's "panic or abort inside the hook" reduces to a panic for the hook
  body itself. Aborting the writer task at some *earlier* await drops the hook
  unrun, which is the clean reopen case, not a partial one.
- Two prefixes are reachable in principle, and they differ:
  - A panic in `freeze_admission` — `crates/mc-host/src/routing.rs:210` is
    `self.inner.lock().expect("registry lock")`, so a poisoned registry mutex
    panics — leaves `draining == true`, `accepting` still true, the token live,
    and `CommitOnAck::drop` (`crates/mc-host/src/lifecycle.rs:1292-1297`) reopens
    the latch because `acknowledged` is still false.
  - A panic inside `acknowledge` is worse. `lifecycle.rs:1285-1289` sets
    `self.acknowledged = true` at `:1286` **before** `latch.commit()` at `:1287`.
    A poisoned latch mutex panics at `lifecycle.rs:1242`, and `Drop` then declines
    to reopen. That leaves `draining == true`, admission frozen, the latch stuck in
    `ResponseInFlight`, and the token never cancelled. **This asymmetry is not in
    the catalog.**
- The wedge chain is exact. `runtime.rs:996` returns the accept loop only on
  `shared.shutdown.cancelled()`, so with the token live the loop keeps running and
  `runtime.rs:910-911` never advances to `shutdown_sequence`. New generations are
  refused at `crates/mc-host/src/connection.rs:285` because `draining` is true. A
  generation already past that gate parks at `connection.rs:341-343`,
  `gen.shutdown_complete.cancelled().await`, and `shutdown_complete` is cancelled
  only at `runtime.rs:1174`, inside the sequence that cannot run. The instance
  guard is dropped at `runtime.rs:912-920`, after the sequence, so the lock is
  held for the lifetime of the wedged process.
- The panic is silent. The workspace sets no `panic = "abort"`, so the writer task
  unwinds alone, and `connection.rs:361` awaits it as `let _ = (&mut io_task).await;`,
  discarding the `JoinError`. No counter, no fatal trip, no log.
  `tcp_frame_channel.rs:402-403` — `queue.retired.cancel()` and `stream.shutdown()`
  — are skipped on the unwind path, and this file declares no `impl Drop` for the
  queue.
- Existing check: `lifecycle.rs:1913-1954`,
  `a_discarded_writer_drops_the_hook_unrun_and_reopens_the_latch`, covers the hook
  never running. No test drives a partial hook.

## Failure scenario

1. Some earlier panic occurs while the registry mutex is held, poisoning it. This
   is the step that cannot be constructed by inspection; `freeze_admission` itself
   holds the lock only across a flag write.
2. An authenticated `host.shutdown` wins the latch, charges, encodes, and enqueues
   its response with the hook attached.
3. The writer completes the full frame and calls the hook at
   `tcp_frame_channel.rs:394`. `:729` stores `draining = true`.
4. `:730` panics on the poisoned lock. `:731` never runs. The hook drops mid-unwind
   and `lifecycle.rs:1295` reopens the latch.
5. The requester's response bytes already reached the socket, so the client
   believes the host is stopping. The host is not: the token is live, the accept
   loop still runs, and every route open and routed dispatch is now refused with
   `server_busy` because `draining` is true.
6. Any connection whose read tasks have quiesced parks at `connection.rs:341-343`
   forever. The host holds the instance lock, serves nothing, and answers no
   further shutdown unless a new authenticated requester arrives and wins the
   reopened latch — which, in the `acknowledge` variant, cannot happen at all.

## Timing windows and dependencies

No scheduling race is needed once the enabling state exists; the hazard is a
single-threaded statement sequence. The dependency is entirely the enabling
state: a poisoned mutex, which means a prior panic inside a critical section
(fault class H2, deterministic panic injection, which the fault map records as
unavailable for the freeze step). The commit must also actually reach write
completion, so the peer has to read the response — a stalled reader retires the
generation through the watchdog at `dispatch.rs:747-756` instead. This record is
the partial-application half of `shutdown-commits-exactly-once-on-write-ack` and
supplies the wedged-host precondition that
`draining-rendezvous-is-released-or-the-loss-is-declared` asks about.

## What a test must construct

An injection point between `dispatch.rs:729` and `:730`, and a second between
`:730` and `:731`. With the first, assert the reachable-successor claim: after the
panic, `draining` is true, the latch is `Open`, the token is not cancelled, and a
second authenticated `host.shutdown` still commits and the host stops gracefully.
With the second, assert the stronger negative: the latch is neither `Open` nor
`Committed`, so no successor can own it, and the host never reaches
`shutdown_sequence`. A bounded assertion is required in both cases, because the
failing shape is a hang: wrap the run future in a timeout and assert the run does
*not* complete, rather than waiting on it. A cheaper partial substitute needs no
injection at all — assert that for every prefix, `draining == true` implies either
the token is cancelled or `try_own()` returns `Owner`.

## Investigation log

### Q: (the catalog records none) Which statement's panic is recoverable, and does `Drop` distinguish them?

- Sources examined: `lifecycle.rs:1285-1297`, `:1231-1244`, `dispatch.rs:729-731`,
  `routing.rs:209-211`, `tcp_frame_channel.rs:389-404`, `connection.rs:355-365`,
  root `Cargo.toml`.
- Findings: `Drop` distinguishes them, and not in the direction the guarantee
  implies. A panic before `acknowledge` reopens the latch, so a successor can
  still commit — the effects are not all-or-nothing but the state is recoverable.
  A panic *inside* `acknowledge` after `:1286` suppresses the reopen, so the
  effects are neither all, nothing, nor recoverable. The catalog's check clause
  ("if draining is set then the shutdown token is cancelled, or a successor
  requester can still commit") is therefore violated by the second prefix and
  satisfied by the first.
- Missing evidence: no comment addresses the flag-before-commit order inside
  `acknowledge`, and no test poisons either mutex. Whether a poisoned registry or
  latch mutex is reachable at all in production is not answerable by inspection.
- Conclusion: resolved as mechanism, unresolved as reachability. The two prefixes
  certainly differ; whether either enabling state occurs needs injection.
