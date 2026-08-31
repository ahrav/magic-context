# client-a-pong-egress-is-not-bounded-by-any-client-side-liveness-budget

## Discovery trigger

Tracing whether the client can starve its own probe obligation. `writer_loop`
awaits a completion that only the bridge thread can send, and the bridge thread has
a blocking call on the inbound path.

## Evidence trail

`writer_loop` is strictly one frame at a time:

```
1946:        let (completed_tx, completed_rx) = oneshot::channel();
1947:        if write
1948:            .try_send(RingWrite {
1949:                bytes: frame.bytes,
1950:                completed: completed_tx,
1951:            })
1952:            .is_err()
1953:        {
1954:            inner.retire("write_failed");
1955:            break;
1956:        }
1957:        let written = tokio::select! {
1958:            biased;
1959:            () = inner.cancel.cancelled() => break,
1960:            result = timeout_at(frame.deadline, completed_rx) => result,
1961:        };
1962:        if !matches!(written, Ok(Ok(Ok(())))) {
1963:            inner.retire("write_failed");
1964:            break;
1965:        }
```

It does not dequeue the next frame until `completed_rx` resolves or
`frame.deadline` expires. The only producer of that completion is the bridge
thread at `:1872`.

The bridge thread interleaves egress and ingress in one loop and can block on
ingress:

```
1880:                match endpoint.try_recv_with(|bytes| read_budget.charge(bytes)) {
1881:                    Ok(Some(frame)) => {
1882:                        if read_tx.blocking_send(frame).is_err() {
1883:                            break;
1884:                        }
1885:                    }
```

`read_tx` is the sender half of a channel created with capacity
`CLIENT_DATA_QUEUE_FRAMES`:

```
1850:    let (read_tx, read_rx) = mpsc::channel(CLIENT_DATA_QUEUE_FRAMES);
```

which is 256 (`:59`). `blocking_send` parks the OS thread when that channel is
full, and while parked the thread cannot reach `:1867` to service the next write,
and cannot send a completion for a write already handed to it.

So an inbound stall is also an egress stall, and the client's tolerance for it is
whatever `frame.deadline` says. For control frames that is set at construction:

```
1348:        let frame = QueuedFrame {
1349:            bytes,
1350:            charge,
1351:            publish: None,
1352:            ack,
1353:            deadline: Instant::now() + CLIENT_FRAME_TIMEOUT,
1354:        };
```

`CLIENT_FRAME_TIMEOUT` is 30 seconds (`:45`), matching
`docs/mc-host-wire-protocol.md:738`. So the client waits up to 30 seconds before
retiring with `write_failed` at `:1963`.

The per-write ring bound is separate and shorter, and it ignores the frame
deadline entirely:

```
ring_transport.rs:659:    pub fn send(&self, header: EnvelopeHeader, body: &[u8]) -> Result<(), RingClientError> {
ring_transport.rs:660:        let mut reservation = self
ring_transport.rs:661:            .to_host
ring_transport.rs:662:            .reserve_until(
ring_transport.rs:663:                body.len(),
ring_transport.rs:664:                header.encode(),
ring_transport.rs:665:                StdInstant::now() + Duration::from_secs(2),
ring_transport.rs:666:            )
```

Two seconds, hardcoded. That bounds a stall caused by a full outbound ring, but not
one caused by a parked `blocking_send`, because in that case `send` is never
entered.

Reserved control slots do not help. `writer_loop` prefers `control_rx`
(`:1923`, `:1929`), so a `Pong` is picked up ahead of queued data, but "picked up"
still means waiting on the previous frame's completion at `:1957`. The 32 reserved
slots (`:61`) protect against admission refusal, not against egress latency, which
is why `data_saturation_never_starves_a_control_frame` (`:3225`) does not cover
this.

## Failure scenario

The application stops draining a stream, or `ring_reader_loop` is descheduled under
load. Inbound frames accumulate until the 256-slot channel fills. The bridge thread
parks in `blocking_send`.

