# shutdown-commits-exactly-once-on-write-ack

## Discovery trigger

A mutual-exclusion lens over the stop linearization point: ask which single writer
may cancel the shutdown token, and whether two authenticated requesters can both
reach it. `host.shutdown` runs in a spawned per-request task, so the number of
concurrent attempts is bounded only by the pending permit pool.

## Evidence trail

- `crates/mc-host/src/lifecycle.rs:1184-1187` is `ShutdownLatch`: a
  `Mutex<LatchPhase>` plus a `tokio::sync::Notify`. `LatchPhase` at `:1189-1194`
  is `Open | ResponseInFlight | Committed`.
- `lifecycle.rs:1216-1226` is `try_own`. The `Open -> ResponseInFlight` write at
  `:1219-1222` happens under the lock taken at `:1217`, so exactly one caller
  receives `Owner`; every later caller gets `Wait` (`:1223`) or `Committed`
  (`:1224`) until the phase moves again.
- `lifecycle.rs:1267-1290` is `CommitOnAck`. `acknowledge(mut self)` at
  `:1285-1289` sets `acknowledged`, calls `latch.commit()`, then
  `shutdown.cancel()`. `Drop` at `:1292-1297` reopens only when
  `!acknowledged`. Because `acknowledge` consumes `self`, the two effects are
  exclusive per hook instance: a hook reopens or commits, never both.
- `crates/mc-host/src/dispatch.rs:685-688` constructs the hook before any
  fallible step, and the comment at `:683-684` states that intent. Each early
  return after it — retired writer or cancelled token at `:690-692`, charge
  failure at `:695-699`, encode failure at `:700-711` — drops the hook and
  reopens.
- `dispatch.rs:720-733` installs the hook as the frame's `written` callback;
  `commit.acknowledge()` is at `:731`.
- `crates/mc-host/src/tcp_frame_channel.rs:345` moves `written` out of the
  `OutboundFrame` by value and `:393-394` calls it once, after
  `begin_publication` (`:336`) and a successful, non-discarded, non-timed-out
  write (`:366-388`). A frame that never publishes or never completes drops its
  hook instead.
- `dispatch.rs:745-756` spawns a watchdog that cancels the generation token at
  the same absolute deadline, which retires the writer and drops a still-queued
  hook. This is what stops `ResponseInFlight` from pinning the latch forever
  behind a slow reader.
- Commit is unconditional (`lifecycle.rs:1242`) while reopen is guarded on
  `ResponseInFlight` (`:1233-1235`), so a late reopen after a commit is a no-op.
- In-crate tests: `lifecycle.rs:1885-1911`, `:1913-1954`, `:1956-1985`,
  `:1989-2001`. Integration tests: `crates/mc-host/tests/lifecycle.rs:1400-1436`,
  `:1441`, `:1536`. The integration file runs in no CI job.

## Failure scenario

The property holds as written; the excluded scenario is a double stop.

1. Two authenticated connections send `host.shutdown`. Both tasks reach
   `dispatch.rs:653`.
2. Without the mutex in `try_own`, both read `Open` and both become owners. Both
   enqueue a committing response on their own generation.
3. Both writers complete, so `tcp_frame_channel.rs:394` fires twice and
   `shutdown.cancel()` runs twice. Cancellation is idempotent, so the visible
   damage is not the token but the freeze at `dispatch.rs:729-730` executing
   against a registry a second time and two responses claiming to be the
   linearization point.
4. The real code refuses this: the loser reads `Wait` at `:673`, waits on the
   change future, and on the next pass reads `Committed` at `:655` and answers
   with its own correlated success at `:658-671` without a second commit.

## Timing windows and dependencies

The exclusion window is the interval between `try_own` returning `Owner` and the
hook running or dropping, which spans a charge acquisition, an encode, a queue
admission, and a full-frame write — all bounded by the same absolute deadline
taken at `dispatch.rs:693`. Two requesters must overlap inside it. Nothing here
needs a fault to be reachable, but reaching the reopen-then-recommit sequence
needs a pre-acknowledgement failure on the first owner (fault class H8 or H3 in
the fault map). Multi-thread scheduling (H1) is required for the interleaving to
be genuinely concurrent rather than cooperatively ordered; all four in-crate
tests are `#[tokio::test]` with the default current-thread runtime.

## What a test must construct

A host on a multi-thread runtime, two authenticated connections, and a barrier so
both `host.shutdown` requests enter `handle_host_shutdown` before either
completes its write. Assert each correlation settles exactly once with a
parseable success, that no correlation receives two responses, and that the
handler observes exactly one `Shutdown` event. A second case must fail the first
owner before acknowledgement — discard its writer after enqueue, as
`lifecycle.rs:1940` does in-crate — then assert the second requester becomes
owner and commits, and that the first requester received no response or exactly
one non-committing response. A third case should pipeline a request behind an
already-committed response on one connection to exercise the `Committed` arm.

## Investigation log

### Q: (the catalog records none) Can a hook fire after a reopen has already handed ownership to a successor?

- Sources examined: `lifecycle.rs:1231-1244`, `:1285-1297`,
  `tcp_frame_channel.rs:336-399`, `dispatch.rs:685-737`.
- Findings: no. A reopen originates only in the `Drop` of a hook that was not
  acknowledged, and `acknowledge` takes `self` by value, so the same instance
  cannot later run. A dropped hook is gone with the frame, and the writer calls
  `written` only for a frame that passed `begin_publication` at `:336` and wrote
  fully. The dangerous ordering the catalog names — a late commit after a reopen —
  therefore has no producer, which is why the guard asymmetry between `commit`
  and `reopen` is safe rather than merely convenient.
- Missing evidence: no test drives a reopen and a successor commit concurrently;
  the in-crate test at `:1913-1954` does them in sequence on one thread.
- Conclusion: resolved. The exclusion is structural, from ownership of the hook.
