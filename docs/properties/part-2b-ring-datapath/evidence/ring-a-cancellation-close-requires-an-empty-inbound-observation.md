# ring-a-cancellation-close-requires-an-empty-inbound-observation

Re-derived 2026-08-31 against the eventfd transport (PR #131, merge
`5d638e3e8`). The polling-era evidence quoted a `select!` with a
`tokio::time::sleep(POLL_INTERVAL)` arm; that constant no longer exists in
`ring_transport.rs` (an inline test at `:798-806` asserts its absence), and
every line reference below was re-verified at HEAD `ec0f1bbe1`. The
polling-era derivation is retained in the investigation log's history note.

## Discovery trigger

Building the teardown-trigger table for the ownership map. Several distinct
triggers stop the endpoint thread, and most are observed in a single
`select!`. Checking which loop passes reach that `select!` showed that a whole
branch of `run_endpoint` skips it. The finding survives the eventfd rewrite
unchanged: the fast branch still observes no cancellation signal.

## Evidence trail

**The loop's ways to pick an outbound frame.**
`crates/mc-host/src/ring_transport.rs:414-473`:

```
let queued = if received {
    // Directions alternate under sustained inbound traffic: each
    // received frame is followed by at most one queued outbound
    // frame, taken without waiting, so a peer that refills the
    // inbound ring as slots release cannot starve responses, Pings,
    // and close frames while host-to-peer capacity is free.
    queue.try_recv().ok()
} else if finishing {
    match queue.try_recv() { .. }
} else {
    let data_armed = if inbound.is_some() {
        match rings.second.arm_data_wait() { .. }
    } else { false };
    tokio::select! {
        biased;
        () = discard.cancelled() => return,
        () = finish.cancelled() => { finishing = true; None }
        () = read_cancel.cancelled(), if inbound.is_some() => { None }
        frame = queue.recv() => .. ,
        ready = readiness.readable(), if data_armed => { .. }
        () = root.cancelled() => return,
    }
};
```

The first branch is taken whenever the preceding `receive_one` returned
`Ok(true)`, that is, whenever a frame was received. It checks nothing: not
`discard`, not `finish`, not `root`, not `read_cancel`.
`queue.try_recv().ok()` maps both `Empty` and `Disconnected` to `None`, so
even a fully closed sender queue produces `None` here and the loop continues.

So under sustained inbound traffic the `select!` is never evaluated, and the
cancellation signals it carries are never observed.

**Where `read_cancel` is checked.** Three places, all conditional:

- `:399-404`, only on the `Ok(false)` branch, meaning `receive_one` found the
  ring empty (or lease-saturated):
  ```
  Ok(false) => {
      if read_cancel.is_cancelled() {
          if let Some(inbound) = inbound.take() {
              let _ = inbound.send(Err(ReadClose::Cancelled)).await;
          }
      }
  }
  ```
  Note the `inbound.take()`: the report is one-shot, and after it fires the
  loop keeps running egress-only until `discard`, `finish`, `root`, or queue
  closure ends it. The post-#131 test
  `finish_wakes_after_read_cancellation_with_unread_peer_data` (`:809-846`)
  exercises exactly that continuation.
- `:448-454`, the biased `select!` arm, whose comment states the contract.
- `:525`, the first arm of the charge-wait `select!` inside `receive_one`.

**The design is deliberate and documented.** The comment on the `select!`'s
`read_cancel` arm, `:448-454`:

```
() = read_cancel.cancelled(), if inbound.is_some() => {
    // Re-enter the receive path once after observing
    // cancellation. It drains frames committed before the
    // cancellation edge, then reports `Cancelled` after the
    // first empty observation.
    None
}
```

So "report `Cancelled` after the first empty observation" is the stated
contract, not an oversight. The property is therefore not "cancellation is
observed promptly" but "the drain terminates", and the bound is the peer's
publication behaviour, not the host's.