A host `Ping` cannot even arrive at this point, because the inbound path is the
blocked one. But a `Pong` for a `Ping` that arrived just before the stall, or any
`Cancel` or `Goodbye`, sits in `control_rx` behind a data frame whose completion
will not arrive. After 30 seconds `writer_loop` retires with `write_failed`.

If the host's probe deadline is shorter than 30 seconds, the host retires first and
the operator sees a liveness failure. The actual condition was consumer
backpressure, which is a capacity problem with a completely different remedy.

## Timing windows and dependencies

The bound is one frame deadline: 30 seconds for controls, the caller's request
deadline for data frames, since `encode_data_frame` passes the request deadline
through at `:2117`. A caller may set a long timeout via `RequestOptions.timeout`
(`:275`), and `request_deadline` (`:1996-2004`) accepts anything representable, so
a data frame's deadline can far exceed 30 seconds. That extends the same stall.

This is the client-side mirror of Part 2b's
`ring-a-ingress-wait-holds-a-lease-while-servicing-egress`, which found the same
coupling on the host's endpoint thread. The shared cause is one thread owning both
directions of a ring.

Composes with `client-a-a-dropped-pong-is-never-observable-to-the-client`: that
record covers a `Pong` never accepted for transmission, this one covers a `Pong`
accepted and stalled.

## What a test must construct

Per METHOD's liveness rule this needs a bounded fault-free window, not an unbounded
eventually, and the bound must be stated in the unit the code bounds, which is one
frame deadline:

1. Stall `ring_reader_loop` so it stops calling `read.recv()`. Push 257 inbound
   frames so the channel fills and the bridge parks at `:1882`.
2. Enqueue a control frame through `send_control` and record the time.
3. Release the stall.
4. Poll until the control frame's write completes, with an explicit bound of one
   `CLIENT_FRAME_TIMEOUT`. Assert completion inside the bound, and assert
   `retired == false`, which distinguishes recovery from the client giving up.
5. Separately assert the negative direction: with the stall held past the deadline,
   assert `retire("write_failed")` fired, which pins the tolerance at 30 seconds
   rather than at infinity.

This needs the real bridge thread, so it is an integration test rather than a
`test_inner` unit test. `writer_loop` is directly constructible in the unit
harness, as `:2495` shows, but the blocking-send coupling only exists with the real
thread.

## Investigation log

### Q: What is the host's probe interval and deadline?

- Sources examined: `docs/mc-host-wire-protocol.md:736-743` (the client-side budget
  table, which lists no probe interval), `:261-262` (Ping and Pong required), the
  reference to "liveness policy (Section 9.3)" at `:294`.
- Findings: the client's own budget table does not name a probe interval, and the
  liveness policy lives in a section this lens did not read because Part 2a owns
  the host's probe.
- Missing evidence: the host's interval and deadline. Part 2a's
  `a-timely-pong-sustains-the-generation-within-a-bounded-round` should carry them.
- Conclusion: unresolved, needs the 2a figure. If the host's deadline exceeds 30
  seconds the client always retires first and the misattribution does not occur; if
  it is shorter, it always does.

### Q: Could `writer_loop` overlap writes to avoid the coupling?

- Sources examined: `writer_loop:1916-1974`, `RingWrite` (`:1834-1837`), the
  `sync_channel` at `:1849` with capacity 256.
- Findings: the write channel already has 256 slots, so the writer could hand over
  several frames before awaiting. It does not, because it needs the completion to
  set `WRITTEN` at `:1967` before the caller's `classify` can report
  `OutcomeUnknown` accurately, and to release `frame.charge` at `:1972`. So the
  serialization is load-bearing for the send-outcome classification that
  `client-a-every-in-flight-request-is-settled-with-a-classified-send-outcome`
  depends on.
- Missing evidence: none.
- Conclusion: resolved with answer. The coupling is not gratuitous. A fix would have
  to separate the ingress delivery from the egress completion path, for example by
  making the inbound hand-off non-blocking with an explicit overflow policy, rather
  than by pipelining writes.
