# ring-a-cancellation-close-requires-an-empty-inbound-observation

## Discovery trigger

Building the teardown-trigger table for the ownership map. Five distinct
triggers stop the endpoint thread, and four of them are observed in a single
`select!`. Checking which loop passes reach that `select!` showed that a whole
branch of `run_endpoint` skips it.

## Evidence trail

**The loop's three ways to pick an outbound frame.**
`crates/mc-host/src/ring_transport.rs:409-443`:

```
let queued = if received {
    // Directions alternate under sustained inbound traffic: each
    // received frame is followed by at most one queued outbound
    // frame, taken without waiting, so a peer that refills the
    // inbound ring as slots release cannot starve responses, Pings,
    // and close frames while host-to-peer capacity is free.
    queue.try_recv().ok()
} else if finishing {
    match queue.try_recv() {
        Ok(frame) => Some(frame),
        Err(_) => return,
    }
} else {
    tokio::select! {
        biased;
        () = discard.cancelled() => return,
        () = finish.cancelled() => { finishing = true; None }
        () = read_cancel.cancelled(), if inbound.is_some() => { None }
        frame = queue.recv() => match frame {
            Some(frame) => Some(frame),
            None => return,
        },
        () = root.cancelled() => return,
        () = tokio::time::sleep(POLL_INTERVAL) => None,
    }
};
```

The first branch is taken whenever the preceding `receive_one` returned
`Ok(true)`, that is, whenever a frame was received. It checks nothing: not
`discard`, not `finish`, not `root`, not `read_cancel`. `queue.try_recv().ok()`
maps both `Empty` and `Disconnected` to `None`, so even a fully closed sender
queue produces `None` here and the loop `continue`s at `:444-446`.

So under sustained inbound traffic the `select!` is never evaluated, and the four
cancellation signals it carries are never observed.

**Where `read_cancel` is checked.** Three places, all conditional:

- `:392-399`, only on the `Ok(false)` branch, meaning `receive_one` found the
  ring empty:
  ```
  Ok(false) => {
      if read_cancel.is_cancelled() {
          if let Some(inbound) = inbound.take() {
              let _ = inbound.send(Err(ReadClose::Cancelled)).await;
          }
      }
  }
  ```
- `:492-494`, inside the ingress-budget loop.
- `:511-515`, the inner `select!` inside the budget loop.

**The design is deliberate and documented.** The comment on the `select!`'s
`read_cancel` arm, `:429-435`:

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

**What actually bounds it.** Two escapes exist independent of the ring going
empty:

1. `inbound.send` failure. `receive_one` sends at `:478-483` (rejection) and
   `:527-532` (delivery), and both map a send error to
   `Err(ReadClose::Cancelled)`. The send fails when the receiver is dropped,
   which happens when the connection task drops the `BoxedReceiver` it got in
   `PreparedRing` (`:107`). So once the host stops reading, the next received
   frame ends the loop. That bounds the window at one frame, not at the peer's
   quiescence — but only once the receiver is actually dropped.
2. Backpressure through the bounded inbound channel. `mpsc::channel(queue_frames)`
   (`:246`). If the read loop stops draining without dropping the receiver,
   `inbound.send(..).await` at `:531` blocks once the channel is full. That is a
   suspension, not an exit: the endpoint thread parks with a lease held and the
   generation is neither retired nor progressing.

Escape 2 is the one that matters for the bound, and whether it occurs depends on
`read_loop`'s cancellation behaviour, which is `connection.rs` and therefore Part
2a scope. I read only the close-classification match at
`connection.rs:387-405` and did not audit the loop, which is why this record's
confidence is medium.

**Why this is not purely academic.** `connection.rs:196-207` cancels the
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

`gen.token` is the ring's `root` (passed at `connection.rs:191` via
`new_generation`), so a peer whose setup socket dies while its ring still holds
committed frames cancels both tokens, and the endpoint thread keeps draining
those frames. That is arguably correct — the frames were committed before the
close and the drain contract says to deliver them — but it means the peer-death
path and the drain path are the same path, and a peer that dies with a full ring
extends its own teardown.

## Failure scenario

A retiring connection's endpoint thread keeps consuming and forwarding peer
frames after the close decision. Since `admission.release()` (`:291`) runs only
when the thread exits, the connection holds its full per-connection charge —
`per_connection_limits()`, which
`docs/mc-host-shm-transport.md:77` gives as 16 descriptors, 128 MiB of arena, 16
leases, two mappings, two file descriptors, one worker, one client instance —
for the whole extended drain.

Under `max_connections` pressure that is exactly the charge the next connect
needs. So a peer that floods during its own teardown converts an ordinary
retirement into `RingUnavailable` for an unrelated client, which per
`ring-a-ring-unavailability-fails-closed-without-a-classified-reason` is reported
as nothing at all beyond an `exhaustion.observed` increment while `state` stays
`"healthy"`.

The severity turns on escape 1. If the connection task drops the receiver
promptly on retirement, the window is one frame and this is a non-issue. If the
receiver stays alive through `serve_generation`'s drain sequence
(`connection.rs:290-347`), the window is the peer's.

## Timing windows and dependencies

Window: from the cancellation edge to the endpoint thread's exit. Bounded by,
whichever comes first:

- one further loop pass plus one `POLL_INTERVAL` (`:33`, 50 microseconds) once
  the ring goes empty;
- one further received frame once the inbound receiver is dropped;
- `frame_deadline` if the budget wait is entered, since `:495-500` exits on the
  absolute deadline.

Not bounded by the cancellation itself.

Dependencies:

- `ring-a-reclamation-count-does-not-witness-charge-release` uses this window as
  the reason the reclamation count can lead the release by an unbounded amount on
  the draining path.
