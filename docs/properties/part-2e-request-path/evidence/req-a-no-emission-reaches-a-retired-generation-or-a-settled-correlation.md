# req-a-no-emission-reaches-a-retired-generation-or-a-settled-correlation

## Discovery trigger

Task 4 asked whether a late handler result can be delivered against a closed or
superseded generation. Part 2a's silent-close rule depends on the answer: a
retirement that fabricated a terminal would contradict protocol §6.3.

## Evidence trail

Four emission entry points, each rechecking liveness unconditionally.

**`charged_error_body`**, `dispatch.rs:195-197`:

```
if gen.writer.is_retired() || gen.token.is_cancelled() {
    return Err(());
}
```

This precedes the byte charge, so an error body for a dead generation is never
allocated.

**`emit_frame_with_written`**, `dispatch.rs:277-282`:

```
if body.len() > crate::wire::MAX_BODY_LEN as usize
    || gen.writer.is_retired()
    || gen.token.is_cancelled()
{
    return Err(());
}
```

**`emit_reserved_frame`**, `dispatch.rs:323-325`: the same two-condition check,
before `into_parts` and before any encoding.

**`StreamSink::reserve`** and **`reserve_direct`** check on *both* sides of the
budget wait. Before, at `:519-524` and `:550-555`:

```
if max_len > crate::wire::MAX_BODY_LEN as usize
    || self.cancel.is_cancelled()
    || self.settlement.won.load(Ordering::SeqCst)
{
    return Err(StreamClosed);
}
```

After, at `:531-536` and `:562-567`:

```
if self.cancel.is_cancelled()
    || self.gen.token.is_cancelled()
    || self.settlement.won.load(Ordering::SeqCst)
{
    return Err(StreamClosed);
}
```

The post-wait check is the load-bearing one: a charge granted before cancellation
must not be usable after it. Note the pre-wait check omits `gen.token` while the
post-wait check includes it, so the generation condition is enforced exactly once
and on the correct side.

The budget wait itself is also cancellation-aware. `charge_frame_or_cancel`
(`dispatch.rs:143-168`) is `biased` and orders request cancellation first,
generation cancellation second, and the charge last:

```
tokio::select! {
    biased;
    () = request_cancelled => None,
    () = generation.token.cancelled() => None,
    charge = timeout_at(deadline, budget.charge(bytes)) => ...
}
```

