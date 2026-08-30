# req-a-a-response-publication-failure-never-reaches-the-settling-path

## Discovery trigger

The task asked directly: what happens to a request whose *response* fails to
publish? Is the request retried, is the effect already applied, and can the
client tell? Part 2b established the peer-visible half (a publish failure is
reported as a clean close). This record establishes the host-visible half.

## Evidence trail

There are two publication shapes, and one of them can fail for a reason the
handler introduced.

**Owned bodies.** `emit_reserved_frame` takes the `OutputParts::Owned` arm at
`dispatch.rs:327-331`, encodes eagerly with `encode_split_frame`, and queues a
frame whose bytes are already final. A failure here can only be a ring or
transport failure.

**Direct bodies.** `emit_reserved_frame` takes the `OutputParts::Direct` arm at
`dispatch.rs:332-349`, building a `DirectFrame` from `(header, body.len,
body.serializer)` at `:346`. The serializer is the handler's closure, supplied
through `RequestCtx::output_from_writer` (`handler.rs:471-477`) and
`StreamSink::reserve_direct` (`dispatch.rs:545-577`). It has **not run yet**.

The serializer runs inside the writer, at `ring_transport.rs:580-593`:

```
fn publish_direct(ring: &Ring, direct: DirectFrame, deadline: StdInstant) -> Result<(), ()> {
    let header = direct.header();
    let body_len = direct.body_len();
    let mut reservation = ring
        .reserve_until(body_len, header, deadline)
        .map_err(|_| ())?;
    let result = crate::panic_boundary::redact_sync(|| {
        let mut writer = ReservationWriter(&mut reservation);
        direct.serialize(&mut writer)
    });
    result.map_err(|_| ())?;
    reservation.commit(body_len).map_err(|_| ())?;
    Ok(())
}
```

`commit` enforces exact fill at
`crates/mc-shm-transport/src/backend/ring.rs:1363-1367`:

```
if self.cursor != body_len {
    self.ring.abort_reservation(self.sequence);
    self.finished = true;
    return Err(ProducerError::Underfill);
}
```

So a serializer that writes fewer bytes than the `exact_len` it declared fails
with `Underfill`; one that writes more fails earlier in
`ReservationWriter::write` (`ring_transport.rs:611-619`, mapping the overflow to
`WriteZero`). Either way `publish_direct` returns `Err`.

`publish_one` then returns `Err` at `ring_transport.rs:564-566`, before
`completion.store(COMPLETE)` at `:567`, before the publish hook, and before the
`written` hook at `:574-576`. The boxed `written` closure is dropped unrun.

Meanwhile the settling side has long since finished. `settle`'s unary-response
arm is `dispatch.rs:447-460`:

```
if emit_reserved_frame(..., body, gen.writer.admission_deadline()).await.is_err() {
    gen.token.cancel();
}
return true;
```

`emit_reserved_frame` returns `Ok` as soon as `send_before` admits the frame to
the queue (`dispatch.rs:351-363`). So `settle` returns `true`, `won` stays
`true`, and `remove_pending` runs at `dispatch.rs:1066`. No path re-enters
`settle` afterwards, because `won` is already set.

## Failure scenario

1. Handler computes an exact response length, calls
   `ctx.output_from_writer(exact_len, serializer)`, and returns
   `RequestOutcome::Response`.
2. `dispatch.rs:1031-1034` accepts it because `OutputBuffer::len()` returns the
   *declared* `exact_len` for a direct output (`handler.rs:362-366`), which is
   under `MAX_BODY_LEN`.
3. `settle` charges `exact_len + HEADER_LEN` bytes, queues the frame, returns
   `true`. The request is now settled and forgotten.
4. The writer runs the serializer. It writes `exact_len - 1` bytes, because the
   handler's length model and its writer disagree by one.
5. `commit` returns `Underfill`. `publish_one` returns `Err`.
6. Per Part 2b, the endpoint thread reports this as a clean peer close.
7. The client sees the connection close with no terminal for the correlation, and
   per Part 2d a clean host close and a transport failure share one code.

Effect accounting: the handler's side effect ran to completion. The host recorded
the request as settled. The client recorded `outcome_unknown` and, per protocol
§10.1, must not replay generically. So the effect is applied exactly once but
neither end can prove it, and every other in-flight request on the generation is
also lost to the close.

## Timing windows and dependencies

There is no window to hit; the two halves are unordered by construction. The
settling task may already have been dropped when the serializer runs, because
`spawn_tracked` (`runtime.rs:146-155`) does not keep the outer task alive past
its own return.

Dependency on the direct-output path: the `Owned` arm cannot fail for a
handler-introduced reason, because encoding happens synchronously inside
`emit_reserved_frame` and its failure is returned to `settle`, which cancels the
generation at `dispatch.rs:458`. So the interesting failure is specific to
`output_from_writer`. The generic ring-failure case reaches the same end state
for either shape.

## What a test must construct

1. A handler that calls `ctx.output_from_writer(N, |w| w.write_all(&[0u8; N-1]))`
   and returns `RequestOutcome::Response`.
2. Send one routed request. Assert the client observes **no** terminal for that
   correlation and observes the generation close.
3. Assert the close carries no reason distinguishing it from an orderly one.
4. Assert a second in-flight request on the same generation is also left
   unanswered, which is the blast-radius half.
5. Optionally exercise the over-write direction with `N+1` bytes to confirm
   `ReservationWriter` refuses rather than corrupting the arena.

No existing test in this sub-part does any of this. `tests/dispatch.rs:665`
(`oversized_handler_output_cannot_corrupt_framing`) covers a declared length
above the frame limit, which is caught early at `dispatch.rs:1035-1039` and
becomes a clean `internal_error`; it does not cover a length that passes the
check and then fails to fill.

## Investigation log

### Q: Does `commit` actually enforce exact fill, or does it trust `body_len`?

- Sources examined: `crates/mc-shm-transport/src/backend/ring.rs:1354-1382`.
- Findings: it checks `body_len > self.capacity()` (returning
  `CommitOutsideReservation`) and then `self.cursor != body_len` (returning
  `Underfill`), aborting the reservation in both cases. So an underfilled
  reservation is never published, and the arena is not exposed.
- Missing evidence: none.
- Conclusion: resolved with answer — exact fill is enforced, so the failure is a
  clean abort, not a data-exposure bug. The finding is about attribution, not
  memory safety.

### Q: Does any production handler use `output_from_writer` with a computed length?

- Sources examined: grep for `output_from_writer` across the workspace; the
  method is defined at `handler.rs:471` and backed by `reserve_direct` at
  `dispatch.rs:545`.
- Findings: the callers are in `mc-module`, which is Parts 4a through 4f, not
  this sub-part's scope. I did not audit them.
- Missing evidence: an `mc-module` inventory of `output_from_writer` call sites
  and whether each one's `exact_len` is derived from the same code path as its
  serializer.
- Conclusion: unresolved, needs an `mc-module` audit. Parts 4c and 4d already
  found handlers returning success without writing, so the risk is live.
