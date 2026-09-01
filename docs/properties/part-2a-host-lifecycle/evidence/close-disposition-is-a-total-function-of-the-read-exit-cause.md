# close-disposition-is-a-total-function-of-the-read-exit-cause

Verified at `1c193ae0`. The catalog cites `d90e7811`; HEAD moved to the merge
commit `1c193ae0` and `git diff d90e7811 HEAD` is empty for `connection.rs`. This
file exceeds the 90-line budget because the record's evidence *is* a five-commit
history and enumerating the exit sites is part of the deliverable.

## Discovery trigger

Not a hypothesis. Five consecutive review rounds each shipped a different, wrong
answer to one question: when the read side stops, which frames may still reach the
socket? Each fix was locally reasonable and each was corrected by the next. The
property exists to name the decision those five commits converged on, so a sixth
iteration is a test failure rather than a review finding.

## Evidence trail

- `connection.rs:371-379` — the `ReadExit` enum, three variants. The doc comment
  at `:365-370` states the rule the code is trying to encode: "Only a
  host-cancelled read may keep the writer draining: every peer-driven exit (EOF,
  corruption, peer Goodbye, protocol violation) retires silently, even
  mid-shutdown." `PeerKeepQueue(tokio::sync::oneshot::Receiver<()>)` at `:378`
  carries the fence for the one exception.
- `connection.rs:306-332` — the disposition match, immediately after `read_task
  .await` (`:304`) and `gen.read_cancel.cancel()` (`:305`). Three arms:
  - `:311` `ReadExit::HostCancelled if !gen.token.is_cancelled() => {}` — the only
    arm that emits nothing and suppresses nothing; the drain proceeds.
  - `:317-322` `ReadExit::PeerKeepQueue(terminal_written) => { let _ =
    terminal_written.await; gen.token.cancel(); gen.writer.discard(); }` — wait for
    exactly one frame, then retire.
  - `:328-331` `ReadExit::HostCancelled | ReadExit::Peer => { gen.token.cancel();
    gen.writer.discard(); }` — silent close.
- `connection.rs:175-176` is why the guard at `:311` is load-bearing:
  `read_cancel` is `gen_token.child_token()`. Cancelling the generation token
  therefore also cancels the read token, so a *retirement* (liveness invalidation,
  emission failure) produces `ReadClose::Cancelled` →
  `ReadExit::HostCancelled` at `:400`, identical to a graceful drain. The
  `!gen.token.is_cancelled()` test is the only thing distinguishing them.
- `tcp_frame_channel.rs:162`, `:209`, `:283` — the three origins of
  `ReadClose::Cancelled`, all keyed on that same `cancel` token, confirming the
  two sources are genuinely indistinguishable at the enum level.

### The convergence chain

Each `git show` below is scoped to `crates/mc-host/src/connection.rs`.

1. **`8a4cf9ea`** ("thirteenth-round", +8 lines) introduced the decision:
   `if !shared.draining.load(Ordering::SeqCst) { gen.token.cancel(); }`. Wrong in
   two ways: it keyed on the host-wide `draining` flag rather than on why *this*
   reader stopped, and cancelling the token alone stops future admissions while
   leaving already-queued frames to flush.
2. **`62b7a46b`** ("fourteenth-round") added `gen.writer.discard()` beside the
   cancel and introduced `discard` as a token distinct from `retired`. Fixes the
   queued-frame half. Still keyed on `draining`.
3. **`ce4e102f`** ("fifteenth-round", +61/-34) replaced the key: the `ReadExit`
   enum appears here with two variants, and the condition becomes
   `matches!(read_exit, ReadExit::Peer)`. The commit message names the defect
   being fixed — "a peer that sends a corrupt frame mid-shutdown still gets a
   silent close" — i.e. rounds 13 and 14 gave terminals to a misbehaving peer
   purely because the host happened to be draining.
