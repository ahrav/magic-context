# ring-a-publish-failure-is-reported-as-a-clean-peer-close

## Discovery trigger

Mapping the outbound failure path in `run_endpoint` for the frame-lifecycle map.
The inbound failure path sends an explicit `ReadClose` before returning
(`crates/mc-host/src/ring_transport.rs:406-411`). The outbound failure path does
not (`:479-484`). Tracing what the connection engine then observes produced the
finding.

## Evidence trail

**The outbound failure path, in full.** `run_endpoint:479-484`:

```
if publish_one(&rings.first, queued, frame_deadline, publish_hook.as_ref()).is_err() {
    queue.retired.cancel();
    root.cancel();
    return;
}
```

Nothing is sent on `inbound`. Compare the inbound path at `:406-411`, which does
`inbound_sender.send(Err(close)).await` before the same two cancels and the same
`return`.

**What the connection engine sees.** `run_endpoint` owns
`inbound: Option<mpsc::Sender<Result<InboundEvent, ReadClose>>>` (`:382`).
Returning drops it, closing the channel. `ShmReceiver::recv`
(`:350-355`) is:

```
self.inbound.recv().await.unwrap_or(Err(ReadClose::CleanEof))
```

So a closed channel becomes `Err(ReadClose::CleanEof)` at `:354`. That is the
only `CleanEof` producer in the crate.

`connection.rs:401-404` maps it:

```
Err(ReadClose::CleanEof)
| Err(ReadClose::Corrupt(_))
| Err(ReadClose::Io(_))
| Err(ReadClose::Overloaded) => return ReadExit::Peer,
```

`ReadExit::Peer` takes the silent-retirement arm at `connection.rs:315-318`:
`gen.token.cancel()` then `gen.writer.discard()`. The comment at
`connection.rs:309-314` states the intent — "a client that sent a corrupt frame
never receives terminals or a Goodbye after the close decision (protocol §6.3)".
That is correct handling for a peer-caused close. It is applied here to a
host-caused one.

**Cause erasure inside `publish_one`.** `publish_one` returns
`Result<(), ()>` (`:560-565`). Four distinct causes collapse into that unit:

1. `reserve_until` deadline expiry — `:607-609` and `:623-625`, mapping
   `ProducerError::Deadline` (`ring.rs:1880`) to `()`.
2. Wire-header/length disagreement — `commit_reservation` rejects it at
   `ring.rs:1585-1593` with `ProducerError::WireHeaderMismatch`, mapped to `()`
   at `:615` and `:628`.
3. A panic in the direct serializer — caught by the inner `catch_unwind` at
   `:584-587` and turned into `Err(())` by the `!matches!(result, Ok(Ok(())))`
   test at `:588-590`.
4. `ReservationWriter` exhaustion — `:635-643` produces
   `io::ErrorKind::WriteZero`, which `publish_direct` maps to `()` at `:614`.

The erasure happens at `:588-590`, before `run_endpoint` ever sees it.

**The asymmetry.** The same publish failure raised from inside the
ingress-budget wait *does* get a distinguishable cause:

```
// ring_transport.rs:533-540
Ok(queued) => {
    if publish_one(&rings.first, queued, frame_deadline, publish_hook).is_err() {
        return Err(ReadClose::Corrupt("shared-memory publish failed"));
    }
}
```

That `Err` propagates out of `receive_one` into `run_endpoint`'s `Err(close)`
arm at `:406-407`, which sends it. So whether a publish failure is reported as
`Corrupt` or as `CleanEof` depends only on which loop happened to be driving the
publication at the time.

## Failure scenario

A peer attaches and then stops receiving. The host-to-peer ring fills to its
eight-descriptor depth. The next `publish_one` calls
`reserve_until(body_len, header, deadline)` (`:583`, `:608`), which
blocks until the deadline and returns `ProducerError::Deadline`. `publish_one`
returns `Err(())`. `run_endpoint` cancels and returns. The connection engine
reads `CleanEof`, classifies `ReadExit::Peer`, retires silently, and discards
the queued frames.

Consequences:

- Every pending correlation becomes `outcome_unknown` at the close, with no
  terminal and no recorded reason. `docs/mc-host-wire-protocol.md:298` says
  "Once publication begins, a missing terminal leaves the request outcome
  unknown", which is satisfied, but the host has no record of *why*.
- Diagnostics records nothing. `peer_deaths` is incremented only from
  `connection.rs:185`, on an unexpected setup-socket close, which did not happen
  here. `exhaustions` is incremented only in `prepare` (`:224`). So
  `diagnostics()` shows `state: "healthy"` with all four counters unchanged
  (`ring_transport.rs:180-195`; post-#131 the `attachment` counter is removed,
  leaving four).
