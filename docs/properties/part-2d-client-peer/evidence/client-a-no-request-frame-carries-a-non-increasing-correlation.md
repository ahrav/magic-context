# client-a-no-request-frame-carries-a-non-increasing-correlation

## Discovery trigger

The task asked directly: "Establish what the client does when the host closes
silently, and whether the client can violate the watermark." Part 2a cataloged the
host's enforcement as `request-correlation-strictly-increases-per-generation`. This
is the peer-side obligation that satisfies it.

## Evidence trail

The contract, at `docs/mc-host-wire-protocol.md:656`:

> The host therefore enforces the monotonic allocation rule on ingress with a
> per-generation watermark: it MUST track the highest consumer `Request`
> correlation seen on the generation and treat any consumer `Request` (control or
> routed) whose correlation is not strictly greater than that watermark as a
> protocol violation that closes the generation before any dispatch. [...] it also
> obligates the sender to write `Request` frames in allocation order.

Two obligations, then: no reuse, and write in allocation order. Conformance vector
V44 at `:882` states the penalty.

One allocator serves both control and routed requests. `Inner.correlations`
(`client.rs:940`) is initialised once at `:393` with
`Correlations::new(FIRST_APPLICATION_CORRELATION)`, and
`FIRST_APPLICATION_CORRELATION` is `1` (`:111`). `open_route` (`:461`),
`host_shutdown` (`:588`), and `host_status` (`:638`) all reach it through `unary`
on identity `0/0`, and `request` (`:540`) reaches it on a routed identity. There is
no second allocator.

Allocation is monotone and saturating:

```
1735:    fn allocate(&mut self) -> Option<u64> {
1736:        let current = self.next?;
1737:        self.next = current.checked_add(1);
1738:        Some(current)
1739:    }
```

`checked_add` means the allocator stops rather than wrapping, so `u64::MAX` is
issued once and then `next` is `None`.

**Allocation order equals enqueue order.** In `admit` the `correlations` guard is
taken at `:1176` and is still alive at the end of the function:

```
1176:        let mut correlations = lock_unpoisoned(&self.correlations);
1177:        let corr = correlations.allocate().ok_or_else(|| { ... })?;
1184:        let key = PendingKey::new(route, corr);
1185:        let publish = Arc::new(AtomicU8::new(QUEUED));
1186:        let frame = match encode_data_frame( ... ) {
1194:            Ok(frame) => frame,
1195:            Err(error) => {
1196:                correlations.restore(corr);
1197:                return Err(error);
1198:            }
1199:        };
1200:        pending.insert( ... );
1207:        if self.data_tx.try_send(frame).is_err() {
1208:            pending.remove(&key);
1209:            correlations.restore(corr);
```

The `admission` mutex (`:1140`) and the `pending` mutex (`:1141`) are also held
across the same span. So no two admits can interleave allocation and enqueue, and
the order frames enter `data_tx` is the order correlations were issued.

`writer_loop` preserves that order for data frames: it drains `data_rx` in FIFO
order (`:1931`, `:1933`) and only preempts it with `control_rx` (`:1923`,
`:1929`), whose frames are `Cancel`, `Pong`, and `Goodbye`, all explicitly exempt
by `:656`. A frame whose publish state is no longer `QUEUED` is skipped with
`continue` at `:1944`, and skipping a correlation cannot violate a
strictly-greater rule.

**`restore` cannot rewind past a sent frame.** Its guard:

```
1741:    fn restore(&mut self, correlation: u64) {
1742:        if self.next == correlation.checked_add(1)
1743:            || (correlation == u64::MAX && self.next.is_none())
1744:        {
1745:            self.next = Some(correlation);
1746:        }
1747:    }
```

The first disjunct restores only the most recently issued value. The second
handles the exhaustion case. Its two call sites are `:1196`, before any frame
exists, and `:1209`, after `try_send` failed. `mpsc::Sender::try_send` returns the
value inside `TrySendError` on both `Full` and `Closed`, so a failed `try_send`
delivers nothing to the channel. Neither site can follow a delivery.

## Failure scenario

The property holding means the host never closes the generation on this client for
V44. A violation would require one of: releasing the `correlations` guard between
`:1177` and `:1207`, so two admits could enqueue out of order; or a `restore` after
a successful `try_send`; or a second allocator for control requests, so a control
`Request` could carry a value a routed `Request` already used. None exists.

The consequence of a violation is severe and immediate: the host closes the
generation before dispatch, taking every unrelated route with it, and the client
learns only through a `retire` whose cause it discards.

## Timing windows and dependencies

The two windows that would matter are both closed by lock scope rather than by
ordering luck, which is why confidence is high. The `admission` mutex is the same
one `settle_all` (`:1651`) and `settle_route` (`:1625`) take, so a concurrent
retirement cannot interleave with an allocation either.

Note the interaction with `client-a-correlation-exhaustion-does-not-retire-the-generation`:
the allocator stopping is what preserves this property at the top of the range, but
the client's response to stopping violates a different clause of the same doc
paragraph.

Related but distinct: the host's ping correlations share the numeric space but not
the namespace. `docs/mc-host-wire-protocol.md:654` states the two directions are
independent, and Part 2a's `ping-and-consumer-correlations-cannot-cross-settle`
covers the host side. On the client side a host `Ping` never touches `pending`
because `dispatch` routes it by frame type at `:1388` before any key lookup, so a
`Ping` with `corr == 5` cannot settle the client's own request 5.

## What a test must construct

1. Drive concurrent `request`, `request_stream`, `open_route`, `host_status`, and
   `host_shutdown` callers against one `Inner`.
2. Interleave both `restore` paths: oversize bodies to fail `encode_data_frame`
   (`:2092-2104` returns `body_too_large`), and a saturated `data_tx` to fail
   `try_send`.
3. Record the correlation of every frame as `writer_loop` completes it, by draining
   the sender side in the fixture and decoding the header.
4. Assert the recorded sequence is strictly increasing. Assert separately that no
   two frames carry the same correlation, which is the weaker no-reuse clause and
   would catch a `restore` bug the ordering check might miss if the reused value
   happened to be emitted later.
5. Add the `u64::MAX` boundary using the pattern from
   `max_correlation_is_used_once_then_exhausted` (`:2328`).

## Investigation log

### Q: Does `restore` violate the doc's no-reuse clause on a literal reading?

- Sources examined: `docs/mc-host-wire-protocol.md:654` ("A correlation MUST NOT be
  reused, even after terminal completion"), `client.rs:1741-1747`, `:1196`,
  `:1209`, and the `try_send` contract.
- Findings: the doc's sentence is bracketed by "even after terminal completion",
  which presupposes the correlation was on the wire. A value that was allocated and
  rewound before any frame was delivered was never used in the sense the paragraph
  means, and the host's watermark, which is the enforcement mechanism the same
  paragraph describes, only observes frames. So there is no observable violation.
- Missing evidence: none.
- Conclusion: resolved with answer. Not a violation, but worth recording as a
  checked-and-clear near-miss, which the lens file does.

### Q: Could `data_tx` reorder frames relative to allocation?

- Sources examined: `mpsc::channel` construction at `:385`, `writer_loop`
  (`:1916-1974`).
- Findings: `tokio::sync::mpsc` is FIFO per channel, and there is exactly one
  `data_tx` clone reaching one `data_rx`. The `select!` at `:1926` can choose
  `control_rx` first, but control frames are exempt. Within `data_rx` the order is
  the send order.
- Missing evidence: none.
- Conclusion: resolved with answer. No reordering of `Request` frames is possible.