`also_cancelled` is `Some(&self.cancel)` for both stream reservations
(`:528`, `:559`) and `None` for the error and shutdown paths (`:200`, `:288`,
`:719`), which matches the comment at `:135-137`: "the request-scoped token where
one exists (stream paths watch both it and the generation's)".

The settled condition is enforced separately by `Settlement`. `StreamSink::send`
rechecks `won` at `:584` *inside* the order lock, so a stream item cannot follow
a terminal even if `reserve` succeeded before the terminal was chosen. The
comment at `:516-518` names the case: "a context escaped into a background task
must not keep reserving egress budget for buffers `send` can never emit."

The request token is deliberately not a child of the generation token. It is
constructed as a free-standing root at `dispatch.rs:914`, and the comment at
`:911-913` explains: "The request token is a free-standing root: route close
cancels entries explicitly when it collects them." Route close does that at
`:1332-1342`.

## Failure scenario

Without the post-wait recheck in `reserve`:

1. A handler calls `ctx.reserve_output(N)`. The budget is contended, so it awaits.
2. The generation is cancelled — peer EOF, framing corruption, or teardown.
3. The budget frees and `charge_frame_or_cancel` returns a charge, because the
   `biased` select's generation arm and the charge arm can both be ready in the
   same poll and the bias only decides which wins that poll.
4. `reserve` returns an `OutputBuffer` holding a live charge against a dead
   generation.
5. The handler writes and calls `ctx.stream(item)`, which reaches
   `emit_reserved_frame`.

Step 5 is caught by `emit_reserved_frame`'s own check at `:323-325`, so there are
two independent defences. The one at `:531-536` is the cheaper one: it fails
before the buffer is allocated, so it also prevents the charge from being held
across a pointless allocation.

The forbidden end state — a frame carrying a settled correlation, or any frame on
a retired generation — is therefore guarded at every one of the four entry points
plus inside the select that gates them.

## Timing windows and dependencies

The windows are all "across an await":

- `charge_frame_or_cancel`'s budget wait, bounded by
  `gen.writer.admission_deadline()` (`frame_channel.rs:710-712`).
- `send_before`'s admission wait, bounded by the same deadline.
- `StreamSink::send`'s order-lock acquisition, unbounded in principle but held by
  another emission for at most one admission window.

Dependency: `gen.writer.is_retired()` and `gen.token.is_cancelled()` are two
distinct conditions and both are checked. The writer's retirement is
`frame_channel`'s state (Part 2b); the token is the generation's. A retirement
that set only one of them would leave a gap, which is presumably why both are
always tested together — all four entry points test the pair, never one alone.

## What a test must construct

1. A handler that reserves output, awaits a barrier the test controls, then
   streams and returns.
2. Saturate the egress budget so the reservation blocks, as
   `tests/dispatch.rs:712` (`concurrent_handler_output_is_reserved_before_allocation`)
   already arranges.
3. Cancel the generation while the reservation is blocked.
4. Free the budget and release the barrier.
5. Assert the handler observes `StreamClosed` from `reserve`, and assert no frame
   for that correlation appears on the wire or on any successor generation.
6. The settled arm: settle the correlation from a racing `Cancel`, then release a
   `reserve` that was already blocked, and assert it returns `StreamClosed`
   because of `won`, not because of cancellation.

Existing coverage is adjacent but not on this property:
`tests/dispatch.rs:835` (`closing_a_route_settles_its_admitted_work`) closes a
route and checks the terminals; `tests/routing.rs:435`
(`closed_route_requests_are_unknown_and_cleanup_is_idempotent`) sends requests
*after* the close. Neither lets a handler complete after retirement and asserts
silence. Neither binary is in CI.

## Investigation log

### Q: Are there emission paths that bypass all four entry points?

- Sources examined: every `gen.writer.send_before` call in `dispatch.rs`:
  `:293-304` (inside `emit_frame_with_written`), `:351-362` (inside
  `emit_reserved_frame`), `:735-759` (`handle_host_shutdown`'s owner path),
  `:806-819` (`emit_authoritative_rejection`), `:1466-1480`
  (`send_connection_goodbye`).
- Findings: three direct `send_before` calls bypass the two wrapper functions.
  `handle_host_shutdown` compensates with its own check at `:713-715`
  (`if gen.writer.is_retired() || gen.token.is_cancelled() { return; }`).
  `emit_authoritative_rejection` relies on `charged_error_body`'s check at
  `:195-197`, which it calls first at `:794-795`. `send_connection_goodbye` has
  **no** check — it queues the `Goodbye` unconditionally and relies on
  `send_before` returning `Err` for a dead writer.
- Missing evidence: whether `send_before` on a retired writer reliably returns
  `Err(WriterGone)` rather than queueing. That is `frame_channel.rs`, Part 2b.
- Conclusion: resolved with answer for the four request-path entry points;
  `send_connection_goodbye` is a teardown frame, not a request terminal, and its
  behaviour is Part 2b's `WriterGone` contract. Recorded as a boundary note, not
  a gap in this property.

### Q: Can a charge outlive its generation and starve a successor?

- Sources examined: `ByteCharge` usage — `dispatch.rs:214-219` (charge moved into
  the `OutputBuffer`), `:326-350` (moved into the `OutboundFrame`),
  `ring_transport.rs:576` (`drop(charge)` after successful publication) and the
  early return at `:563-565`, which drops it by scope exit.
- Findings: the charge is dropped on both the success and failure publication
  paths, and if the frame never reaches the writer the `OutputBuffer` or
  `OutboundFrame` holding it is dropped instead. Part 2a holds
  `a-cancelled-emission-releases-every-permit-it-held`, which covers this from the
  generation side.
- Missing evidence: none.
- Conclusion: resolved with answer — charges do not survive their frame. Cited to
  Part 2a rather than re-cataloged.