- An operator investigating sees a client disconnect. The host caused it.

The wire-header-mismatch cause is the sharper version: it means the host encoded
a frame whose header disagrees with its body, a host-side encoder defect, and it
is reported as the peer going away.

## Timing windows and dependencies

No interleaving is required; the misreport is the straight-line behaviour of the
`:479-484` path.

There is one ordering subtlety worth stating. `run_endpoint` cancels
`queue.retired` and `root` *before* returning, so the `FrameSender` is retired
(`frame_channel.rs:755-757`) and the generation token is cancelled before the
engine reads `CleanEof`. So the engine's `ReadExit::Peer` arm finds
`gen.token` already cancelled. That does not change the classification — the
`ReadExit::HostCancelled if !gen.token.is_cancelled()` guard at
`connection.rs:298` is not reached because the cause was `CleanEof`, not
`Cancelled` — but it does mean a host that wanted to distinguish the two cases
already has the signal available in `gen.token`.

Dependencies: Part 2a's
`close-disposition-is-a-total-function-of-the-read-exit-cause` is the property
this one feeds. That record establishes that disposition follows cause
deterministically; this one establishes that the cause is wrong.

## What a test must construct

Cheapest construction, using the existing harness shape:

1. Use `RingFactory::connect` (`frame_channel/contract_tests.rs:498-521`) or an
   equivalent, which builds a real `RingTransport`, calls the production
   `prepare`, and attaches a real `RingClientEndpoint`.
2. Do not call `recv` on the peer. Publish host-to-peer frames until the ring's
   eight descriptor slots (profile-pinned; asserted at `ring_transport.rs:903`)
   are full.
3. Send one more frame with a short `write_deadline` (`ContractConfig` carries
   it, `:505`), so `reserve_until` expires quickly.
4. Assert the cause the receiver observes. Today it is `CleanEof`; the property
   requires anything else.

A second, cleaner construction for the wire-header cause: admit an
`OutboundFrame` whose `bytes[0..4]` declares a length that disagrees with
`bytes.len() - HEADER_LEN + tail.len()`. `publish_owned` computes `body_len`
from the actual bytes (`:621-622`) and passes the header through untouched, so
`commit_reservation` rejects it at `ring.rs:1585-1593`. This needs a test-only
constructor for a malformed `OutboundFrame`, since the production encoders in
`wire.rs` presumably keep the two consistent.

No existing check covers either. `connection.rs:401-404` is the consuming match,
not a check.

## Investigation log

### Q: Should `publish_one` carry a cause enum rather than `()`?

- Sources examined: `ring_transport.rs:560-602` (`publish_one`), `:604-630`
  (the two publish helpers and their `map_err(|_| ())` sites),
  `:588-590` (the erasure), `frame_channel.rs:33-48` (the `ReadClose` taxonomy,
  which already has six variants including two with no producer).
- Findings: the information exists at every one of the four sites and is thrown
  away at a single point, `:564-566`. The receiving taxonomy already has the
  shape to carry it: `ReadClose::Corrupt(&'static str)` takes a static string,
  and `:536` already uses exactly that for the charge-wait variant of the same
  failure. So the change is small: give `publish_one` a
  `Result<(), &'static str>` and have `:479-484` send
  `Err(ReadClose::Corrupt(reason))` before returning.
- Missing evidence: whether sending on `inbound` at that point can itself fail,
  which would need a fallback. Looking at `:406-407`, the inbound path already
  does `let _ = inbound_sender.send(Err(close)).await`, discarding the send
  result, so the pattern is established.
- Conclusion: resolved with answer. The change is mechanical and the receiving
  side already handles it. Whether to make it is a fix decision, out of scope
  for this catalog.

### Q: Is the asymmetry between `:535-537` and `:479-484` for the identical fault deliberate?

- Sources examined: both sites; the polling-era comment that explained why the
  budget wait serviced outbound frames (removed by PR #131; the surviving
  intent statement is the alternation comment at `:416-420`).
- Findings: both comments explain the *scheduling* rationale and neither
  mentions error reporting. `:535-537` returning `Corrupt` looks like a
  consequence of being inside a function that already returns
  `Result<bool, ReadClose>` — the ergonomic path — rather than a deliberate
  classification choice. `:479-484` is in a function returning `()`, where
  sending the close requires an extra `.await`, and the code takes the shorter
  route.
- Missing evidence: intent. No comment addresses it.
- Conclusion: needs human input, but the evidence leans strongly toward
  accident: the two sites differ exactly where the enclosing function's return
  type differs, which is the signature of an ergonomic default rather than a
  decision.