4. **`7cf10707`** ("seventeenth-round", +65/-20) converted the `if` to the current
   `match` and made two corrections at once. It added the
   `HostCancelled if !gen.token.is_cancelled()` guard, because an *inherited*
   cancellation had been treated as a graceful drain; and it added
   `PeerKeepQueue` (a unit variant, with an empty arm `PeerKeepQueue => {}`)
   because an oversized-control drain failure was discarding an authoritative
   terminal the protocol had already promised.
5. **`2d5a3569`** ("eighteenth-round", +57/-32) fixed round 17's own fix. The bare
   marker's empty arm kept the *whole* queue alive, so unrelated responses and
   Goodbyes flushed on a corrupt stream. The variant became
   `PeerKeepQueue(oneshot::Receiver<()>)`, the rejection emission was moved
   off-reader carrying a `terminal_tx`, and the arm now awaits that one signal and
   then cancels and discards.

### Read-exit return sites at HEAD

`ReadExit` never leaves `connection.rs` (repo-wide grep: 32 mentions, all in that
file). Counting constructions, not match arms: **25 sites** — 1 `HostCancelled`,
2 `PeerKeepQueue`, 22 `Peer`.

- `HostCancelled`: `:400` only (`Err(ReadClose::Cancelled)`).
- `PeerKeepQueue`: `:407` (rejection-drain failure with a stored written-signal)
  and `:874` (in `handle_negotiate`).
- `Peer`, in `read_loop` (`:382-599`): `:408`, `:414` (four `ReadClose` variants
  collapsed into one arm — `CleanEof`, `Corrupt`, `Io`, `Overloaded`), `:427`,
  `:431`, `:446`, `:470`, `:481`, `:484`, `:493`, `:496`, `:502`, `:544`, `:547`,
  `:550`, `:553`, `:594` (eight role-violating frame types in one arm).
- `Peer`, in helpers reached from `handle_control` (`:626`): `:646`, `:847`,
  `:883`, `:886`, `:1047`, `:1072`. All funnel back through the single
  propagation point `:477` `ControlFlow::Close(exit) => return exit`.

**Correction:** the catalog's Fault/timing angle and `fault-map.md` both say
"eleven read-exit sites". That count is accurate for `2d5a3569` — the last commit
in the chain, where `git show 2d5a3569:...` yields exactly 11 non-`HostCancelled`
construction sites — but stale for HEAD, which has 24. The count grew with
`ReadClose::Overloaded`, the transport-readiness gates, and the candidate-grant
helpers.

## Failure scenario

The compile-time hole the guard at `:311` creates:

1. A new retirement source is added that cancels `gen.read_cancel` without
   cancelling `gen.token` — a new read-side deadline, a per-connection quota, a
   provider-health check.
2. The read loop observes `ReadClose::Cancelled` and returns
   `ReadExit::HostCancelled` at `:400`.
3. `gen.token.is_cancelled()` is false, so the guarded arm at `:311` matches and
   the body is empty: no cancel, no discard.
4. Consequence: everything queued flushes — terminals, and a connection Goodbye if
   shutdown later queues one — for a connection retired by a host-internal fault
   the peer knows nothing about. That is the inverse of round 17's defect, reached
   by adding a *cause* rather than a variant. Symmetrically, a new cause that
   returns `ReadExit::Peer` inherits the silent close, which is the safe default
   but is also silent about the fact that no one declared it.

## Timing windows and dependencies

Two windows. The `PeerKeepQueue` arm at `:317-322` awaits a `oneshot::Receiver`
with no timeout of its own; the comment at `:313-316` argues it is self-bounding
because the emission carries admission and write deadlines and a failed emission
drops the sender, so the receiver resolves with `Err`. That reasoning depends on
`shared.timing.frame_deadline` and the writer's per-frame stall bound, so it is
configuration-dependent — a very large `frame_deadline` widens it. The guarded arm
at `:311` reads `gen.token.is_cancelled()` at a single point after the reader has
already returned, so a cancellation arriving between `:304` and `:311` flips the
disposition; both orderings are defensible, but which one occurred is not
recorded. Dominates `retirement-discards-only-through-the-discard-token`, which
owns what `discard()` actually guarantees once this match calls it, and
`a-retired-generation-emits-nothing-and-mutates-nothing`, which owns the
post-cancel emit gates. Depends on nothing.