**What replaced the polling backstop.** Pre-#131 the empty-ring case slept
`POLL_INTERVAL` (50 microseconds) and retried. Post-#131 the loop arms the
transport's wake protocol before parking: `arm_data_wait` (`ring.rs:828-854`)
publishes a parked epoch and re-checks data availability, returning `false`
when data or a generation change is already visible; the loop then parks on
the duplicated eventfd doorbell (`duplicate_data_ready` wrapped in an
`AsyncFd`, `ring_transport.rs:371-380`) through the `readiness.readable()` arm
(`:459-471`), which clears readiness and calls `complete_data_wait`
(`ring.rs:857-862`). The producer's `signal_wake` (`ring.rs:1418-1432`) rings
the doorbell only when a parked epoch is visible. Two consequences for this
record. First, the drain itself does not depend on the doorbell: once the
`read_cancel` arm fires, the loop re-enters `receive_one`, which calls
`try_receive` directly (`:496-498`), so committed frames drain and the first
empty observation reports `Cancelled` with no periodic wait in between. The
frame-count bound is therefore tighter than in the polling era, not looser.
Second, a wake-protocol defect (a doorbell signal lost between `arm_data_wait`
and `signal_wake`'s parked-epoch check) is a new failure mode for the
*pre-cancellation* drain obligation; see the failure scenario.

**What actually bounds it.** Two escapes exist independent of the ring going
empty:

1. `inbound.send` failure. `receive_one` sends at `:510-515` (rejection) and
   `:551-556` (delivery), and both map a send error to
   `Err(ReadClose::Cancelled)`. The send fails when the receiver is dropped,
   which happens when the connection task drops the receiver it got in
   `PreparedRing` (`:97`). So once the host stops reading, the next received
   frame ends the loop. That bounds the window at one frame, not at the peer's
   quiescence — but only once the receiver is actually dropped.
2. Backpressure through the bounded inbound channel.
   `mpsc::channel(queue_frames)` (`:230`). If the read loop stops draining
   without dropping the receiver, `inbound.send(..).await` at `:551-556`
   blocks once the channel is full. That is a suspension, not an exit: the
   endpoint thread parks with a lease held and the generation is neither
   retired nor progressing.

Escape 2 is the one that matters for the bound, and whether it occurs depends
on `read_loop`'s cancellation behaviour, which is `connection.rs` and
therefore Part 2a scope. This record's confidence stays medium for that
reason.

**Why this is not purely academic.** `connection.rs:183-189` cancels the
generation token from the peer-death observer:

```
close = crate::setup_socket::observe_peer(&mut stream) => {
    if close != crate::setup_socket::PeerClose::Goodbye {
        peer_ring.record_peer_death();
    }
    peer_gen.token.cancel();
    peer_gen.read_cancel.cancel();
}
```

`peer_gen.token` is the ring's `root`, so a peer whose setup socket dies while
its ring still holds committed frames cancels both tokens, and the endpoint
thread keeps draining those frames. That is arguably correct — the frames were
committed before the close and the drain contract says to deliver them — but
it means the peer-death path and the drain path are the same path, and a peer
that dies with a full ring extends its own teardown.

## Failure scenario

A retiring connection's endpoint thread keeps consuming and forwarding peer
frames after the close decision. Since `admission.release()` (`:276`) runs
only when the thread exits, the connection holds its full per-connection
charge for the whole extended drain. Under `max_connections` pressure that is
exactly the charge the next connect needs, so a peer that floods during its
own teardown converts an ordinary retirement into `RingUnavailable` for an
unrelated client, which per
`ring-a-ring-unavailability-fails-closed-without-a-classified-reason` is
reported as nothing at all beyond an `exhaustion.observed` increment while
`state` stays `"healthy"`.

The severity turns on escape 1. If the connection task drops the receiver
promptly on retirement, the window is one frame and this is a non-issue. If
the receiver stays alive through `serve_generation`'s drain sequence, the
window is the peer's.

**New with #131: lost-wake and wake-race failure modes.** The drain obligation
now shares its wait with an eventfd wake protocol, and the interesting
failures are on the sparse-signal path rather than in the drain itself.

- *Wake race, handled by design.* A peer that commits a frame after the host's
  `arm_data_wait` observed an empty ring but before the host parks would, on a
  naive design, sleep past the frame. `arm_data_wait` closes this: it stores
  `parked = generation + 1`, then re-checks data availability and the
  generation counter before returning `true` (`ring.rs:835-853`), and
  `signal_wake` increments the generation before testing `parked`
  (`ring.rs:1426-1428`), so one side always observes the other. A test that
  drives commit-versus-park interleavings is the check this protocol needs,
  and none exists in `mc-host`.
- *Lost wake, consequence bounded by the cancellation path.* If a doorbell
  signal were lost anyway, an uncancelled connection would stall on committed
  frames until the next publication — a liveness failure belonging to the
  transport's wake protocol (Part 1 territory post-#131). For *this* record
  the exposure is narrower: the `Cancelled` report does not depend on the
  doorbell at all, because `read_cancel.cancelled()` is a `CancellationToken`
  arm and the post-cancellation drain calls `try_receive` directly. So a lost
  wake cannot defer the cancellation report, but it can mean frames committed
  before the cancellation edge sat undelivered until the cancellation forced
  the re-entry — a drain-contract violation a fault-free campaign should
  witness against the frame-count bound.

## Timing windows and dependencies

Window: from the cancellation edge to the endpoint thread's exit. Bounded by,
whichever comes first:

- at most `N + 1` further `receive_one` invocations, where `N` is the number
  of frames committed before the cancellation edge, once the peer stops
  publishing — a frame-count bound, since there is no periodic sleep left to
  count against;
- one further received frame once the inbound receiver is dropped;
- `frame_deadline` if the charge wait is entered, since `:527-532` exits on
  the absolute deadline taken at `:519`.

Not bounded by the cancellation itself, and not bounded at all when the
inbound channel neither closes nor drains: the report parks on
`inbound.send(..).await` at `:402` with no deadline.

Dependencies:

- `ring-a-reclamation-count-does-not-witness-charge-release` uses this window
  as the reason the reclamation count can lead the release by an unbounded
  amount on the draining path.
- `ring-a-ring-unavailability-fails-closed-without-a-classified-reason` is the
  downstream consequence when the retained charge blocks a new connect.
- Part 2a's `close-disposition-is-a-total-function-of-the-read-exit-cause` and
  `no-task-outlives-the-generation-it-serves` are the connection-side
  properties this interacts with. The second is worth flagging: the endpoint
  thread is an OS thread, not a task, so it is outside that record's subject.
- Post-#131, the wake protocol itself (`arm_data_wait`, `complete_data_wait`,
  `signal_wake`, `wait_for_data` at `ring.rs:828-854`, `:857-862`,
  `:1418-1432`, `:1138`) is transport-crate machinery whose correctness this
  record assumes; its own properties belong to a Part 1 eventfd pass.

