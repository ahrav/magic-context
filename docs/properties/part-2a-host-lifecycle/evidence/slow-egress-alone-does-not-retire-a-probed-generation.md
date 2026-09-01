# slow-egress-alone-does-not-retire-a-probed-generation

## Discovery trigger

Gap G3 named three missing claims, the third being "that a saturated application
stream cannot block the probe". Tracing what "block" could mean produced two
different mechanisms, one handled and one not, and the unhandled one bypasses a
documented safety valve. Part 2a also has zero `sometimes` records, which the
portfolio evaluation flagged as a repeat of a Part 1 criticism, so this record is
deliberately shaped as a situation-coverage marker.

## Evidence trail

**There is no host-side control lane.** `frame_channel.rs:758-767` defines
`FrameSender` with a single `tx: mpsc::Sender<QueuedOutboundFrame>`. Its
constructor `frame_sender` at `:856-872` creates that channel at `:862` with
capacity `queue_frames`. There is no second channel, no priority queue, and no
reserved slot. `connection.rs:178-186` passes
`shared.limits.writer_queue_frames`, default 64 (`config.rs:141`).

The client does reserve control capacity. `client.rs:954` describes a
`queue_budget` "so ordinary data traffic can never starve a Pong, Cancel" and
`client.rs:62` names "Reserved pure-header Pong, Cancel, and Goodbye slots". The
host has no equivalent, so a host Ping is an ordinary FIFO entry behind whatever
application frames are already queued.

**Mechanism one, handled: the deadline is anchored at completion.** The probe
insert at `connection.rs:1403-1411` records the enqueue instant with
`written_at: None`. The completion hook at `:1426-1447` overwrites `probe.sent`
with `completed_at` (`:1443`) and sets `written_at` (`:1444`). Both the deadline
wake (`:1358`) and the expiry scan (`:1372`) skip probes with `written_at` unset,
and the read loop parks a matching Pong instead of judging it (`:535`). The
comment at `:529-532` states the intent. So queueing delay does not expire a probe
and is not charged to the peer. This half of the guarantee holds.

**Mechanism two, not handled: Ping admission can retire the generation.** The send
is `connection.rs:1449-1455`:

```
let send = gen.writer.send(crate::frame_channel::OutboundFrame { ... });
```

`FrameSender::send` at `frame_channel.rs:779-781` calls
`self.send_before(frame, self.admission_deadline())`. `admission_deadline` at
`:783-785` is `Instant::now() + self.admission_timeout`. `connection.rs:178-186`
supplies `shared.timing.frame_deadline` in the `admission_timeout` position of
`TcpFrameChannel::start`, and `config.rs:224` defaults `frame_deadline` to 30
seconds.

The admission race is `frame_channel.rs:814-824`:

```
sent = timeout_at(deadline, self.tx.send(queued)) => match sent {
    Ok(sent) => sent.map(...).map_err(|_| WriterGone),
    Err(_) => {
        self.retired.cancel();
        self.generation.cancel();
        Err(WriterGone)
    }
},
```

So the timeout arm cancels the generation token from inside the sender.
`liveness_loop` then observes `sent.is_err()` at `:1461-1463` and returns, but the
retirement has already happened.

**This bypasses `invalidate_on_missed`.** `config.rs:236-238`:

> `invalidate_on_missed` stays `false` until the raw Rust historian client can
> answer Ping (`magic-context-c50.4`); enabling it before then would kill healthy
> long-running awaits (protocol §9.3).

The missed-Pong retirement at `connection.rs:1376-1379` is gated on that flag. The
admission retirement at `frame_channel.rs:820-821` is not gated on anything.

Reachability label evidence: `config.rs:296` defaults `liveness` to `None` and the
only in-crate `Some` is `config.rs:664` under `#[cfg(test)]`. Label
`explicit-config-only`.

## Failure scenario

An embedder configures `LivenessPolicy { ping_interval: 30s, pong_deadline: 10s,
invalidate_on_missed: false }`, reading the doc comment as "probing is
observational until the client can answer". A handler streams a large result to a
consumer that reads steadily but slower than the handler produces. The 64-slot
queue fills. No single dequeued write exceeds `frame_deadline`, because the peer
is reading, so the writer's own deadline never fires. A Ping tick arrives, the
Ping cannot be admitted, and 30 seconds later `frame_channel.rs:820-821` cancels
the generation. The consumer sees a transport reset mid-stream. Per the catalog's
`authentication-and-capacity-rejections-are-observable`, there is no channel to
report why.