- `ring-a-ring-unavailability-fails-closed-without-a-classified-reason` is the
  downstream consequence when the retained charge blocks a new connect.
- Part 2a's `close-disposition-is-a-total-function-of-the-read-exit-cause` and
  `no-task-outlives-the-generation-it-serves` are the connection-side properties
  this interacts with. The second is worth flagging: the endpoint thread is an OS
  thread, not a task, so it is outside that record's subject.

## What a test must construct

The METHOD liveness rule requires a bounded fault-free window: run under load,
stop the pressure, poll until stable within an explicit bound, then check.

1. Prepare a connection and attach a peer. `RingFactory::connect`
   (`frame_channel/contract_tests.rs:498-521`) supplies both.
2. Have the peer publish continuously, fast enough that
   `receive_one` returns `Ok(true)` on every pass. Eight descriptor slots
   (`:32`) and a peer that republishes as leases release is sufficient.
3. Cancel `root` (the harness exposes it as `Harness.generation`,
   `contract_tests.rs:517`) while the traffic continues.
4. Assert the thread has **not** exited while traffic continues — that is the
   preconditions half, and it is what makes the test fire on a correct
   implementation rather than only on a defect.
5. Stop the peer's publication. Poll until the endpoint thread has exited,
   asserting it does so within one `POLL_INTERVAL` of the first empty
   observation.

Step 4 is the part that makes this a coverage check rather than a violation
assertion. Step 5 is the bounded liveness assertion.

Observing "the thread has exited" needs an oracle. The `io` future
(`ring_transport.rs:301-303`) resolves exactly when `done_tx` fires at `:292`,
which is after the release, so awaiting it with a timeout is the available
oracle. `RingFactory` already spawns it as `io_task`
(`contract_tests.rs:512`, `:519`).

Existing checks: `budget_wait_observes_read_cancellation`
(`ring_transport.rs:928-965`) covers cancellation observed inside the budget
wait, which is the one path that does not need an empty observation. It asserts
`matches!(result, Err(ReadClose::Cancelled))` at `:964`. The main loop's path is
uncovered, and no `mc-host` inline test runs in CI.

## Investigation log

### Q: Does `read_loop` stop draining the inbound channel promptly on `read_cancel`, bounding this window?

- Sources examined: `connection.rs:387-405` (the `channel.recv()` match and the
  close classification), `connection.rs:249-347` (`serve_generation`'s sequence:
  `read_task.await` at `:291`, then `gen.read_cancel.cancel()` at `:292`, the
  `ReadExit` match at `:293-318`, `begin_close_generation` at `:319`,
  `read_tasks.close()` and `.wait()` at `:320-321`, the conditional
  `shutdown_complete` wait at `:322-324`, `close_generation` at `:332`,
  `writer_finish.finish()` at `:340`, and the `io_task` join at `:347`).
- Findings: the ordering is informative even without auditing the loop body.
  `serve_generation` awaits `read_task` at `:291` *before* doing anything else, so
  the read loop must return before the close sequence starts. The `BoxedReceiver`
  is moved into `read_loop` (`connection.rs:264-266`,
  `gen.read_tasks.track_future(read_loop(shared, &gen, channel))`), so it is
  dropped when `read_loop` returns. That means the receiver is dropped at
  `:291`, early in the sequence, and escape 1 applies from that point: the next
  received frame ends the endpoint loop.
  What I cannot determine without the loop body is how `read_loop` itself
  terminates when `read_cancel` is cancelled but frames keep arriving. If it has
  its own cancellation select, it returns promptly and the window is one frame. If
  it only returns on a `ReadClose`, then it keeps handling frames, the endpoint
  thread keeps feeding it, and the two loops sustain each other until the ring
  empties.
- Missing evidence: `read_loop`'s body, which begins at `connection.rs:373`.
  That is Part 2a scope and this lens's file list does not include
  `connection.rs`.
- Conclusion: unresolved, needs a read of `read_loop` against Part 2a's
  `cancellation-preempts-every-bounded-frame-read`, which is one of the six
  Group J records marked `superseded-by-refactor` because it was written against
  the deleted `frame_read.rs`. That record's obligation has migrated here, and
  settling it requires the two halves to be read together.

### Q: Should the `received == true` branch check `root.is_cancelled()`?

- Sources examined: `ring_transport.rs:409-415` and its comment at `:411-414`;
  `:429-435` and its comment; `connection.rs:196-207` (the peer-death
  cancellation).
- Findings: the two comments describe complementary intents that conflict here.
  `:411-414` justifies the branch as anti-starvation: "a peer that refills the
  inbound ring as slots release cannot starve responses, Pings, and close frames
  while host-to-peer capacity is free". `:429-435` justifies the drain-then-report
  design. Adding a `root.is_cancelled()` check to the fast branch would bound the
  teardown but would drop frames the drain design deliberately delivers, and it
  would do so for `root` specifically — which is the *generation* token, cancelled
  on peer death — so the frames dropped would be exactly the ones a dying peer
  committed before its socket closed.
- Missing evidence: whether delivering post-cancellation committed frames is a
  protocol obligation or a courtesy. `docs/mc-host-wire-protocol.md:298` says
  "Once publication begins, a missing terminal leaves the request outcome
  unknown", which is about the outbound direction. I found nothing stating an
  inbound drain obligation.
- Conclusion: needs human input. The two intents are both reasonable and the
  code currently serves the drain intent at the cost of an unbounded teardown
  window. Which to prefer is a design decision, and it depends on the answer to
  the first question above, since if `read_loop` already returns promptly the
  window is one frame and no change is needed.