## What a test must construct

The METHOD liveness rule requires a bounded fault-free window: run under load,
stop the pressure, poll until stable within an explicit bound, then check.

1. Prepare a connection and attach a peer (`RingClientEndpoint`,
   `ring_transport.rs:660`).
2. Have the peer publish continuously, fast enough that `receive_one` returns
   `Ok(true)` on every pass. Eight descriptor slots (profile-pinned; asserted
   at `:903`) and a peer that republishes as leases release is sufficient.
3. Cancel `root` or `read_cancel` while the traffic continues.
4. Assert the thread has **not** exited while traffic continues — that is the
   preconditions half, and it is what makes the test fire on a correct
   implementation rather than only on a defect.
5. Stop the peer's publication. Poll until the endpoint thread has exited,
   asserting the two frame-count bounds: at most `N + 1` further `receive_one`
   invocations after the cancellation edge, and no post-edge frame forwarded
   on the inbound channel.

Step 4 is the part that makes this a coverage check rather than a violation
assertion. Step 5 is the bounded liveness assertion, in frames, the unit the
code actually counts.

Observing "the thread has exited" needs an oracle. The `io` future
(`ring_transport.rs:286-288`) resolves exactly when `done_tx` fires at `:277`,
which is after the release, so awaiting it with a timeout is the available
oracle.

Existing checks: `budget_wait_observes_read_cancellation`
(`ring_transport.rs:1008-1043`) covers cancellation observed inside the charge
wait, which is the one path that does not need an empty observation; it
asserts `matches!(result, Err(ReadClose::Cancelled))` at `:1043`.
`finish_wakes_after_read_cancellation_with_unread_peer_data` (`:809-846`)
covers the empty-ring report (`:827`) and the finishing loop's wake with
unread peer data, which is the post-report continuation this record's one-shot
`inbound.take()` creates. Neither asserts the drain bound under sustained
traffic, and no `mc-host` inline test runs in CI.

## Investigation log

### 2026-08-31: eventfd reconciliation (PR #131)