Turning liveness off entirely avoids it. Turning the flag off does not.

## Timing windows and dependencies

The window needs a peer in a narrow band: fast enough that no individual write
exceeds `frame_deadline`, slow enough that all 64 slots stay occupied for a full
`frame_deadline`. A peer that stops reading entirely falls out of the band, and
the writer retires the generation on its own, which `config.rs:204-206` documents
as intended: "a peer that stops reading is retired rather than allowed to pin
shared egress budget indefinitely". So the uncovered case is specifically the slow
reader, not the stopped one.

Under paused time the 30 second window is free.

The second marker's window is much smaller: a Ping enqueued behind at least one
unwritten frame, with the peer's Pong arriving before the writer drains to the
Ping. Any nonzero queue occupancy plus a prompt peer reaches it.

## What a test must construct

Marker `probe_queued_behind_saturated_egress`. Assert these preconditions
jointly, and nothing else:

1. `shared.liveness` is `Some`.
2. `policy.invalidate_on_missed == false`.
3. The writer queue holds `writer_queue_frames` admitted frames.
4. A Ping tick is due, that is `Instant::now() >= next_ping_at`.

All four are legal states of a correct implementation, so the marker fires against
correct code. It does not assert that the generation survives, does not assert an
expiry, and does not observe a cancellation. That matters: pairing it with
`always(!retired)` would make it fireable only by observing the defect, which the
METHOD coverage rules forbid.

Marker `pong_parked_pending_write_completion`. Fires when the read loop reaches
`connection.rs:535`, that is a matching Pong with `probe.written_at.is_none()`.
Constructed by queueing several large frames, letting a Ping tick land behind
them, and having the peer answer immediately.

Both names are constants. Neither is built from a correlation id or a generation
id.

The separate safety assertion, which is not this record, is: with
`invalidate_on_missed: false` and a peer answering every Ping, `gen.token` is not
cancelled after the queue has been continuously full for `frame_deadline`. That
assertion currently fails.

## Investigation log

### Q: Is retiring on Ping admission timeout intended?

- Sources examined: `frame_channel.rs:779-785`, `:802-825`, `:856-872`;
  `connection.rs:178-186`, `:1449-1467`; `config.rs:199-231` (`HostTiming` and its
  defaults), `:234-245` (`LivenessPolicy`), `:236-238` (the flag's rationale);
  `client.rs:62`, `:954` (the client's reserved control slots).
- Findings: the admission timeout is a general `FrameSender` policy applied to
  every caller. The Ping is an ordinary caller and passes the default deadline
  through `send`, described at `:778` as the "legacy admission adapter for callers
  that do not need a ticket". Nothing in the liveness code, the config docs, or the
  timing docs mentions the interaction. The client's reserved control slots show
  the authors did consider control-frame starvation, on the other side of the
  connection.
- Missing evidence: no comment, commit message, or protocol reference ties the
  admission cancel to the liveness path. Whether protocol §9.3 addresses egress
  backpressure was not established.
- Conclusion: needs human input. The evidence supports "unnoticed interaction"
  over "deliberate design", but that is an inference about intent, and the METHOD
  rules forbid resolving it by fiat. If it is deliberate, the flag's doc comment
  overstates what the flag disables and should say so.

### Q: Should the host reserve a control slot as the client does?

- Sources examined: `client.rs:62`, `:954`; `frame_channel.rs:856-872`;
  `config.rs:110-160` (the limits and their pool accounting).
- Findings: the client's approach would remove the interaction rather than
  document it. But `config.rs:115-122` shows `writer_queue_frames` feeding the
  admission pool sizing, so adding a reserved slot changes the pool accounting the
  ingress budget depends on.
- Missing evidence: whether the ingress budget's invariants tolerate a reserved
  slot. Not traced in this pass.
- Conclusion: unresolved, needs a review of the admission-pool accounting in
  `config.rs:515-545` before proposing the change.