## What a test must construct

Each of the 25 sites reached with queued emissions already in flight — the
disposition is only observable when there is something to suppress or flush. A
test that closes an idle connection passes all three arms vacuously.

Concretely, three classes:

- Silent close: a queued off-reader response (a slow handler terminal admitted but
  not yet published), then a peer-driven exit — a corrupt frame is the cheapest
  trigger for `:414` — asserting zero bytes reach the peer socket after the close
  decision, including during an active drain.
- Drain: the same queued state, with `shutdown_sequence` cancelling
  `read_cancel` while `gen.token` is untouched, asserting the terminal *and* the
  Goodbye arrive in protocol order.
- The `PeerKeepQueue` fence: an oversized control body so `:407` fires with a
  stored `reject_written`, a second queued frame that is *not* the authoritative
  terminal, and an assertion that exactly one frame reaches the socket and the
  second does not. This is round 18's regression and needs both frames queued
  simultaneously (fault class H1).

The oracle must be per-cause, not aggregate: for each site, the emitted byte
sequence after the close decision equals the declared set for that arm. Coverage
checks to emit: `host_close_disposition_site_<n>_reached`,
`host_inherited_cancel_took_silent_arm`, and
`host_keepqueue_fenced_exactly_one_frame`.

## Investigation log

### Q: Should the disposition be encoded so a new cause cannot compile without a declared disposition?

- Sources examined: `crates/mc-host/src/connection.rs:306-332` (the match),
  `:371-379` (the enum), `:400-414` and every `Peer` site listed above, `:477`
  (the single propagation point), `:175-176` (the token parentage);
  `crates/mc-host/src/tcp_frame_channel.rs:162`, `:209`, `:283`; `git show` for all
  five chain commits scoped to `connection.rs`. I also compiled a reduced repro of
  the match's exact shape — a guarded arm, a payload arm, and a
  two-variant or-pattern arm, with no wildcard — under `rustc --edition 2021`.
- Findings: the match is **total over the three variants and not total over the
  causes**, and the two halves have different guarantees.
  - Over variants it is total and enforced. There is no `_` arm, so
    exhaustiveness applies: the reduced repro with a fourth variant added fails
    with `error[E0004]: non-exhaustive patterns`, and the three-variant form
    compiles. Adding a `ReadExit` variant therefore cannot land without an
    explicit disposition. The guarded arm does not weaken this — `HostCancelled`
    is still covered by `:328`.
  - Over causes it is not total in any enforced sense. 24 of the 25 construction
    sites pick an existing variant, so a new exit reason inherits whichever
    disposition its author chose, with no declaration and no diagnostic. The
    `HostCancelled` guard makes this concretely dangerous rather than merely
    untidy: it is the one place where two genuinely different causes share a
    variant and are separated by a runtime state read, which is exactly the defect
    `7cf10707` fixed and exactly the shape a new cancellation source would
    reintroduce.
- Missing evidence: none about the current code. What is missing is the design
  decision — whether causes should be lifted into the type (a variant or a
  `#[non_exhaustive]` reason enum carried by `Peer`) is a change to the public
  shape of the read side, with a cost in call-site churn across 24 sites, and it
  trades against keeping `Peer` as a deliberate catch-all for "peer misbehaved,
  details do not affect disposition".
- Conclusion: unresolved, needs human input on the encoding question. The factual
  half is resolved: totality holds over variants and is compiler-enforced; it does
  not hold over causes, and the `HostCancelled` guard is where that gap has
  already produced one shipped defect.