- Sources examined: `ring_transport.rs:359-485` (`run_endpoint` at HEAD
  `ec0f1bbe1`), `:487-558` (`receive_one`), `:798-806`
  (`shared_memory_workers_have_no_periodic_polling`), `:809-846`
  (`finish_wakes_after_read_cancellation_with_unread_peer_data`),
  `ring.rs:820-862` (`duplicate_data_ready`, `arm_data_wait`,
  `complete_data_wait`), `ring.rs:1418-1432` (`signal_wake`),
  `connection.rs:183-189` (the peer-death handler at HEAD).
- Findings: `POLL_INTERVAL` is gone; the empty-ring wait is an armed eventfd
  park and the ingress wait is an async semaphore charge. The drain-before-
  report contract survived verbatim (the comment at `:449-453` is the
  polling-era comment moved), the `received == true` fast branch still skips
  every cancellation signal, and the `Cancelled` report moved into a one-shot
  `inbound.take()` on the `Ok(false)` branch (`:399-404`), after which the
  loop runs egress-only. The frame-count bound from the polling-era
  disposition transfers unchanged and is now the only bound shape available,
  since there is no interval left to state a wall-clock bound in. The three
  `inbound.send(..).await` sites are still undeadlined (`:402`, `:510-515`,
  `:551-556`), so the unresolved no-bound residual carries over verbatim.
- Missing evidence: none for the mechanics; the `read_loop` question below is
  still the open half.
- Conclusion: resolved with answer — the record's guarantee, check semantics,
  and frame-count bound survive the rewrite; the mechanism description and
  every line citation were replaced; a lost-wake/wake-race failure mode was
  added to the failure scenario. History: the pre-#131 version of this file
  quoted the polling `select!` (with its
  `() = tokio::time::sleep(POLL_INTERVAL) => None` arm at then-`:442`) and
  bounded the post-drain exit at "one further loop pass plus one
  `POLL_INTERVAL` (then-`:33`, 50 microseconds) once the ring goes empty";
  both statements were true of `e447c927` and are preserved here as history
  rather than restated as fact.

### Q: Does `read_loop` stop draining the inbound channel promptly on `read_cancel`, bounding this window?

- Sources examined (pre-#131 pass): `connection.rs` close-classification match
  and `serve_generation`'s sequence: the read-task await, the `ReadExit`
  match, `begin_close_generation`, and the `io_task` join.
- Findings: the ordering is informative even without auditing the loop body.
  `serve_generation` awaits the read task before doing anything else, so the
  read loop must return before the close sequence starts, and the receiver is
  moved into `read_loop`, so it is dropped when `read_loop` returns. From that
  point escape 1 applies: the next received frame ends the endpoint loop. What
  I cannot determine without the loop body is how `read_loop` itself
  terminates when `read_cancel` is cancelled but frames keep arriving.
- Missing evidence: `read_loop`'s body, which is Part 2a scope. PR #131 also
  rewrote `connection.rs`, so the pre-merge line anchors this entry once
  carried were dropped rather than restated.
- Conclusion: unresolved, needs a read of `read_loop` against Part 2a's
  cancellation records. Until it is resolved, the case where the channel
  neither closes nor drains has no bound at all.

### Q: Should the `received == true` branch check `root.is_cancelled()`?

- Sources examined: `ring_transport.rs:415-421` and its comment at `:416-420`;
  `:448-454` and its comment; `connection.rs:183-189` (the peer-death
  cancellation).
- Findings: the two comments describe complementary intents that conflict
  here. `:416-420` justifies the branch as anti-starvation: "a peer that
  refills the inbound ring as slots release cannot starve responses, Pings,
  and close frames while host-to-peer capacity is free". `:449-453` justifies
  the drain-then-report design. Adding a `root.is_cancelled()` check to the
  fast branch would bound the teardown but would drop frames the drain design
  deliberately delivers, and it would do so for `root` specifically — the
  generation token, cancelled on peer death — so the frames dropped would be
  exactly the ones a dying peer committed before its socket closed.
- Missing evidence: whether delivering post-cancellation committed frames is a
  protocol obligation or a courtesy. I found nothing stating an inbound drain
  obligation.
- Conclusion: needs human input. The two intents are both reasonable and the
  code currently serves the drain intent at the cost of an unbounded teardown
  window. Which to prefer depends on the `read_loop` answer above, since if
  `read_loop` already returns promptly the window is one frame and no change
  is needed.
